// Tiny i18n. Italian is the source text (keys); each other language is a JSON
// file in /i18n/<code>.json mapping Italian -> translation. The list of
// languages lives in /i18n/languages.json. Templates use {name} placeholders.
// Missing keys fall back to Italian.
//
// To add a language: add an entry to languages.json and create <code>.json.

const STORAGE_KEY = "accordario.lang";
const SOURCE = "it";

async function loadJSON(url, fallback) {
  try {
    const res = await fetch(url);
    if (res.ok) return await res.json();
  } catch {}
  return fallback;
}

export const languages = await loadJSON("i18n/languages.json", [{ code: SOURCE, name: "Italiano", flag: "🇮🇹" }]);

function detect() {
  const known = new Set(languages.map((l) => l.code));
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && known.has(saved)) return saved;
  } catch {}
  for (const tag of navigator.languages ?? [navigator.language]) {
    const code = String(tag).toLowerCase().split("-")[0];
    if (known.has(code)) return code;
  }
  return known.has("en") ? "en" : SOURCE;
}

export const lang = detect();
export const locale = languages.find((l) => l.code === lang)?.locale ?? lang;

const DICT = lang === SOURCE ? {} : await loadJSON(`i18n/${lang}.json`, {});

export function setLang(next) {
  try { localStorage.setItem(STORAGE_KEY, next); } catch {}
  location.reload();
}

function fill(str, vars) {
  return vars ? str.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : str;
}

/** Translate an Italian source string (or template) to the current language. */
export function t(key, vars) {
  if (key == null) return "";
  if (key in DICT) return fill(DICT[key], vars);
  // Server message with a queue position suffix, e.g. "… (3 prima)".
  const m = /^(.*?) \((\d+) prima\)$/.exec(key);
  if (m && m[1] in DICT) return `${DICT[m[1]]} ${t("({n} prima)", { n: m[2] })}`;
  return fill(key, vars);
}

/** Plural helper: tn(n, "{n} brano", "{n} brani"). */
export const tn = (n, one, many, vars = {}) => t(n === 1 ? one : many, { n, ...vars });

/** Translate the static page: text nodes and common attributes. */
export function translatePage(root = document.body) {
  document.documentElement.lang = lang;
  if (lang === SOURCE) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node; (node = walker.nextNode());) {
    const raw = node.nodeValue;
    const key = raw.trim();
    if (key && key in DICT) node.nodeValue = raw.replace(key, DICT[key]);
  }
  for (const attr of ["title", "placeholder", "aria-label"]) {
    root.querySelectorAll(`[${attr}]`).forEach((el) => {
      const v = el.getAttribute(attr);
      if (v in DICT) el.setAttribute(attr, DICT[v]);
    });
  }
}
