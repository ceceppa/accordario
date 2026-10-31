// Draggable divider between the video panel and the chord grid.
// The chosen width (in px) is remembered in localStorage.
const KEY = "accordario.leftPanelWidth";
const MIN = 280;
const MIN_RIGHT = 360;

const view = document.getElementById("song-view");
const handle = document.getElementById("splitter");

function clamp(w) {
  const max = view.clientWidth - MIN_RIGHT;
  return Math.round(Math.max(MIN, Math.min(w, max > MIN ? max : MIN)));
}

function apply(w) {
  if (w == null) view.style.removeProperty("--left-w");
  else view.style.setProperty("--left-w", `${clamp(w)}px`);
}

function save(w) {
  try {
    if (w == null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(Math.round(w)));
  } catch {}
}

function load() {
  try {
    const v = parseInt(localStorage.getItem(KEY), 10);
    return Number.isFinite(v) ? v : null;
  } catch { return null; }
}

let saved = load();
apply(saved);

handle.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  handle.setPointerCapture(e.pointerId);
  const left = view.getBoundingClientRect().left;
  document.body.classList.add("resizing");
  const move = (ev) => { saved = clamp(ev.clientX - left); apply(saved); };
  const up = () => {
    document.body.classList.remove("resizing");
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    handle.removeEventListener("pointercancel", up);
    save(saved);
    window.dispatchEvent(new Event("resize"));
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", up);
});

handle.addEventListener("dblclick", () => { saved = null; apply(null); save(null); });

handle.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  e.preventDefault();
  e.stopPropagation(); // don't trigger bar navigation shortcuts
  const cur = view.querySelector(".song-left").getBoundingClientRect().width;
  saved = clamp(cur + (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 80 : 20));
  apply(saved);
  save(saved);
});

// Keep the saved width valid when the window shrinks.
window.addEventListener("resize", () => { if (saved != null) apply(saved); });
