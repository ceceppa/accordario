// Batch analysis queue.
//
// The server does the work (parallel downloads, one analysis at a time); this
// module remembers which songs were queued (in localStorage, so it survives a
// reload), follows their progress and hands finished analyses to the app.
// Re-submitting a song is safe: the server returns the cached result or the
// job already running for it.

import * as api from "./api.js";

const STORAGE_KEY = "accordario:queue:v1";
const POLL_MS = 1500;

export class AnalysisQueue extends EventTarget {
  constructor() {
    super();
    this.items = this.load();
    this.timer = null;
    this.running = false;
  }

  load() {
    try {
      const items = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return Array.isArray(items) ? items : [];
    } catch {
      return [];
    }
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.items));
    } catch {
      /* ignore */
    }
    this.dispatchEvent(new Event("change"));
  }

  has(videoId) {
    return this.items.some((i) => i.videoId === videoId);
  }

  get pending() {
    return this.items.filter((i) => i.status !== "error").length;
  }

  /**
   * Queue songs. `stage` is "analysis" for new songs, or "stems" for songs
   * already analyzed that only need their tracks separated.
   */
  add(videos, { stems = false, stage = "analysis" } = {}) {
    let added = 0;
    for (const { videoId, title } of videos) {
      if (this.has(videoId)) continue;
      this.items.push({
        videoId,
        title: title || null,
        stems,
        stage,
        status: "pending",
        progress: 0,
        message: "In coda…",
        jobId: null,
        error: null,
      });
      added++;
    }
    if (added) {
      this.save();
      this.kick();
    }
    return added;
  }

  remove(videoId) {
    const item = this.items.find((i) => i.videoId === videoId);
    if (!item) return;
    if (item.jobId && item.status !== "error") api.cancelJob(item.jobId).catch(() => {});
    this.items = this.items.filter((i) => i !== item);
    this.save();
  }

  retry(videoId) {
    const item = this.items.find((i) => i.videoId === videoId);
    if (!item) return;
    Object.assign(item, { status: "pending", error: null, jobId: null, progress: 0, message: "In coda…" });
    this.save();
    this.kick();
  }

  clearErrors() {
    this.items = this.items.filter((i) => i.status !== "error");
    this.save();
  }

  /** Start polling (no-op if already running). */
  kick() {
    if (this.running || this.timer) return;
    this.timer = setTimeout(() => this.tick(), 0);
  }

  async tick() {
    this.timer = null;
    const active = this.items.filter((i) => i.status !== "error");
    if (!active.length) return;
    this.running = true;
    try {
      let jobs;
      try {
        jobs = new Map((await api.listJobs()).map((j) => [j.id, j]));
      } catch {
        return; // server down: try again later
      }
      for (const item of active) {
        if (!this.items.includes(item)) continue; // removed meanwhile
        try {
          if (item.stage === "analysis") await this.stepAnalysis(item, jobs);
          else await this.stepStems(item, jobs);
        } catch (err) {
          item.status = "error";
          item.error = err.message;
        }
      }
      this.save();
    } finally {
      this.running = false;
      if (this.items.some((i) => i.status !== "error")) {
        this.timer = setTimeout(() => this.tick(), POLL_MS);
      }
    }
  }

  async stepAnalysis(item, jobs) {
    const job = item.jobId ? jobs.get(item.jobId) : null;
    if (!job || job.status === "cancelled") {
      // Not submitted yet, or the server restarted: (re)submit.
      const res = await api.startAnalysis(item.videoId, false, { batch: true, stems: item.stems });
      if (res.result) return this.finishAnalysis(item, res.result, { instant: true });
      item.jobId = res.jobId;
      item.status = "queued";
      return;
    }
    item.title = job.title || item.title;
    item.status = job.status;
    item.message = job.message;
    item.progress = job.progress;
    if (job.status === "done") {
      await this.finishAnalysis(item, await api.getSong(item.videoId));
    } else if (job.status === "error") {
      item.error = job.error;
    }
  }

  /** `instant`: the server already had it, no work was queued. */
  finishAnalysis(item, analysis, { instant = false } = {}) {
    item.title = analysis.title;
    this.dispatchEvent(new CustomEvent("analysis-done", { detail: { analysis, instant } }));
    if (item.stems) {
      Object.assign(item, { stage: "stems", status: "queued", jobId: null, progress: 0, message: "In coda per la separazione…" });
    } else {
      this.items = this.items.filter((i) => i !== item);
    }
  }

  async stepStems(item, jobs) {
    const job = item.jobId ? jobs.get(item.jobId) : null;
    if (job && (job.status === "queued" || job.status === "running")) {
      item.status = job.status;
      item.progress = job.progress;
      item.message = job.status === "queued" ? "In coda per la separazione…" : job.message;
      return;
    }
    if (job && job.status === "error") {
      item.status = "error";
      item.error = `Separazione: ${job.error}`;
      return;
    }
    const state = await api.getStems(item.videoId);
    if (state.available) {
      this.items = this.items.filter((i) => i !== item);
      this.dispatchEvent(new CustomEvent("stems-done", { detail: { videoId: item.videoId, title: item.title } }));
    } else if (state.jobId) {
      item.jobId = state.jobId;
    } else {
      const res = await api.startStems(item.videoId);
      if (res.status === "done") {
        this.items = this.items.filter((i) => i !== item);
        this.dispatchEvent(new CustomEvent("stems-done", { detail: { videoId: item.videoId, title: item.title } }));
      } else {
        item.jobId = res.jobId;
      }
    }
  }
}
