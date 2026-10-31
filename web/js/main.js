import * as api from "./api.js";
import { lang, languages, locale, setLang, t, tn, translatePage } from "./i18n.js";
import {
  chordId, chordTones, chordToLabel, diatonicChords, formatChord, formatKey, keyUsesFlats, noteName,
  parseChord, parseKey, transposeChord,
} from "./chords.js";
import { guitarDiagram, pianoDiagram } from "./diagrams.js";
import { ChordGrid } from "./grid.js";
import * as lib from "./library.js";
import { AnalysisQueue } from "./queue.js";
import { Transport } from "./transport.js";

const $ = (id) => document.getElementById(id);

const STEM_LABELS = {
  vocals: [t("Voce"), ""],
  drums: [t("Batteria"), ""],
  bass: [t("Basso"), ""],
  guitar: [t("Chitarra"), ""],
  piano: [t("Piano"), ""],
  other: [t("Altro"), t("synth, organo, archi…")],
};
const STEM_PRESETS = {
  all: {},
  keys: { solo: ["piano", "other"] },
  nokeys: { mute: ["piano", "other"] },
  novocals: { mute: ["vocals"] },
};
const HIGHLIGHT_LOOKAHEAD = 0.05; // seconds: light the beat a hair early
const SEEK_PREROLL = 0.05; // seconds before a beat when jumping to it

const state = {
  videoId: null,
  entry: null,
  analysis: null,
  barOf: [],
  shift: 0,
  shownKey: null,
  fmt: { flats: false, solfege: false },
  chords: [],
  ids: [],
  names: [],
  current: null,
  nowDiagramId: null,
  selection: null,
  loopOn: false,
  analyzeToken: 0,
  videoBlocked: false,
  editing: null,
  seeking: false,
  stems: { token: 0, info: null, mix: {} },
  prefs: { instrument: "guitar", notation: "letters", libraryOpen: true, ...lib.loadPrefs() },
};

const transport = new Transport("yt-player");
const queue = new AnalysisQueue();
const grid = new ChordGrid($("grid"), {
  onSeek: seekToBeat,
  onSelect: selectRange,
  onEdit: openEditor,
});

// ---------------------------------------------------------------- helpers

let toastTimer = null;
function toast(message, ms = 3500) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function relTime(ts) {
  if (!ts) return "";
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days <= 0) return t("oggi");
  if (days === 1) return t("ieri");
  if (days < 30) return t("{n} giorni fa", { n: days });
  return new Date(ts).toLocaleDateString(locale);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const isOverlayLibrary = () => matchMedia("(max-width: 1280px)").matches;

function saveSettings(patch) {
  if (!state.entry) return;
  Object.assign(state.entry.settings, patch);
  lib.updateSong(state.entry.videoId, { settings: state.entry.settings });
}

function beatEnd(i) {
  const beats = state.analysis.beats;
  if (i + 1 < beats.length) return beats[i + 1];
  const ibi = 60 / (state.analysis.bpm || 120);
  return beats[i] + ibi;
}

function beatIndexAt(t) {
  const beats = state.analysis?.beats;
  if (!beats?.length) return -1;
  const target = t + HIGHLIGHT_LOOKAHEAD;
  if (target < beats[0]) return -1;
  let lo = 0, hi = beats.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (beats[mid] <= target) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// ---------------------------------------------------------------- library

function renderLibrary() {
  const all = lib.listSongs().length;
  const songs = lib.searchSongs($("lib-search").value, $("lib-sort").value);
  $("lib-count").textContent = all ? tn(all, "{n} brano", "{n} brani") : "";
  $("lib-usage").textContent = all ? t("{n} KB usati", { n: lib.storageUsageKB() }) : "";
  const list = $("lib-list");
  if (!songs.length) {
    list.innerHTML = `<li class="lib-empty">${all ? t("Nessun brano trovato.") : t("Ancora nessun brano.<br>Incolla un link YouTube per iniziare.")}</li>`;
    return;
  }
  const solfege = state.prefs.notation === "solfege";
  list.innerHTML = songs.map((s) => {
    const key = parseKey(s.analysis?.key);
    const keyText = key ? formatKey(key, { flats: keyUsesFlats(key), solfege }) : "";
    const sub = [s.channel, keyText, relTime(s.openedAt ?? s.addedAt)].filter(Boolean).join(" · ");
    const badge = s.openedAt == null ? `<span class="new">${t("nuovo")}</span>` : "";
    return `<li class="lib-item${s.videoId === state.videoId ? " active" : ""}" data-id="${s.videoId}">
      <img loading="lazy" alt="" src="https://i.ytimg.com/vi/${s.videoId}/mqdefault.jpg">
      <div><div class="t">${escapeHtml(s.title)}</div><div class="s">${badge}${escapeHtml(sub)}</div></div>
      <button class="icon-btn del" title="${t("Elimina dalla libreria")}" aria-label="${t("Elimina")}">
        <svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>
      </button>
    </li>`;
  }).join("");
}

function setLibraryOpen(open) {
  state.prefs.libraryOpen = open;
  document.body.classList.toggle("library-closed", !open);
  $("library-scrim").hidden = !(open && isOverlayLibrary());
  if (!isOverlayLibrary()) lib.savePrefs(state.prefs);
}

function deleteFromLibrary(videoId) {
  const song = lib.getSong(videoId);
  if (!song || !confirm(t("Eliminare \"{title}\" dalla libreria?\nVerranno cancellati anche l'audio e le tracce separate salvati sul server.", { title: song.title }))) return;
  lib.deleteSong(videoId);
  api.deleteServerSong(videoId).catch(() => {});
  if (videoId === state.videoId) location.hash = "";
  renderLibrary();
  toast(t("Brano eliminato"));
}

// ---------------------------------------------------------------- song loading

function showHome() {
  state.analyzeToken++;
  transport.pause();
  state.videoId = null;
  state.entry = null;
  state.analysis = null;
  $("song-view").hidden = true;
  $("empty-state").hidden = false;
  document.title = "Accordario";
  renderLibrary();
}

async function openVideo(videoId, { force = false } = {}) {
  const token = ++state.analyzeToken;
  closeEditor();
  if (videoId !== state.videoId) {
    transport.stopAudio();
    transport.pause();
    state.videoId = videoId;
    $("video-overlay").hidden = true;
    if (isKnownBlocked(lib.getSong(videoId))) {
      setVideoHidden(true);
    } else {
      setVideoHidden(false);
      transport.loadVideo(videoId).then(() => {
        if (state.entry) transport.setRate(state.entry.settings.speed);
      });
    }
  }
  state.videoId = videoId;
  $("empty-state").hidden = true;
  $("song-view").hidden = false;
  if (isOverlayLibrary()) setLibraryOpen(false);

  const existing = !force && lib.getSong(videoId);
  if (existing) {
    lib.touchSong(videoId);
    applyEntry(lib.getSong(videoId));
    renderLibrary();
    return;
  }

  // New song (or forced re-analysis): show progress while the server works.
  state.entry = null;
  state.analysis = null;
  resetControls();
  grid.build([], 4);
  $("diagrams").innerHTML = "";
  $("analysis-error").hidden = true;
  $("analysis-state").hidden = false;
  $("analysis-bar").style.width = "0%";
  $("analysis-msg").textContent = t("Avvio l'analisi…");
  $("song-title").textContent = lib.getSong(videoId)?.title ?? t("Nuovo brano");
  $("song-sub").textContent = t("Analisi in corso…");
  resetNowPanel();
  renderLibrary();
  loadStemsState(videoId);

  try {
    const res = await api.startAnalysis(videoId, force);
    let analysis = res.result;
    if (!analysis) {
      analysis = await api.waitForJob(
        res.jobId,
        (job) => {
          if (token !== state.analyzeToken) return;
          $("analysis-msg").textContent = t(job.message);
          $("analysis-bar").style.width = `${Math.round(job.progress * 100)}%`;
        },
        () => token !== state.analyzeToken,
      );
    }
    if (token !== state.analyzeToken) return;
    applyEntry(lib.saveAnalysis(analysis));
    renderLibrary();
  } catch (err) {
    if (token !== state.analyzeToken || err.message === "cancelled") return;
    $("analysis-state").hidden = true;
    $("analysis-error").hidden = false;
    $("analysis-error-msg").textContent = t(err.message);
    $("song-sub").textContent = t("Analisi non riuscita");
  }
}

function applyEntry(entry) {
  state.entry = entry;
  state.analysis = entry.analysis;
  const a = entry.analysis;
  $("analysis-state").hidden = true;
  $("analysis-error").hidden = true;
  $("song-title").textContent = entry.title;
  $("song-sub").textContent = [entry.channel, fmtTime(entry.duration)].filter(Boolean).join(" · ");
  document.title = `${entry.title} · Accordario`;

  // Bar number for every beat.
  let bar = 0;
  state.barOf = a.beatPos.map((pos, i) => {
    if (i === 0 || pos === 1 || pos <= a.beatPos[i - 1]) bar++;
    return bar;
  });
  grid.build(a.beatPos, a.beatsPerBar);

  const s = entry.settings;
  $("capo").value = s.capo;
  $("transpose").value = s.transpose;
  $("speed").value = String(s.speed);
  transport.setRate(s.speed);
  state.selection = s.loop ? { from: s.loop.from, to: s.loop.to } : null;
  state.loopOn = !!s.loop?.on;
  state.current = null;
  refreshChords();
  updateLoop();
  loadStemsState(entry.videoId);
  if (isKnownBlocked(entry) && !state.videoBlocked) setVideoHidden(true);
  if (state.videoBlocked) {
    $("audio-only-msg").textContent = AUDIO_ONLY_MSG;
    if (transport.mode !== "audio") useSourceAudio();
  }
}

const AUDIO_ONLY_MSG = t("Il proprietario permette di vederlo solo su YouTube: qui suono l'audio scaricato.");

const isKnownBlocked = (entry) => !!entry && (entry.embedBlocked || entry.analysis?.embeddable === false);

/** Hide the YouTube player (embedding blocked) and show the audio-only card. */
function setVideoHidden(hidden) {
  state.videoBlocked = hidden;
  $("video-wrap").hidden = hidden;
  $("audio-only").hidden = !hidden;
  transport.setVideoEnabled(!hidden);
  if (hidden && state.videoId) {
    $("audio-only-thumb").src = `https://i.ytimg.com/vi/${state.videoId}/mqdefault.jpg`;
    $("audio-only-link").href = `https://www.youtube.com/watch?v=${state.videoId}`;
    $("audio-only-msg").textContent = state.analysis
      ? AUDIO_ONLY_MSG
      : t("Il proprietario permette di vederlo solo su YouTube: l'audio sarà pronto a fine analisi.");
  }
}

/** Default controls while a song without saved settings is loading. */
function resetControls() {
  const d = lib.DEFAULT_SETTINGS;
  $("capo").value = d.capo;
  $("transpose").value = d.transpose;
  $("speed").value = String(d.speed);
  transport.setRate(d.speed);
  state.selection = null;
  state.loopOn = false;
  transport.loop = null;
  $("loop-toggle").disabled = true;
  $("loop-toggle").classList.remove("active");
  $("loop-toggle").querySelector("span").textContent = "Ripeti";
  $("loop-clear").disabled = true;
  $("loop-range").textContent = "Trascina sulla griglia per selezionare";
}

function resetNowPanel() {
  $("now-name").textContent = "—";
  $("next-name").textContent = "—";
  $("next-in").textContent = "";
  $("now-diagram").innerHTML = "";
  $("now-notes").textContent = "";
  $("info-key").textContent = "—";
  $("info-bpm").textContent = "—";
  $("info-bar").textContent = "—";
  state.nowDiagramId = null;
}

// ---------------------------------------------------------------- chords

function refreshChords() {
  const a = state.analysis;
  if (!a) return;
  const s = state.entry.settings;
  // A capo only makes sense for guitar shapes.
  const capo = state.prefs.instrument === "guitar" ? s.capo : 0;
  state.shift = s.transpose - capo;
  $("capo").disabled = state.prefs.instrument !== "guitar";
  $("capo").title = $("capo").disabled ? t("Il capo vale solo per la chitarra") : "";
  const key = parseKey(a.key);
  const solfege = state.prefs.notation === "solfege";
  state.shownKey = key && { ...key, root: (key.root + state.shift + 120) % 12 };
  state.fmt = { flats: keyUsesFlats(state.shownKey), solfege };

  const edits = state.entry.edits || {};
  state.chords = a.beatChords.map((label, i) => transposeChord(parseChord(edits[i] ?? label), state.shift));
  state.ids = state.chords.map(chordId);
  state.names = state.chords.map((c) => formatChord(c, state.fmt));
  grid.setChords(state.names, state.ids);

  const sounding = key && { ...key, root: (key.root + s.transpose + 120) % 12 };
  $("info-key").textContent = formatKey(sounding, { flats: keyUsesFlats(sounding), solfege }) + (capo ? ` · capo ${capo}` : "");
  $("info-bpm").textContent = `${Math.round(a.bpm)} BPM · ${a.beatsPerBar}/4`;
  renderDiagrams();
  state.current = null;
  state.nowDiagramId = null;
}

function drawDiagram(chord) {
  return state.prefs.instrument === "piano" ? pianoDiagram(chord) : guitarDiagram(chord);
}

function renderDiagrams() {
  const seen = new Map();
  state.chords.forEach((c, i) => {
    if (c && !seen.has(state.ids[i])) seen.set(state.ids[i], c);
  });
  $("diagrams").innerHTML = [...seen].map(([id, c]) =>
    `<div class="diag" data-id="${escapeHtml(id)}"><span class="n">${escapeHtml(formatChord(c, state.fmt))}</span>${drawDiagram(c)}</div>`,
  ).join("");
}

function updateNow(i) {
  const n = state.ids.length;
  const idx = Math.max(i, 0);
  const id = i >= 0 ? state.ids[i] : null;
  $("now-name").textContent = i >= 0 ? state.names[i] : "—";

  if (id !== state.nowDiagramId) {
    state.nowDiagramId = id;
    $("now-diagram").innerHTML = i >= 0 && state.chords[i] ? drawDiagram(state.chords[i]) : "";
    const tones = i >= 0 ? chordTones(state.chords[i]) : [];
    $("now-notes").textContent = tones.map((pc) => noteName(pc, state.fmt)).join(" · ");
    document.querySelectorAll(".diag.current").forEach((d) => d.classList.remove("current"));
    if (id) document.querySelector(`.diag[data-id="${CSS.escape(id)}"]`)?.classList.add("current");
  }

  let j = i < 0 ? 0 : idx + 1;
  while (i >= 0 && j < n && state.ids[j] === state.ids[idx]) j++;
  if (j < n) {
    $("next-name").textContent = state.names[j];
    const beats = j - Math.max(i, -1);
    $("next-in").textContent = i < 0 ? t("all'inizio") : beats === 1 ? t("al prossimo battito") : t("tra {n} battiti", { n: beats });
  } else {
    $("next-name").textContent = "—";
    $("next-in").textContent = "";
  }
  const a = state.analysis;
  $("info-bar").textContent = i >= 0 ? `${state.barOf[i]} · ${a.beatPos[i]}/${a.beatsPerBar}` : "—";
}

// ---------------------------------------------------------------- seeking & loop

function seekToBeat(i) {
  if (!state.analysis) return;
  if (state.selection && (i < state.selection.from || i > state.selection.to)) {
    state.selection = null;
    state.loopOn = false;
    updateLoop();
  }
  transport.seek(Math.max(0, state.analysis.beats[i] - SEEK_PREROLL));
  transport.play();
}

function selectRange({ from, to }) {
  state.selection = { from, to };
  state.loopOn = true;
  updateLoop();
  transport.seek(Math.max(0, state.analysis.beats[from] - SEEK_PREROLL));
  transport.play();
}

function updateLoop() {
  const sel = state.selection;
  grid.setSelection(sel);
  grid.setLoopActive(state.loopOn && !!sel);
  transport.loop = state.loopOn && sel
    ? { start: Math.max(0, state.analysis.beats[sel.from] - SEEK_PREROLL), end: beatEnd(sel.to) - 0.02 }
    : null;
  $("loop-toggle").disabled = !sel;
  $("loop-toggle").classList.toggle("active", state.loopOn && !!sel);
  $("loop-toggle").querySelector("span").textContent = state.loopOn && sel ? t("In loop") : t("Ripeti");
  $("loop-clear").disabled = !sel;
  if (sel) {
    const a = state.barOf[sel.from], b = state.barOf[sel.to];
    const bars = a === b ? t("Misura {n}", { n: a }) : t("Misure {a}–{b}", { a, b });
    $("loop-range").textContent = `${bars} · ${fmtTime(state.analysis.beats[sel.from])}–${fmtTime(beatEnd(sel.to))}`;
  } else {
    $("loop-range").textContent = "Trascina sulla griglia per selezionare";
  }
  if (state.entry) saveSettings({ loop: sel ? { ...sel, on: state.loopOn } : null });
}

function setLoopPoint(which) {
  if (!state.analysis) return;
  const last = state.analysis.beats.length - 1;
  const cur = Math.max(0, beatIndexAt(transport.time()));
  const bpb = state.analysis.beatsPerBar;
  let { from, to } = state.selection ?? { from: cur, to: cur };
  if (which === "a") {
    from = cur;
    if (!state.selection || to < from) to = Math.min(from + bpb - 1, last);
  } else {
    to = cur;
    if (!state.selection || from > to) from = Math.max(to - bpb + 1, 0);
  }
  state.selection = { from, to };
  state.loopOn = true;
  updateLoop();
}

function jumpBars(delta) {
  if (!state.analysis) return;
  const cur = Math.max(0, beatIndexAt(transport.time()));
  const target = Math.max(1, state.barOf[cur] + delta);
  let i = state.barOf.indexOf(target);
  if (i < 0) i = delta > 0 ? state.barOf.length - 1 : 0;
  transport.seek(Math.max(0, state.analysis.beats[i] - SEEK_PREROLL));
}

// ---------------------------------------------------------------- editing

function openEditor(i, x, y) {
  if (!state.analysis) return;
  state.editing = i;
  const pop = $("edit-pop");
  const input = $("edit-input");
  input.value = state.chords[i] ? formatChord(state.chords[i], { flats: state.fmt.flats, solfege: state.fmt.solfege }).replace("♯", "#").replace("♭", "b") : "";
  const suggestions = [...diatonicChords(state.shownKey), null];
  $("edit-suggest").innerHTML = suggestions.map((c) =>
    `<button type="button" class="chip" data-label="${escapeHtml(c ? formatChord(c, state.fmt) : "N")}">${c ? escapeHtml(formatChord(c, state.fmt)) : "—"}</button>`,
  ).join("");
  pop.hidden = false;
  const w = pop.offsetWidth, h = pop.offsetHeight;
  pop.style.left = `${Math.min(Math.max(8, x - w / 2), innerWidth - w - 8)}px`;
  pop.style.top = `${y + h + 16 > innerHeight ? Math.max(8, y - h - 12) : y + 12}px`;
  input.focus();
  input.select();
}

function closeEditor() {
  $("edit-pop").hidden = true;
  state.editing = null;
}

function runRange(i) {
  let from = i, to = i;
  while (to + 1 < state.ids.length && state.ids[to + 1] === state.ids[i]) to++;
  while (from > 0 && state.ids[from - 1] === state.ids[i]) from--;
  return { from: i, to, runStart: from };
}

function applyEdit(text, reset = false) {
  const i = state.editing;
  if (i === null) return;
  const { from, to } = runRange(i);
  const edits = { ...(state.entry.edits || {}) };
  const original = state.analysis.beatChords;

  if (reset) {
    for (let k = from; k <= to; k++) delete edits[k];
  } else {
    const t = text.trim().replace("♯", "#").replace("♭", "b");
    let label = "N";
    if (t && !/^(n|nc|n\.c\.?)$/i.test(t)) {
      const chord = parseChord(t);
      if (!chord || chord.root === null || chord.quality === null) {
        toast(t("Accordo non riconosciuto. Esempi: Am, F#, Bb7, Cmaj7, Dsus4, Sol, Lam"));
        return;
      }
      label = chordToLabel(transposeChord(chord, -state.shift));
    }
    for (let k = from; k <= to; k++) {
      if (label === original[k]) delete edits[k];
      else edits[k] = label;
    }
  }
  state.entry.edits = edits;
  lib.updateSong(state.entry.videoId, { edits });
  closeEditor();
  refreshChords();
}

// ---------------------------------------------------------------- stems

function defaultMix(names) {
  return Object.fromEntries(names.map((n) => [n, { gain: 1, mute: false, solo: false }]));
}

async function loadStemsState(videoId) {
  const token = ++state.stems.token;
  state.stems.following = false;
  state.stems.info = null;
  showStemsPanel("idle");
  $("stems-status").textContent = "";
  try {
    const res = await api.getStems(videoId);
    if (token !== state.stems.token) return;
    if (res.available) setStemsReady(res.info);
    else if (res.jobId) followStemsJob(res.jobId, token);
  } catch {
    if (token === state.stems.token) $("stems-status").textContent = t("server non raggiungibile");
  }
}

function showStemsPanel(which) {
  $("stems-idle").hidden = which !== "idle";
  $("stems-progress").hidden = which !== "progress";
  $("stems-ready").hidden = which !== "ready";
}

async function startStems() {
  const videoId = state.videoId;
  if (!videoId) return;
  const token = ++state.stems.token;
  try {
    const res = await api.startStems(videoId);
    if (res.status === "done") setStemsReady(res.result);
    else followStemsJob(res.jobId, token);
  } catch (err) {
    toast(t(err.message));
  }
}

async function followStemsJob(jobId, token) {
  state.stems.following = true;
  showStemsPanel("progress");
  $("stems-status").textContent = t("in corso");
  try {
    const info = await api.waitForJob(jobId, (job) => {
      if (token !== state.stems.token) return;
      $("stems-bar").style.width = `${Math.round(job.progress * 100)}%`;
      $("stems-msg").textContent = t(job.message);
    }, () => token !== state.stems.token);
    if (token !== state.stems.token) return;
    setStemsReady(info);
    toast(t("Tracce separate pronte"));
  } catch (err) {
    if (err.message === "cancelled" || token !== state.stems.token) return;
    showStemsPanel("idle");
    $("stems-status").textContent = t("errore");
    toast(t("Separazione non riuscita: {msg}", { msg: t(err.message) }), 6000);
  } finally {
    if (token === state.stems.token) state.stems.following = false;
  }
}

function setStemsReady(info) {
  state.stems.info = info;
  const saved = state.entry?.settings.stemMix;
  state.stems.mix = { ...defaultMix(info.stems), ...(saved ?? {}) };
  showStemsPanel("ready");
  $("stems-status").textContent = t("pronte");
  renderMixer();
  const active = transport.mode === "audio" && transport.audio.dataset.url === info.url;
  $("stems-enable").checked = active;
  $("mixer").classList.toggle("disabled", !active);
  if (!active && state.entry?.settings.stemMode) enableStems(true);
}

function renderMixer() {
  const { info, mix } = state.stems;
  $("mixer").innerHTML = info.stems.map((name) => {
    const [label, hint] = STEM_LABELS[name] ?? [name, ""];
    const m = mix[name];
    return `<div class="mix-row" data-stem="${name}">
      <span class="name">${label}${hint ? ` <small>${hint}</small>` : ""}</span>
      <button class="mix-btn solo${m.solo ? " on" : ""}" data-act="solo" title="${t("Solo: ascolta solo le tracce in solo")}">S</button>
      <button class="mix-btn mute${m.mute ? " on" : ""}" data-act="mute" title="${t("Muto")}">M</button>
      <input type="range" min="0" max="1.5" step="0.01" value="${m.gain}" data-act="gain" aria-label="${t("Volume {name}", { name: label })}">
    </div>`;
  }).join("");
  applyGains();
}

function applyGains() {
  const { info, mix } = state.stems;
  if (!info) return;
  const anySolo = info.stems.some((n) => mix[n].solo);
  const gains = info.stems.map((n) => {
    const m = mix[n];
    return !m.mute && (!anySolo || m.solo) ? m.gain : 0;
  });
  transport.setGains(gains);
  info.stems.forEach((n, i) => {
    $("mixer").querySelector(`[data-stem="${n}"]`)?.classList.toggle("silent", gains[i] === 0);
  });
  saveSettings({ stemMix: mix });
}

async function enableStems(on) {
  const info = state.stems.info;
  if (!info) return;
  try {
    if (on) {
      await transport.enableAudio(info.url, info.stems.length);
      applyGains();
      $("video-overlay-text").textContent = t("Audio dalle tracce separate · clic per play/pausa");
    } else if (state.videoBlocked) {
      await useSourceAudio();
    } else {
      transport.disableAudio();
    }
  } catch (err) {
    toast(t(err.message));
    on = false;
  }
  $("stems-enable").checked = on;
  $("mixer").classList.toggle("disabled", !on);
  $("video-overlay").hidden = transport.mode !== "audio" || state.videoBlocked;
  saveSettings({ stemMode: on });
}

async function useSourceAudio() {
  if (!state.videoId) return;
  try {
    await transport.enableAudio(`/media/${state.videoId}/source`, 0);
    $("video-overlay").hidden = true;
  } catch {
    $("audio-only-msg").textContent = t("L'audio scaricato non è più sul server: usa \"Rianalizza\" per scaricarlo di nuovo.");
  }
}

// ---------------------------------------------------------------- batch queue

const ICON_X = `<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
const ICON_RETRY = `<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg>`;

function renderQueue() {
  const items = queue.items;
  $("queue").hidden = !items.length;
  const pending = queue.pending;
  $("queue-count").textContent = pending ? `(${pending})` : "";
  $("queue-clear").hidden = pending === items.length;
  $("queue-list").innerHTML = items.map((item) => {
    const failed = item.status === "error";
    const waiting = !failed && (item.status !== "running" || /attesa|coda/i.test(item.message || ""));
    const pct = Math.round((item.progress || 0) * 100);
    const title = item.title || lib.getSong(item.videoId)?.title || `Video ${item.videoId}`;
    let status = failed ? t(item.error || "Errore") : t(item.message || "In coda…");
    if (!failed && !waiting && pct > 0 && pct < 100) status += ` ${pct}%`;
    if (item.stage === "stems" && !failed) status = t("Tracce · {status}", { status });
    return `<li class="q-item${failed ? " error" : ""}${waiting ? " waiting" : ""}" data-id="${item.videoId}" title="${escapeHtml(title)}">
      <img loading="lazy" alt="" src="https://i.ytimg.com/vi/${item.videoId}/mqdefault.jpg">
      <div style="min-width:0">
        <div class="t">${escapeHtml(title)}</div>
        <div class="s">${escapeHtml(status)}</div>
        ${failed ? "" : `<div class="bar"><div style="width:${pct}%"></div></div>`}
      </div>
      <div class="q-actions">
        ${failed ? `<button class="icon-btn" data-act="retry" title="${t("Riprova")}" aria-label="${t("Riprova")}">${ICON_RETRY}</button>` : ""}
        <button class="icon-btn" data-act="remove" title="${t("Togli dalla coda")}" aria-label="${t("Togli dalla coda")}">${ICON_X}</button>
      </div>
    </li>`;
  }).join("");
}

function openBatchDialog(text = "") {
  $("batch-text").value = text;
  updateBatchSummary();
  $("batch-dialog").showModal();
  $("batch-text").focus();
}

function updateBatchSummary() {
  const { videos, playlists } = api.countLinks($("batch-text").value);
  const parts = [];
  if (videos) parts.push(tn(videos, "{n} brano", "{n} brani"));
  if (playlists) parts.push(`${playlists} playlist`);
  $("batch-summary").textContent = parts.length ? t("Riconosciuti: {parts}", { parts: parts.join(" + ") }) : t("Nessun link riconosciuto.");
  $("batch-submit").disabled = !parts.length;
}

async function submitBatch() {
  const button = $("batch-submit");
  const stems = $("batch-stems").checked;
  button.disabled = true;
  button.textContent = t("Leggo i link…");
  try {
    const res = await api.resolveLinks($("batch-text").value);
    const fresh = [];
    const stemsOnly = [];
    let inLibrary = 0;
    let inQueue = 0;
    for (const video of res.videos) {
      if (queue.has(video.videoId)) inQueue++;
      else if (lib.getSong(video.videoId)) {
        inLibrary++;
        if (stems) stemsOnly.push(video);
      } else fresh.push(video);
    }
    queue.add(fresh, { stems });
    if (stemsOnly.length) queue.add(stemsOnly, { stems: true, stage: "stems" });
    $("batch-dialog").close();

    const parts = [];
    if (fresh.length) parts.push(tn(fresh.length, "{n} brano aggiunto alla coda", "{n} brani aggiunti alla coda"));
    if (stemsOnly.length) parts.push(t("{n} già in libreria: separo solo le tracce", { n: stemsOnly.length }));
    else if (inLibrary) parts.push(t("{n} già in libreria", { n: inLibrary }));
    if (inQueue) parts.push(t("{n} già in coda", { n: inQueue }));
    if (!parts.length) parts.push(t("Niente di nuovo da aggiungere"));
    if (res.invalid.length) parts.push(t("{n} non riconosciuti", { n: res.invalid.length }));
    if (res.playlistErrors.length) parts.push(t("playlist non leggibile: {msg}", { msg: res.playlistErrors[0] }));
    toast(parts.join(" · "), 6000);
    if (fresh.length || stemsOnly.length) setLibraryOpen(true);
  } catch (err) {
    toast(t(err.message), 6000);
  } finally {
    button.textContent = t("Aggiungi alla coda");
    updateBatchSummary();
  }
}

// ---------------------------------------------------------------- main loop

function frame() {
  requestAnimationFrame(frame);
  if (!state.videoId) return;
  const t = transport.tick();
  const duration = transport.duration() || state.analysis?.duration || 0;
  if (!state.seeking) {
    $("seek").max = duration;
    $("seek").value = t;
    $("time-now").textContent = fmtTime(t);
  }
  $("time-total").textContent = fmtTime(duration);
  if (!state.analysis) return;
  const i = beatIndexAt(t);
  if (i !== state.current) {
    state.current = i;
    grid.setCurrent(i);
    updateNow(i);
  }
}

// ---------------------------------------------------------------- routing

function route() {
  const match = location.hash.match(/^#\/v\/([A-Za-z0-9_-]{11})/);
  if (match) openVideo(match[1]);
  else showHome();
}

// ---------------------------------------------------------------- wiring

function fillSelect(el, items) {
  el.innerHTML = items.map(([v, label]) => `<option value="${v}">${label}</option>`).join("");
}

function setSegmented(el, value) {
  el.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === value)));
}

function init() {
  translatePage();
  const root = document.documentElement;
  const darkMq = matchMedia("(prefers-color-scheme: dark)");
  const isDark = () => root.dataset.theme ? root.dataset.theme === "dark" : darkMq.matches;
  const syncTheme = () => root.classList.toggle("dark-ui", isDark());
  syncTheme();
  darkMq.addEventListener("change", syncTheme);
  $("theme-toggle").addEventListener("click", () => {
    root.dataset.theme = isDark() ? "light" : "dark";
    try { localStorage.setItem("theme", root.dataset.theme); } catch {}
    syncTheme();
  });

  const langSel = $("lang-select");
  langSel.innerHTML = languages.map((l) =>
    `<option value="${l.code}">${l.flag ?? ""} ${escapeHtml(l.name)}</option>`).join("");
  langSel.value = lang;
  langSel.hidden = languages.length < 2;
  langSel.addEventListener("change", () => setLang(langSel.value));
  fillSelect($("capo"), Array.from({ length: 12 }, (_, i) => [i, i === 0 ? t("Nessuno") : t("{n}° tasto", { n: i })]));
  fillSelect($("transpose"), Array.from({ length: 13 }, (_, k) => {
    const v = 6 - k;
    return [v, v === 0 ? "0" : v > 0 ? `+${v}` : `${v}`];
  }));
  $("transpose").value = 0;
  setSegmented($("instrument"), state.prefs.instrument);
  setSegmented($("notation"), state.prefs.notation);
  setLibraryOpen(isOverlayLibrary() ? false : state.prefs.libraryOpen !== false);

  $("analyze-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const value = $("url-input").value;
    const id = api.parseVideoId(value);
    if (!id) {
      if (api.countLinks(value).playlists) {
        $("url-input").value = "";
        openBatchDialog(value);
      } else {
        toast("Link YouTube non valido");
      }
      return;
    }
    $("url-input").value = "";
    $("url-input").blur();
    if (location.hash === `#/v/${id}`) openVideo(id);
    else location.hash = `#/v/${id}`;
  });

  // Pasting several links (or a playlist) opens the batch dialog.
  $("url-input").addEventListener("paste", (e) => {
    const text = e.clipboardData?.getData("text") ?? "";
    const { videos, playlists } = api.countLinks(text);
    if (videos + playlists > 1 || (playlists && !videos)) {
      e.preventDefault();
      openBatchDialog(text);
    }
  });
  $("batch-open").addEventListener("click", () => openBatchDialog($("url-input").value));
  $("batch-text").addEventListener("input", updateBatchSummary);
  $("batch-cancel").addEventListener("click", () => $("batch-dialog").close());
  $("batch-form").addEventListener("submit", (e) => {
    e.preventDefault();
    submitBatch();
  });

  queue.addEventListener("change", () => {
    renderQueue();
    // A separation started from the queue for the open song: show its progress.
    const mine = queue.items.find((i) => i.videoId === state.videoId && i.stage === "stems" && i.jobId);
    if (mine && !state.stems.info && !state.stems.following) loadStemsState(state.videoId);
  });
  queue.addEventListener("analysis-done", (e) => {
    const { analysis, instant } = e.detail;
    const isNew = !lib.getSong(analysis.videoId) && !instant;
    try {
      lib.saveAnalysis(analysis, { open: false });
    } catch (err) {
      toast(t(err.message), 6000);
      return;
    }
    renderLibrary();
    if (isNew) toast(t("Pronto: {title}", { title: analysis.title }));
  });
  queue.addEventListener("stems-done", (e) => {
    toast(t("Tracce separate pronte: {title}", { title: e.detail.title ?? e.detail.videoId }));
    if (e.detail.videoId === state.videoId) loadStemsState(state.videoId);
  });
  $("queue-list").addEventListener("click", (e) => {
    const item = e.target.closest(".q-item");
    if (!item) return;
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "remove") queue.remove(item.dataset.id);
    else if (act === "retry") queue.retry(item.dataset.id);
    else if (location.hash === `#/v/${item.dataset.id}`) openVideo(item.dataset.id);
    else location.hash = `#/v/${item.dataset.id}`;
  });
  $("queue-clear").addEventListener("click", () => queue.clearErrors());

  $("toggle-library").addEventListener("click", () => setLibraryOpen(document.body.classList.contains("library-closed")));
  $("library-scrim").addEventListener("click", () => setLibraryOpen(false));
  $("lib-search").addEventListener("input", renderLibrary);
  $("lib-sort").addEventListener("change", renderLibrary);
  $("lib-list").addEventListener("click", (e) => {
    const item = e.target.closest(".lib-item");
    if (!item) return;
    if (e.target.closest(".del")) {
      deleteFromLibrary(item.dataset.id);
      return;
    }
    if (location.hash === `#/v/${item.dataset.id}`) openVideo(item.dataset.id);
    else location.hash = `#/v/${item.dataset.id}`;
  });
  $("lib-export").addEventListener("click", lib.exportLibrary);
  $("lib-import").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const n = await lib.importLibrary(file);
      toast(tn(n, "{n} brano importato", "{n} brani importati"));
      renderLibrary();
    } catch (err) {
      toast(t("Importazione non riuscita: {msg}", { msg: t(err.message) }));
    }
  });

  $("play-btn").addEventListener("click", () => transport.toggle());
  $("video-overlay").addEventListener("click", () => transport.toggle());
  transport.addEventListener("state", (e) => {
    $("play-btn").classList.toggle("playing", e.detail.playing);
    $("play-btn").setAttribute("aria-label", e.detail.playing ? t("Pausa") : "Play");
  });
  transport.addEventListener("videoerror", (e) => {
    if (!e.detail.blocked) {
      toast(t("Errore del player YouTube ({code})", { code: e.detail.code }));
      return;
    }
    if (state.videoBlocked || !state.videoId) return;
    setVideoHidden(true);
    if (state.entry) lib.updateSong(state.entry.videoId, { embedBlocked: true });
    if (state.analysis && transport.mode !== "audio") useSourceAudio();
  });

  $("seek").addEventListener("input", () => {
    state.seeking = true;
    $("time-now").textContent = fmtTime(Number($("seek").value));
  });
  $("seek").addEventListener("change", () => {
    transport.seek(Number($("seek").value));
    state.seeking = false;
  });

  $("speed").addEventListener("change", () => {
    const rate = Number($("speed").value);
    transport.setRate(rate);
    saveSettings({ speed: rate });
    setTimeout(() => {
      const actual = transport.effectiveRate();
      if (transport.mode === "video" && Math.abs(actual - rate) > 0.01) {
        toast(t("YouTube supporta {v}× come velocità più vicina. Con le tracce separate puoi usare qualsiasi velocità.", { v: actual }), 6000);
      }
    }, 500);
  });
  $("capo").addEventListener("change", () => {
    saveSettings({ capo: Number($("capo").value) });
    refreshChords();
  });
  $("transpose").addEventListener("change", () => {
    saveSettings({ transpose: Number($("transpose").value) });
    refreshChords();
  });
  $("instrument").addEventListener("click", (e) => {
    const v = e.target.closest("button")?.dataset.v;
    if (!v) return;
    state.prefs.instrument = v;
    lib.savePrefs(state.prefs);
    setSegmented($("instrument"), v);
    refreshChords();
  });
  $("notation").addEventListener("click", (e) => {
    const v = e.target.closest("button")?.dataset.v;
    if (!v) return;
    state.prefs.notation = v;
    lib.savePrefs(state.prefs);
    setSegmented($("notation"), v);
    refreshChords();
    renderLibrary();
  });

  $("loop-toggle").addEventListener("click", () => {
    state.loopOn = !state.loopOn;
    updateLoop();
  });
  $("loop-clear").addEventListener("click", () => {
    state.selection = null;
    state.loopOn = false;
    updateLoop();
  });
  $("set-a").addEventListener("click", () => setLoopPoint("a"));
  $("set-b").addEventListener("click", () => setLoopPoint("b"));

  $("reanalyze").addEventListener("click", () => {
    if (!state.videoId) return;
    if (confirm(t("Rianalizzare il brano? Le correzioni manuali verranno mantenute solo se le battute non cambiano."))) {
      openVideo(state.videoId, { force: true });
    }
  });
  $("analysis-retry").addEventListener("click", () => state.videoId && openVideo(state.videoId, { force: true }));

  $("stems-start").addEventListener("click", startStems);
  $("stems-enable").addEventListener("change", (e) => enableStems(e.target.checked));
  $("stems-presets").addEventListener("click", (e) => {
    const preset = STEM_PRESETS[e.target.closest("[data-preset]")?.dataset.preset];
    if (!preset || !state.stems.info) return;
    for (const [name, m] of Object.entries(state.stems.mix)) {
      m.solo = preset.solo?.includes(name) ?? false;
      m.mute = preset.mute?.includes(name) ?? false;
    }
    renderMixer();
    if (transport.mode !== "audio" || transport.audio.dataset.url !== state.stems.info.url) enableStems(true);
  });
  $("mixer").addEventListener("click", (e) => {
    const btn = e.target.closest(".mix-btn");
    if (!btn) return;
    const m = state.stems.mix[btn.closest(".mix-row").dataset.stem];
    m[btn.dataset.act] = !m[btn.dataset.act];
    btn.classList.toggle("on", m[btn.dataset.act]);
    applyGains();
  });
  $("mixer").addEventListener("input", (e) => {
    if (e.target.dataset.act !== "gain") return;
    state.stems.mix[e.target.closest(".mix-row").dataset.stem].gain = Number(e.target.value);
    applyGains();
  });

  $("edit-form").addEventListener("submit", (e) => {
    e.preventDefault();
    applyEdit($("edit-input").value);
  });
  $("edit-suggest").addEventListener("click", (e) => {
    const label = e.target.closest("[data-label]")?.dataset.label;
    if (label) applyEdit(label);
  });
  $("edit-reset").addEventListener("click", () => applyEdit("", true));
  $("edit-cancel").addEventListener("click", closeEditor);
  document.addEventListener("pointerdown", (e) => {
    if (!$("edit-pop").hidden && !e.target.closest("#edit-pop")) closeEditor();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("edit-pop").hidden) closeEditor();
      else if (state.selection) {
        state.selection = null;
        state.loopOn = false;
        updateLoop();
      }
      return;
    }
    if (e.target.closest("input, select, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!state.videoId) return;
    const speedSel = $("speed");
    switch (e.key) {
      case " ":
        e.preventDefault();
        transport.toggle();
        break;
      case "ArrowLeft":
        e.preventDefault();
        jumpBars(-1);
        break;
      case "ArrowRight":
        e.preventDefault();
        jumpBars(1);
        break;
      case "l":
      case "L":
        if (state.selection) {
          state.loopOn = !state.loopOn;
          updateLoop();
        }
        break;
      case "+":
      case "=":
      case "-":
        speedSel.selectedIndex = Math.max(0, Math.min(speedSel.options.length - 1, speedSel.selectedIndex + (e.key === "-" ? -1 : 1)));
        speedSel.dispatchEvent(new Event("change"));
        toast(t("Velocità {v}×", { v: speedSel.value }), 1200);
        break;
    }
  });

  window.addEventListener("hashchange", route);
  renderLibrary();
  renderQueue();
  queue.kick();
  route();
  requestAnimationFrame(frame);

  api.health().then((h) => {
    if (!h.stems) {
      $("stems-idle").innerHTML = `<p class="muted small">${t("Separazione tracce non installata sul server (manca Demucs).")}</p>`;
    }
  }).catch(() => toast(t("Server non raggiungibile: avvialo con ./start.sh"), 8000));
}

init();

// Handy for debugging from the browser console.
window.accordario = { state, transport, grid, queue };
