import { t } from "./i18n.js";
// Chord parsing, spelling, transposition and voicings.
// Pitch classes use C = 0 … B = 11.

const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SOLFEGE = { C: "Do", D: "Re", E: "Mi", F: "Fa", G: "Sol", A: "La", B: "Si" };

// Quality suffix -> intervals (semitones from root). Order matters for parsing.
export const QUALITIES = {
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  "7": [0, 4, 7, 10],
  m: [0, 3, 7],
  "": [0, 4, 7],
};
const QUALITY_KEYS = Object.keys(QUALITIES);

/** Parse "F#m", "Bbmaj7", "N" … into {root, quality} (null for no chord). */
export function parseChord(label) {
  if (!label || label === "N" || label === "N.C.") return null;
  const text = solfegeToLetters(label.trim().replace("♯", "#").replace("♭", "b"));
  const match = text.match(/^([A-Ga-g])([#b]?)(.*)$/);
  if (!match) return { root: null, quality: null, raw: label };
  const letter = match[1].toUpperCase();
  let root = LETTER_PC[letter];
  if (match[2] === "#") root = (root + 1) % 12;
  if (match[2] === "b") root = (root + 11) % 12;
  let rest = match[3].replace(/^min$/, "m").replace(/^maj$/, "").replace(/^M7$/, "maj7");
  const quality = QUALITY_KEYS.find((q) => q === rest);
  if (quality === undefined) return { root, quality: null, raw: label, rest };
  return { root, quality };
}

const SOLFEGE_TO_LETTER = { do: "C", re: "D", mi: "E", fa: "F", sol: "G", la: "A", si: "B" };

/** "Sol#m" -> "G#m", "lab" -> "Ab". Letters pass through unchanged. */
function solfegeToLetters(text) {
  const match = text.match(/^(sol|do|re|mi|fa|la|si)(.*)$/i);
  if (!match) return text;
  return SOLFEGE_TO_LETTER[match[1].toLowerCase()] + match[2];
}

/** Storage label in the analysis format: sharps, e.g. "F#m", "Bbmaj7" -> "A#maj7". */
export function chordToLabel(chord) {
  if (!chord) return "N";
  if (chord.root === null) return chord.raw;
  return SHARP_NAMES[chord.root] + (chord.quality ?? chord.rest ?? "");
}

/** Triads that belong to a key, in scale order. */
export function diatonicChords(key) {
  if (!key) return [];
  const steps = key.minor
    ? [[0, "m"], [3, ""], [5, "m"], [7, "m"], [7, ""], [8, ""], [10, ""]]
    : [[0, ""], [2, "m"], [4, "m"], [5, ""], [7, ""], [9, "m"]];
  return steps.map(([step, quality]) => ({ root: (key.root + step) % 12, quality }));
}

export function transposeChord(chord, semitones) {
  if (!chord || chord.root === null) return chord;
  return { ...chord, root: (((chord.root + semitones) % 12) + 12) % 12 };
}

/** Parse a madmom key label like "Db major" / "F# minor". */
export function parseKey(label) {
  if (!label) return null;
  const [name, mode] = label.split(" ");
  const chord = parseChord(name);
  if (!chord) return null;
  return { root: chord.root, minor: mode === "minor" };
}

/** Whether a key is conventionally written with flats. */
export function keyUsesFlats(key) {
  if (!key) return false;
  const majorFlats = [5, 10, 3, 8, 1]; // F Bb Eb Ab Db
  const minorFlats = [2, 7, 0, 5, 10, 3]; // D G C F Bb Eb
  return (key.minor ? minorFlats : majorFlats).includes(key.root);
}

export function noteName(pc, { flats = false, solfege = false } = {}) {
  const name = (flats ? FLAT_NAMES : SHARP_NAMES)[((pc % 12) + 12) % 12];
  const letter = name[0];
  const acc = name.slice(1).replace("#", "♯").replace("b", "♭");
  return (solfege ? SOLFEGE[letter] : letter) + acc;
}

/** Human readable chord name, e.g. "F♯m" or "Fa♯m". */
export function formatChord(chord, opts = {}) {
  if (!chord) return "";
  if (chord.root === null) return chord.raw;
  if (chord.quality === null) return noteName(chord.root, opts) + chord.rest;
  return noteName(chord.root, opts) + chord.quality;
}

export function formatKey(key, opts = {}) {
  if (!key) return "—";
  return noteName(key.root, opts) + " " + t(key.minor ? "minore" : "maggiore");
}

export function chordId(chord) {
  if (!chord) return "N";
  if (chord.root === null || chord.quality === null) return chord.raw ?? "?";
  return `${chord.root}:${chord.quality}`;
}

/** Pitch classes of a chord, root first. */
export function chordTones(chord) {
  if (!chord || chord.root === null || chord.quality === null) return [];
  return QUALITIES[chord.quality].map((i) => (chord.root + i) % 12);
}

// ---------------------------------------------------------------------------
// Guitar voicings. Arrays list frets from low E to high e; -1 = muted.
// ---------------------------------------------------------------------------

const OPEN_SHAPES = {
  "0:": [-1, 3, 2, 0, 1, 0], // C
  "2:": [-1, -1, 0, 2, 3, 2], // D
  "4:": [0, 2, 2, 1, 0, 0], // E
  "7:": [3, 2, 0, 0, 0, 3], // G
  "9:": [-1, 0, 2, 2, 2, 0], // A
  "9:m": [-1, 0, 2, 2, 1, 0], // Am
  "2:m": [-1, -1, 0, 2, 3, 1], // Dm
  "4:m": [0, 2, 2, 0, 0, 0], // Em
  "0:7": [-1, 3, 2, 3, 1, 0],
  "2:7": [-1, -1, 0, 2, 1, 2],
  "4:7": [0, 2, 0, 1, 0, 0],
  "7:7": [3, 2, 0, 0, 0, 1],
  "9:7": [-1, 0, 2, 0, 2, 0],
  "9:m7": [-1, 0, 2, 0, 1, 0],
  "4:m7": [0, 2, 0, 0, 0, 0],
  "2:m7": [-1, -1, 0, 2, 1, 1],
  "0:maj7": [-1, 3, 2, 0, 0, 0],
  "5:maj7": [-1, -1, 3, 2, 1, 0],
  "2:sus4": [-1, -1, 0, 2, 3, 3],
  "2:sus2": [-1, -1, 0, 2, 3, 0],
  "9:sus4": [-1, 0, 2, 2, 3, 0],
  "9:sus2": [-1, 0, 2, 2, 0, 0],
  "4:sus4": [0, 2, 2, 2, 0, 0],
};

// Movable barre shapes: root on the 6th string (E form) or 5th string (A form).
const E_FORM = {
  "": [0, 2, 2, 1, 0, 0],
  m: [0, 2, 2, 0, 0, 0],
  "7": [0, 2, 0, 1, 0, 0],
  m7: [0, 2, 0, 0, 0, 0],
  maj7: [0, -1, 1, 1, 0, -1],
  sus4: [0, 2, 2, 2, 0, 0],
};
const A_FORM = {
  "": [-1, 0, 2, 2, 2, 0],
  m: [-1, 0, 2, 2, 1, 0],
  "7": [-1, 0, 2, 0, 2, 0],
  m7: [-1, 0, 2, 0, 1, 0],
  maj7: [-1, 0, 2, 1, 2, 0],
  sus2: [-1, 0, 2, 2, 0, 0],
  sus4: [-1, 0, 2, 2, 3, 0],
  dim: [-1, 0, 1, 2, 1, -1],
  aug: [-1, 0, 3, 2, 2, 1],
};

function shift(shape, fret) {
  return shape.map((f) => (f < 0 ? -1 : f + fret));
}

/** Return {frets, barre} for a chord, or null if unknown. */
export function guitarVoicing(chord) {
  if (!chord || chord.root === null || chord.quality === null) return null;
  const open = OPEN_SHAPES[`${chord.root}:${chord.quality}`];
  if (open) return { frets: open, barre: null };

  const candidates = [];
  if (E_FORM[chord.quality]) {
    const fret = (chord.root - 4 + 12) % 12 || 12;
    candidates.push({ frets: shift(E_FORM[chord.quality], fret), barre: { fret, from: 0, to: 5 } });
  }
  if (A_FORM[chord.quality]) {
    const fret = (chord.root - 9 + 12) % 12 || 12;
    candidates.push({ frets: shift(A_FORM[chord.quality], fret), barre: { fret, from: 1, to: 5 } });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.barre.fret - b.barre.fret);
  return candidates[0];
}
