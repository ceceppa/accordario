// Small client for the local server API.

async function request(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Server non raggiungibile: avvialo con ./start.sh");
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) throw new Error(data?.detail || `Errore del server (${res.status})`);
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll a job until it finishes. Calls onProgress(job) on every update. */
export async function waitForJob(jobId, onProgress, isCancelled = () => false) {
  for (;;) {
    if (isCancelled()) throw new Error("cancelled");
    const job = await request("GET", `/api/jobs/${jobId}`);
    onProgress?.(job);
    if (job.status === "done") return job.result;
    if (job.status === "error") throw new Error(job.error || "Analisi non riuscita");
    await sleep(700);
  }
}

/** Start (or join) an analysis. `batch` jobs wait behind songs you open. */
export function startAnalysis(url, force = false, { batch = false, stems = false } = {}) {
  return request("POST", "/api/analyze", { url, force, batch, stems });
}

export function listJobs() {
  return request("GET", "/api/jobs");
}

export function cancelJob(jobId) {
  return request("DELETE", `/api/jobs/${jobId}`);
}

export function getSong(videoId) {
  return request("GET", `/api/songs/${videoId}`);
}

/** Turn pasted text (links, playlists) into [{videoId, title}]. */
export function resolveLinks(text) {
  return request("POST", "/api/resolve", { text });
}

export function deleteServerSong(videoId) {
  return request("DELETE", `/api/songs/${videoId}`);
}

export function getStems(videoId) {
  return request("GET", `/api/songs/${videoId}/stems`);
}

export function startStems(videoId) {
  return request("POST", `/api/songs/${videoId}/stems`);
}

export function health() {
  return request("GET", "/api/health");
}

/** Quick local count of links in pasted text (for previews). */
export function countLinks(text) {
  const spaced = (text || "").replace(/(\S)(https?:\/\/)/g, "$1 $2");
  let videos = 0, playlists = 0;
  for (const token of spaced.split(/[\s,;]+/)) {
    if (!token) continue;
    if (parseVideoId(token)) videos++;
    else if (/[?&]list=[A-Za-z0-9_-]{10,}/.test(token)) playlists++;
  }
  return { videos, playlists };
}

export function parseVideoId(text) {
  const t = (text || "").trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(t)) return t;
  const patterns = [/(?:v=|vi=)([A-Za-z0-9_-]{11})/, /youtu\.be\/([A-Za-z0-9_-]{11})/, /\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) return m[1];
  }
  return null;
}
