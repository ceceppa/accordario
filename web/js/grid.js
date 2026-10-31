// Chord grid: one cell per beat, grouped in bars.
// Click = jump there, drag (or shift+click) = select a range, right click = edit.

const USER_SCROLL_GRACE_MS = 3500;

export class ChordGrid {
  constructor(container, { onSeek, onSelect, onEdit }) {
    this.el = container;
    this.onSeek = onSeek;
    this.onSelect = onSelect;
    this.onEdit = onEdit;
    this.cells = [];
    this.bars = [];
    this.current = -1;
    this.selection = null;
    this.drag = null;
    this.userScrolledAt = 0;
    this.lastScrollRow = null;

    this.el.addEventListener("pointerdown", (e) => this.pointerDown(e));
    this.el.addEventListener("pointermove", (e) => this.pointerMove(e));
    this.el.addEventListener("pointerup", (e) => this.pointerUp(e));
    this.el.addEventListener("pointercancel", () => (this.drag = null));
    this.el.addEventListener("contextmenu", (e) => {
      const cell = e.target.closest(".beat[data-i]");
      if (!cell) return;
      e.preventDefault();
      this.onEdit(Number(cell.dataset.i), e.clientX, e.clientY);
    });
    const markUserScroll = () => (this.userScrolledAt = performance.now());
    window.addEventListener("wheel", markUserScroll, { passive: true });
    window.addEventListener("touchmove", markUserScroll, { passive: true });
  }

  /** Build the grid. `beatPos` gives each beat's position in its bar (1 = downbeat). */
  build(beatPos, beatsPerBar) {
    this.el.style.setProperty("--bpb", beatsPerBar);
    this.el.innerHTML = "";
    this.cells = [];
    this.bars = [];
    this.current = -1;
    this.lastScrollRow = null;

    let bar = null;
    let barNumber = 0;
    let prevPos = 0;
    let firstInBar = true;
    const newBar = () => {
      barNumber++;
      bar = document.createElement("div");
      bar.className = "measure";
      bar.innerHTML = `<span class="bar-num">${barNumber}</span>`;
      this.el.append(bar);
      this.bars.push(bar);
      return bar;
    };

    beatPos.forEach((pos, i) => {
      if (!bar || pos === 1 || pos <= prevPos) {
        newBar();
        firstInBar = true;
        // Pad a pickup bar so beats line up with their position.
        for (let p = 1; p < pos; p++) bar.append(padCell());
      }
      prevPos = pos;
      const cell = document.createElement("div");
      cell.className = firstInBar ? "beat bar-first" : "beat";
      firstInBar = false;
      cell.dataset.i = i;
      cell.innerHTML = `<span class="chord"></span>`;
      bar.append(cell);
      this.cells.push(cell);
    });
    if (bar) {
      const filled = bar.querySelectorAll(".beat").length;
      for (let k = filled; k < beatsPerBar; k++) bar.append(padCell());
    }
  }

  /** Show chord names. `ids` decides where a chord changes; `names` is the text. */
  setChords(names, ids) {
    this.cells.forEach((cell, i) => {
      const changed = i === 0 || ids[i] !== ids[i - 1];
      const barStart = cell.classList.contains("bar-first");
      const label = cell.firstElementChild;
      cell.classList.toggle("change", changed);
      cell.classList.toggle("cont", !changed && barStart);
      cell.classList.toggle("nc", ids[i] === "N");
      label.textContent = changed || barStart ? names[i] : "";
    });
  }

  setCurrent(index) {
    if (index === this.current) return;
    const prev = this.cells[this.current];
    if (prev) {
      prev.classList.remove("current");
      prev.parentElement.classList.remove("current-bar");
    }
    this.current = index;
    const cell = this.cells[index];
    if (cell) {
      cell.classList.add("current");
      cell.parentElement.classList.add("current-bar");
      this.autoScroll(cell);
    }
  }

  setSelection(sel) {
    this.selection = sel;
    this.cells.forEach((cell, i) => {
      const inSel = !!sel && i >= sel.from && i <= sel.to;
      cell.classList.toggle("sel", inSel);
      cell.classList.toggle("sel-start", inSel && i === sel.from);
      cell.classList.toggle("sel-end", inSel && i === sel.to);
    });
  }

  setLoopActive(active) {
    this.el.classList.toggle("loop-on", active);
  }

  autoScroll(cell) {
    if (this.drag) return;
    if (performance.now() - this.userScrolledAt < USER_SCROLL_GRACE_MS) return;
    const rowTop = cell.parentElement.offsetTop;
    if (rowTop === this.lastScrollRow) return;
    this.lastScrollRow = rowTop;

    const scroller = scrollParent(this.el);
    const view = scroller === document.scrollingElement
      ? { top: 0, bottom: window.innerHeight }
      : scroller.getBoundingClientRect();
    const rect = cell.parentElement.getBoundingClientRect();
    const height = view.bottom - view.top;
    // Keep the current bar in the upper-middle band of the view.
    if (rect.top < view.top + height * 0.15 || rect.bottom > view.top + height * 0.7) {
      const delta = rect.top - (view.top + height * 0.3);
      scroller.scrollBy({ top: delta, behavior: "smooth" });
    }
  }

  // ------------------------------------------------------------- pointer

  cellAt(x, y) {
    const el = document.elementFromPoint(x, y)?.closest?.(".beat[data-i]");
    return el && this.el.contains(el) ? Number(el.dataset.i) : null;
  }

  pointerDown(e) {
    if (e.button !== 0) return;
    const cell = e.target.closest(".beat[data-i]");
    if (!cell) return;
    e.preventDefault();
    const i = Number(cell.dataset.i);
    this.drag = { anchor: i, last: i, moved: false, shift: e.shiftKey, prevSel: this.selection };
    this.el.setPointerCapture(e.pointerId);
  }

  pointerMove(e) {
    if (!this.drag) return;
    const i = this.cellAt(e.clientX, e.clientY);
    if (i === null || i === this.drag.last) return;
    this.drag.moved = true;
    this.drag.last = i;
    this.setSelection({ from: Math.min(this.drag.anchor, i), to: Math.max(this.drag.anchor, i) });
  }

  pointerUp(e) {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    if (this.el.hasPointerCapture(e.pointerId)) this.el.releasePointerCapture(e.pointerId);
    if (drag.moved) {
      this.onSelect({ from: Math.min(drag.anchor, drag.last), to: Math.max(drag.anchor, drag.last) });
    } else if (drag.shift && drag.prevSel) {
      const from = Math.min(drag.prevSel.from, drag.anchor);
      const to = Math.max(drag.prevSel.to, drag.anchor);
      this.onSelect({ from, to });
    } else {
      this.userScrolledAt = 0;
      this.onSeek(drag.anchor);
    }
  }
}

function padCell() {
  const pad = document.createElement("div");
  pad.className = "beat pad";
  return pad;
}

function scrollParent(el) {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
  }
  return document.scrollingElement;
}
