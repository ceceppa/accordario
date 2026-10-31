import { t } from "./i18n.js";
import { formatKey, keyUsesFlats, parseKey } from "./chords.js";

// Song library kept in localStorage.
// Each entry stores the full analysis, so songs reopen without the server.

const STORAGE_KEY = "accordario:library:v1";
const PREFS_KEY = "accordario:prefs:v1";

function readStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const data = raw ? JSON.parse(raw) : null;
    return data && typeof data.songs === "object" ? data : { songs: {} };
  } catch {
    return { songs: {} };
  }
}

function writeStore(store) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    return true;
  } catch (err) {
    console.error("localStorage write failed", err);
    return false;
  }
}

export const DEFAULT_SETTINGS = {
  capo: 0,
  transpose: 0,
  speed: 1,
  loop: null, // {from: beatIndex, to: beatIndex}
  stemMode: false,
  stemMix: null, // {name: {gain, mute, solo}}
};

export function listSongs() {
  return Object.values(readStore().songs);
}

export function getSong(videoId) {
  return readStore().songs[videoId] ?? null;
}

/**
 * Insert or update a song from a server analysis. Returns the entry.
 * `open: false` (songs finished in the queue) leaves it marked as new.
 */
export function saveAnalysis(analysis, { open = true } = {}) {
  const store = readStore();
  const now = Date.now();
  const old = store.songs[analysis.videoId];
  const entry = {
    videoId: analysis.videoId,
    title: analysis.title,
    channel: analysis.channel,
    duration: analysis.duration,
    addedAt: old?.addedAt ?? now,
    openedAt: open ? now : old?.openedAt ?? null,
    embedBlocked: Boolean(old?.embedBlocked) || analysis.embeddable === false,
    analysis,
    // Manual edits are stored per beat: drop them if the beats changed.
    edits: old?.analysis?.beats?.length === analysis.beats.length ? old.edits ?? {} : {},
    settings: { ...DEFAULT_SETTINGS, ...(old?.settings ?? {}) },
  };
  store.songs[entry.videoId] = entry;
  if (!writeStore(store)) {
    throw new Error(t("Spazio del browser esaurito: elimina qualche brano dalla libreria."));
  }
  return entry;
}

/** Shallow-merge fields into an entry (settings/edits are replaced as given). */
export function updateSong(videoId, patch) {
  const store = readStore();
  const entry = store.songs[videoId];
  if (!entry) return null;
  Object.assign(entry, patch);
  writeStore(store);
  return entry;
}

export function touchSong(videoId) {
  return updateSong(videoId, { openedAt: Date.now() });
}

export function deleteSong(videoId) {
  const store = readStore();
  delete store.songs[videoId];
  writeStore(store);
}

function normalize(text) {
  return (text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/** "C major" -> "C major C maggiore Do maggiore" (plus the flat/sharp spelling). */
function keySearchText(label) {
  const key = parseKey(label);
  if (!key) return "";
  const flats = keyUsesFlats(key);
  const plain = (t) => t.replace("♯", "#").replace("♭", "b");
  return [
    label,
    plain(formatKey(key, { flats })),
    plain(formatKey(key, { flats, solfege: true })),
  ].join(" ");
}

export function searchSongs(query, sort = "recent") {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  let songs = listSongs().filter((s) => {
    const hay = normalize(`${s.title} ${s.channel} ${keySearchText(s.analysis?.key)}`);
    return terms.every((t) => hay.includes(t));
  });
  const sorters = {
    recent: (a, b) => (b.openedAt ?? b.addedAt ?? 0) - (a.openedAt ?? a.addedAt ?? 0),
    added: (a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0),
    title: (a, b) => a.title.localeCompare(b.title, "it"),
  };
  songs.sort(sorters[sort] ?? sorters.recent);
  return songs;
}

export function exportLibrary() {
  const blob = new Blob([JSON.stringify(readStore(), null, 1)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `accordario-libreria-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Merge songs from an exported file. Returns how many were imported. */
export async function importLibrary(file) {
  const data = JSON.parse(await file.text());
  if (!data || typeof data.songs !== "object") throw new Error(t("File non valido"));
  const store = readStore();
  let count = 0;
  for (const [id, song] of Object.entries(data.songs)) {
    if (!song?.analysis?.beats) continue;
    store.songs[id] = song;
    count++;
  }
  if (!writeStore(store)) throw new Error(t("Spazio del browser esaurito"));
  return count;
}

export function storageUsageKB() {
  return Math.round((localStorage.getItem(STORAGE_KEY)?.length ?? 0) / 1024);
}

export function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) ?? {};
  } catch {
    return {};
  }
}

export function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}
