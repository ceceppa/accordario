// SVG chord diagrams for guitar and piano. Colors come from CSS classes.
import { chordTones, guitarVoicing } from "./chords.js";

const WHITE_PCS = [0, 2, 4, 5, 7, 9, 11];
const BLACK_PCS = { 1: 0, 3: 1, 6: 3, 8: 4, 10: 5 }; // black pc -> white key on its left

export function guitarDiagram(chord) {
  const voicing = guitarVoicing(chord);
  if (!voicing) return emptyDiagram();
  const { frets, barre } = voicing;
  const positive = frets.filter((f) => f > 0);
  const maxFret = positive.length ? Math.max(...positive) : 0;
  const base = maxFret <= 4 ? 1 : Math.min(...positive);
  const rows = 4;
  const x0 = 14, y0 = 16, dx = 10, dy = 13;
  const width = x0 + dx * 5 + 10;
  const height = y0 + dy * rows + 6;
  const parts = [];

  // Frets and strings
  for (let r = 0; r <= rows; r++) {
    const y = y0 + r * dy;
    const cls = r === 0 && base === 1 ? "gd-nut" : "gd-fret";
    parts.push(`<line class="${cls}" x1="${x0}" y1="${y}" x2="${x0 + dx * 5}" y2="${y}"/>`);
  }
  for (let s = 0; s < 6; s++) {
    const x = x0 + s * dx;
    parts.push(`<line class="gd-string" x1="${x}" y1="${y0}" x2="${x}" y2="${y0 + rows * dy}"/>`);
  }
  if (base > 1) {
    parts.push(`<text class="gd-base" x="${x0 - 4}" y="${y0 + dy * 0.5 + 3}" text-anchor="end">${base}</text>`);
  }

  // Barre
  if (barre && barre.fret >= base) {
    const y = y0 + (barre.fret - base + 0.5) * dy;
    const xa = x0 + barre.from * dx, xb = x0 + barre.to * dx;
    parts.push(`<rect class="gd-dot" x="${xa - 4}" y="${y - 4}" width="${xb - xa + 8}" height="8" rx="4"/>`);
  }

  // Dots and open/muted markers
  frets.forEach((f, s) => {
    const x = x0 + s * dx;
    if (f < 0) {
      parts.push(`<text class="gd-mark" x="${x}" y="${y0 - 5}" text-anchor="middle">×</text>`);
    } else if (f === 0) {
      parts.push(`<circle class="gd-open" cx="${x}" cy="${y0 - 8}" r="2.8"/>`);
    } else if (!(barre && f === barre.fret && s >= barre.from && s <= barre.to)) {
      const y = y0 + (f - base + 0.5) * dy;
      parts.push(`<circle class="gd-dot" cx="${x}" cy="${y}" r="4"/>`);
    }
  });

  return `<svg class="diagram guitar" viewBox="0 0 ${width} ${height}" aria-hidden="true">${parts.join("")}</svg>`;
}

export function pianoDiagram(chord) {
  const tones = chordTones(chord);
  if (!tones.length) return emptyDiagram();
  // Lay the chord out in root position, ascending from the root.
  const active = new Map();
  let prev = -1;
  tones.forEach((pc, i) => {
    let abs = pc;
    while (abs <= prev) abs += 12;
    active.set(abs, i === 0 ? "root" : "tone");
    prev = abs;
  });

  const octaves = 2;
  const ww = 9, wh = 38, bw = 6, bh = 23;
  const width = WHITE_PCS.length * octaves * ww + 1;
  const parts = [];
  for (let o = 0; o < octaves; o++) {
    WHITE_PCS.forEach((pc, i) => {
      const abs = o * 12 + pc;
      const x = (o * 7 + i) * ww + 0.5;
      const state = active.get(abs);
      parts.push(`<rect class="pk-white ${state ? "pk-" + state : ""}" x="${x}" y="0.5" width="${ww}" height="${wh}" rx="1.5"/>`);
    });
  }
  for (let o = 0; o < octaves; o++) {
    for (const [pc, whiteIdx] of Object.entries(BLACK_PCS)) {
      const abs = o * 12 + Number(pc);
      const x = (o * 7 + whiteIdx + 1) * ww - bw / 2 + 0.5;
      const state = active.get(abs);
      parts.push(`<rect class="pk-black ${state ? "pk-" + state : ""}" x="${x}" y="0.5" width="${bw}" height="${bh}" rx="1"/>`);
    }
  }
  return `<svg class="diagram piano" viewBox="0 0 ${width} ${wh + 1}" aria-hidden="true">${parts.join("")}</svg>`;
}

function emptyDiagram() {
  return `<div class="diagram empty">—</div>`;
}
