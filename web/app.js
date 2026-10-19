import { h, render } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

// ============================================================ api
class AuthError extends Error {}

// When the Mac can't be reached (it's off, asleep, or restarting), the app says so and since when.
let offlineSince = null;
function reachable(ok) {
  const next = ok ? null : offlineSince ?? Date.now();
  if (next === offlineSince) return;
  offlineSince = next;
  emit();
}
async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
  } catch (error) {
    reachable(false);
    throw new Error("Can't reach your Mac right now.");
  }
  // A proxy in front (Tailscale) answers 502/503/504 while Blip itself is down.
  reachable(![502, 503, 504].includes(res.status));
  if (res.status === 401) throw new AuthError("login required");
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

// ============================================================ native Mac app bridge
// Blip.app (mac-app/) injects window.webkit.messageHandlers.blip*; in a browser these are no-ops.
const nativeBridge = window.webkit?.messageHandlers;
function nativeNotify(title, body, silent = false) {
  try { nativeBridge?.blipNotify?.postMessage({ title, body: String(body || "").slice(0, 240), silent }); } catch {}
}
function nativeBadge(count) {
  try { nativeBridge?.blipBadge?.postMessage(count ? String(count) : ""); } catch {}
}

// ============================================================ store
const store = { state: null, threads: {}, unread: {}, toast: null, listeners: new Set() };
const emit = () => store.listeners.forEach((l) => l());
function useStore() {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((x) => x + 1);
    store.listeners.add(l);
    return () => store.listeners.delete(l);
  }, []);
  return store;
}
/** The phone's status bar color follows the app's theme (black unless Light, or Auto in light mode). */
function setThemeColor(t) {
  const light = t === "light" || (t === "auto" && matchMedia("(prefers-color-scheme: light)").matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", light ? "#ffffff" : "#000000");
}
let toastTimer;
function toast(text) {
  store.toast = text;
  emit();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    store.toast = null;
    emit();
  }, 2600);
}
const fail = (e) => toast(e?.message || String(e));

async function loadState() {
  store.state = await api("/state");
  nativeBadge(store.state.runtime?.pendingCards);
  emit();
}
let stateTimer;
function reloadStateSoon() {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(() => loadState().catch(() => {}), 250);
}
// Messages that arrive while a thread is loading are kept and merged in, so a reply never goes missing.
const loading = {};
const KEEP = 400;
const mergeById = (base, extra) => {
  const next = [...base];
  for (const m of extra) {
    const i = next.findIndex((x) => x.id === m.id);
    if (i >= 0) next[i] = m;
    else next.push(m);
  }
  return next.slice(-KEEP);
};
// Every message id the app has already shown, so updates (run steps, answered cards) never count as new.
const seen = new Set();
const markSeen = (list) => {
  for (const m of list) seen.add(m.id);
  if (seen.size > 5000) [...seen].slice(0, 2000).forEach((id) => seen.delete(id));
};
async function loadThread(botId) {
  loading[botId] ??= [];
  try {
    const { messages } = await api(`/thread/${botId}`);
    const merged = mergeById(messages, loading[botId]);
    markSeen(merged);
    store.threads = { ...store.threads, [botId]: merged };
    emit();
  } finally {
    delete loading[botId];
  }
}
/** Like loadThread, but only re-renders when something changed (used when the live stream can't get through). */
async function pollThread(botId) {
  const { messages } = await api(`/thread/${botId}`).catch(() => ({}));
  if (!messages) return;
  const old = store.threads[botId];
  if (old) for (const m of messages) if (!seen.has(m.id)) upsert(m, true); // notifications and unread still work
  if (JSON.stringify(messages) === JSON.stringify(store.threads[botId])) return;
  markSeen(messages);
  store.threads = { ...store.threads, [botId]: messages };
  emit();
}
function upsert(m, live) {
  const list = store.threads[m.botId];
  if (list) store.threads = { ...store.threads, [m.botId]: mergeById(list, [m]) };
  else if (loading[m.botId]) loading[m.botId].push(m);
  const isNew = !seen.has(m.id);
  seen.add(m.id);
  const bot = store.state?.bots.find((b) => b.id === m.botId);
  if (live && isNew && m.role !== "user" && m.kind !== "run" && m.botId !== selectedBot()) {
    store.unread = { ...store.unread, [m.botId]: (store.unread[m.botId] || 0) + 1 };
  }
  if (live && isNew && m.role !== "user" && (m.kind === "text" || m.kind === "card")) {
    const name = bot?.name || "Blip";
    if (m.kind === "card") nativeNotify(m.card.type === "suggestion" ? `${name} has a suggestion` : `${name} needs you`, m.card.title);
    else if (m.role === "bot" && m.text) nativeNotify(name, m.text, !!bot?.quiet);
  }
  if (live && isNew && m.role === "bot" && m.kind === "text" && m.meta?.voice && m.text) speakText(m.text);
  emit();
}
let selected = null;
const selectedBot = () => selected;

// ============================================================ voice out
// The most natural voice on this device (Premium/Enhanced/Siri voices sound far less robotic), spoken one
// sentence at a time (iPhone cuts long utterances off). `speechDone` lets talk mode wait until it's finished.
let speechDone = Promise.resolve();
function bestVoice() {
  if (!("speechSynthesis" in window)) return null;
  const all = speechSynthesis.getVoices();
  const lang = (navigator.language || "en-US").slice(0, 2);
  const pool = all.filter((v) => v.lang?.toLowerCase().startsWith(lang));
  const list = pool.length ? pool : all;
  return list.find((v) => /premium|neural|natural/i.test(v.name)) || list.find((v) => /enhanced|siri/i.test(v.name)) || list.find((v) => v.default) || list[0] || null;
}
if ("speechSynthesis" in window) speechSynthesis.getVoices(); // voices load in the background on some browsers
function speakText(text) {
  if (!("speechSynthesis" in window)) return Promise.resolve();
  const clean = text.replace(/```[\s\S]*?```/g, " ").replace(/[•*_#`>]/g, "").replace(/https?:\/\/\S+/g, "link").slice(0, 2500);
  const parts = clean.match(/[^.!?\n]+[.!?]*\s*/g)?.map((p) => p.trim()).filter(Boolean) ?? [];
  speechDone = new Promise((resolve) => {
    if (!parts.length) return resolve();
    const voice = bestVoice();
    parts.forEach((p, i) => {
      const u = new SpeechSynthesisUtterance(p);
      if (voice) u.voice = voice;
      u.rate = 1.05;
      if (i === parts.length - 1) u.onend = u.onerror = () => resolve();
      speechSynthesis.speak(u);
    });
    setTimeout(resolve, 3 * 60_000); // never wait forever
  });
  return speechDone;
}

// ============================================================ voice in: talk mode
/** Records one spoken message: starts when you speak, ends after a short silence. Null if nobody spoke. */
function recordUtterance(stream, stillOn) {
  return new Promise((resolve) => {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const mr = new MediaRecorder(stream);
    const chunks = [];
    mr.ondataavailable = (e) => chunks.push(e.data);
    let floor = 0.01, samples = 0, spoke = false, lastVoice = Date.now();
    const started = Date.now();
    const finish = (keep) => {
      clearInterval(tick);
      mr.onstop = () => {
        ctx.close().catch(() => {});
        resolve(keep && chunks.length ? new Blob(chunks, { type: mr.mimeType }) : null);
      };
      if (mr.state !== "inactive") mr.stop();
      else mr.onstop();
    };
    const tick = setInterval(() => {
      if (!stillOn()) return finish(false);
      analyser.getFloatTimeDomainData(buf);
      const rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);
      if (samples < 4) { floor = Math.max(floor, rms); samples++; return; } // the room's own noise first
      const loud = rms > Math.max(0.02, floor * 2.5);
      if (loud) { spoke = true; lastVoice = Date.now(); }
      const now = Date.now();
      if (spoke && now - lastVoice > 1200) finish(true); // you paused: that's the message
      else if (!spoke && now - started > 20_000) finish(false); // nobody spoke: listen again
      else if (now - started > 60_000) finish(spoke);
    }, 100);
    mr.start();
  });
}

// ============================================================ helpers
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const fmtDay = (ts) => new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const money = (n) => `$${(n || 0).toFixed(2)}`;
function dur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
function ago(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}
const bytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const fileUrl = (p, download) => `/api/file?path=${encodeURIComponent(p)}${download ? "&download=1" : ""}`;
const isImage = (p) => /\.(png|jpe?g|gif|webp)$/i.test(p);
const shortModel = (m) => (!m || m === "auto" ? "Auto" : m).replace(/^claude-/, "").replace(/-(\d)-(\d)$/, " $1.$2").replace(/-(\d)$/, " $1");
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function inline(s) {
  return s
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
}
function md(text) {
  return text
    .split(/```[\w-]*\n?([\s\S]*?)```/g)
    .map((part, i) => (i % 2 ? `<pre>${esc(part)}</pre>` : inline(esc(part))))
    .join("");
}
function useNow(active, every = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [active, every]);
  return now;
}
const readAsBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
const coarse = window.matchMedia("(pointer: coarse)").matches;

// ============================================================ icons
const svg = (d, extra = "") => html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" ...${extra ? { style: extra } : {}}>${d}</svg>`;
const I = {
  menu: () => svg(html`<path d="M4 7h16M4 12h16M4 17h16" />`),
  plus: () => svg(html`<path d="M12 5v14M5 12h14" />`),
  send: () => svg(html`<path d="M12 19V5M5 12l7-7 7 7" />`),
  stop: () => svg(html`<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />`),
  mic: () => svg(html`<rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />`),
  clip: () => svg(html`<path d="M21 11.5 12.5 20a5 5 0 0 1-7-7L14 4.5a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7.5" />`),
  computer: () => svg(html`<rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" />`),
  files: () => svg(html`<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" />`),
  brain: () => svg(html`<path d="M9 4a3 3 0 0 0-3 3v.5A3 3 0 0 0 4 10.3 3 3 0 0 0 5 15a3 3 0 0 0 4 4.8V4zM15 4a3 3 0 0 1 3 3v.5a3 3 0 0 1 2 2.8 3 3 0 0 1-1 4.7 3 3 0 0 1-4 4.8V4z" />`),
  more: () => svg(html`<circle cx="5" cy="12" r="1.3" fill="currentColor" /><circle cx="12" cy="12" r="1.3" fill="currentColor" /><circle cx="19" cy="12" r="1.3" fill="currentColor" />`),
  close: () => svg(html`<path d="M6 6l12 12M18 6 6 18" />`),
  chevron: () => svg(html`<path d="M9 6l6 6-6 6" />`),
  clock: () => svg(html`<circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />`),
  book: () => svg(html`<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z" /><path d="M4 19V5" />`),
  pulse: () => svg(html`<path d="M3 12h4l3-8 4 16 3-8h4" />`),
  gear: () => svg(html`<circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />`),
  wave: () => svg(html`<path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" />`),
  download: () => svg(html`<path d="M12 4v11M7 10l5 5 5-5M5 20h14" />`),
  trash: () => svg(html`<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />`),
  play: () => svg(html`<path d="M7 5v14l11-7z" fill="currentColor" />`),
  new: () => svg(html`<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />`),
  up: () => svg(html`<path d="M7 11v9H4v-9zM7 11l4-8a2 2 0 0 1 2 2v4h5.5a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 17.3 20H7" />`),
  down: () => svg(html`<path d="M7 13V4H4v9zM7 13l4 8a2 2 0 0 0 2-2v-4h5.5a2 2 0 0 0 2-2.3l-1.2-7A2 2 0 0 0 17.3 4H7" />`),
  check: () => svg(html`<path d="M5 12.5 10 17 19 7" />`),
  okCircle: () => svg(html`<circle cx="12" cy="12" r="9" /><path d="m8.5 12.2 2.4 2.4 4.6-4.9" />`),
  xCircle: () => svg(html`<circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" />`),
  pauseCircle: () => svg(html`<circle cx="12" cy="12" r="9" /><path d="M10 9v6M14 9v6" />`),
  dash: () => svg(html`<circle cx="12" cy="12" r="9" /><path d="M8.5 12h7" />`),
};
// Blip, the mascot: a mouse pointer that came alive. Its state (idle, working, needs, done, sleep) is CSS-driven.
// Every bot can dress its Blip differently: body color, hat, eyewear, facial hair, neckwear and something to hold.
const OUT = 'stroke="#56565e" stroke-width="2"';
const BTC = (x, y, size) => `<text x="${x}" y="${y}" font-size="${size}" font-weight="800" text-anchor="middle" fill="#fff" font-family="Arial, Helvetica, sans-serif">₿</text>`;
const LOOKS = {
  color: [
    { id: "classic", label: "Classic" },
    { id: "gold", label: "Gold", body: "#f6d77a" },
    { id: "mint", label: "Mint", body: "#a7ecd0" },
    { id: "sky", label: "Sky", body: "#a9d4ff" },
    { id: "pink", label: "Pink", body: "#ffbdd0" },
    { id: "lilac", label: "Lilac", body: "#d2c2ff" },
    { id: "peach", label: "Peach", body: "#ffc9a3" },
  ],
  hat: [
    { id: "none", label: "None" },
    { id: "tophat", label: "Top hat", top: 2, svg: `<rect x="50" y="2" width="30" height="26" rx="3" fill="#1b1b1f" ${OUT}/><rect x="50" y="20" width="30" height="5" fill="#e5484d"/><ellipse cx="65" cy="30" rx="23" ry="5" fill="#1b1b1f" ${OUT}/>` },
    { id: "cap", label: "₿ cap", top: 10, svg: `<path d="M48 31 Q49 10 67 10 Q84 10 86 29 Z" fill="#1b1b1f" ${OUT}/><path d="M80 29 Q99 26 108 33 Q94 37 80 34 Z" fill="#1b1b1f" ${OUT}/><circle cx="66" cy="21" r="6.5" fill="#f7931a"/>${BTC(66, 24.6, 9.5)}` },
    { id: "beanie", label: "Beanie", top: -2, svg: `<path d="M47 30 Q47 6 66 6 Q85 6 85 30 Z" fill="#e5484d"/><rect x="45" y="24" width="42" height="9" rx="4.5" fill="#b9343a"/><circle cx="66" cy="4" r="6" fill="#f4f4f6"/>` },
    { id: "party", label: "Party", top: -16, svg: `<path d="M50 32 L66 -10 L82 32 Z" fill="#f2a93b"/><path d="M57 11 L75 11 M53 22 L79 22" stroke="#ff8aa0" stroke-width="5"/><circle cx="66" cy="-10" r="5" fill="#fff"/>` },
    { id: "crown", label: "Crown", top: 3, svg: `<path d="M48 32 L49 10 L58 21 L66 4 L74 21 L83 10 L84 32 Z" fill="#f5c542" stroke="#c99a1e" stroke-width="2" stroke-linejoin="round"/><circle cx="66" cy="25" r="3.2" fill="#e5484d"/><circle cx="55" cy="27" r="2.2" fill="#3b82f6"/><circle cx="77" cy="27" r="2.2" fill="#3b82f6"/>` },
    { id: "wizard", label: "Wizard", top: -28, svg: `<path d="M50 30 Q60 0 74 -26 Q76 2 84 30 Z" fill="#4f46e5"/><ellipse cx="66" cy="31" rx="26" ry="5" fill="#4338ca"/><path d="M66 6 l1.6 3.4 3.6.4 -2.7 2.4 .8 3.6 -3.3 -1.9 -3.3 1.9 .8 -3.6 -2.7 -2.4 3.6 -.4z" fill="#f5c542"/><circle cx="72" cy="-6" r="1.6" fill="#f5c542"/><circle cx="61" cy="19" r="1.4" fill="#f5c542"/>` },
    { id: "cowboy", label: "Cowboy", top: 4, svg: `<path d="M54 26 Q54 6 66 8 Q78 6 78 26 Z" fill="#8b5a2b"/><path d="M38 26 Q66 38 94 26 Q90 34 66 34 Q42 34 38 26 Z" fill="#a0692f"/><rect x="54" y="21" width="24" height="4" fill="#5c3a1a"/>` },
    { id: "chef", label: "Chef", top: -6, svg: `<circle cx="56" cy="12" r="9" fill="#fff" stroke="#c8c8ce" stroke-width="2"/><circle cx="76" cy="12" r="9" fill="#fff" stroke="#c8c8ce" stroke-width="2"/><circle cx="66" cy="6" r="11" fill="#fff" stroke="#c8c8ce" stroke-width="2"/><rect x="52" y="14" width="28" height="17" rx="2" fill="#fff"/><rect x="52" y="18" width="28" height="13" rx="2" fill="none" stroke="#c8c8ce" stroke-width="2"/>` },
    { id: "headphones", label: "Headphones", top: 2, svg: `<path d="M50 50 Q50 6 70 6 Q92 6 90 46" fill="none" stroke="#2b2b31" stroke-width="6" stroke-linecap="round"/><rect x="44" y="40" width="12" height="20" rx="5" fill="#ff8aa0"/><rect x="84" y="36" width="12" height="20" rx="5" fill="#ff8aa0" transform="rotate(-40 90 46)"/>` },
    { id: "halo", label: "Halo", top: 2, svg: `<ellipse cx="66" cy="10" rx="19" ry="5" fill="none" stroke="#f5c542" stroke-width="4"/>` },
    { id: "propeller", label: "Propeller", top: -4, svg: `<path d="M48 30 Q48 10 66 10 Q84 10 84 30 Z" fill="#3b82f6"/><path d="M48 30 Q48 10 66 10 L66 30 Z" fill="#f2a93b"/><rect x="65" y="1" width="2" height="10" fill="#56565e"/><ellipse cx="57" cy="1" rx="9" ry="2.6" fill="#e5484d"/><ellipse cx="75" cy="1" rx="9" ry="2.6" fill="#22c55e"/>` },
  ],
  eyes: [
    { id: "none", label: "None" },
    { id: "glasses", label: "Glasses", svg: `<g fill="rgba(255,255,255,0.18)" stroke="#1b1b1f" stroke-width="2.6"><circle cx="84.5" cy="98" r="10"/><circle cx="109.5" cy="98" r="10"/></g><path d="M94.5 97 Q97 94.5 99.5 97" stroke="#1b1b1f" stroke-width="2.6" fill="none"/>` },
    { id: "shades", label: "Shades", svg: `<g fill="#0b0b0c"><rect x="72" y="90" width="24" height="15" rx="6"/><rect x="98" y="90" width="24" height="15" rx="6"/></g><path d="M95 95 L99 95" stroke="#0b0b0c" stroke-width="3"/><path d="M76 94 l5 0 M102 94 l5 0" stroke="rgba(255,255,255,0.55)" stroke-width="2" stroke-linecap="round"/>` },
    { id: "nerd", label: "Nerd", svg: `<g fill="none" stroke="#1b1b1f" stroke-width="4"><rect x="73" y="89" width="23" height="18" rx="3"/><rect x="98" y="89" width="23" height="18" rx="3"/></g><path d="M96 96 L98 96" stroke="#1b1b1f" stroke-width="4"/>` },
    { id: "monocle", label: "Monocle", svg: `<circle cx="109.5" cy="98" r="10" fill="rgba(255,255,255,0.15)" stroke="#c99a1e" stroke-width="2.6"/><path d="M118 104 Q124 116 120 128" stroke="#c99a1e" stroke-width="1.6" fill="none"/>` },
    { id: "hearts", label: "Heart eyes", svg: `<g fill="#e5484d"><path d="M84.5 107 C73 99 74 88 80 88.5 C83 88.5 84.5 92 84.5 92 C84.5 92 86 88.5 89 88.5 C95 88 96 99 84.5 107Z"/><path d="M109.5 107 C98 99 99 88 105 88.5 C108 88.5 109.5 92 109.5 92 C109.5 92 111 88.5 114 88.5 C120 88 121 99 109.5 107Z"/></g>` },
  ],
  face: [
    { id: "none", label: "None" },
    { id: "mustache", label: "Handlebar", over: `<path d="M97 108 C92 103.5 84 103.5 80.5 109 C79 112.5 75 112.5 74.5 109.5 C76 116 86 117 97 112 C108 117 118 116 119.5 109.5 C119 112.5 115 112.5 113.5 109 C110 103.5 102 103.5 97 108 Z" fill="#3a2a1e"/>` },
    { id: "chevron", label: "Chevron", over: `<path d="M83 110 Q97 99 111 110 Q104 114 97 110.5 Q90 114 83 110Z" fill="#3a2a1e"/>` },
    { id: "beard", label: "Beard", under: `<path d="M75 106 Q76 137 97 141 Q118 137 119 106 Q112 121 97 122 Q82 121 75 106Z" fill="#3a2a1e"/>`, over: `<path d="M86 110 Q97 103 108 110 Q102 113 97 111 Q92 113 86 110Z" fill="#3a2a1e"/>` },
    { id: "goatee", label: "Goatee", under: `<path d="M91 120 Q97 135 103 120 Q97 123.5 91 120Z" fill="#3a2a1e"/>` },
    { id: "freckles", label: "Freckles", over: `<g fill="#c58b6a"><circle cx="70" cy="104" r="1.3"/><circle cx="74" cy="102" r="1.3"/><circle cx="73" cy="106" r="1.3"/><circle cx="120" cy="104" r="1.3"/><circle cx="124" cy="102" r="1.3"/><circle cx="123" cy="106" r="1.3"/></g>` },
  ],
  neck: [
    { id: "none", label: "None" },
    { id: "bowtie", label: "Bow tie", svg: `<path d="M97 126 L84 119 L84 133 Z M97 126 L110 119 L110 133 Z" fill="#e5484d"/><circle cx="97" cy="126" r="3.4" fill="#b9343a"/>` },
    { id: "tie", label: "Tie", svg: `<path d="M93 121 L101 121 L99 127 L95 127Z" fill="#3b82f6"/><path d="M95 127 L99 127 L103 150 L97 156 L92 150Z" fill="#3b82f6"/>` },
    { id: "btc-chain", label: "₿ chain", svg: `<path d="M74 114 Q97 132 120 114" fill="none" stroke="#f5c542" stroke-width="2.4" stroke-dasharray="3 2"/><circle cx="97" cy="131" r="8.5" fill="#f7931a" stroke="#c97a12" stroke-width="1.6"/>${BTC(97, 135, 11)}` },
    { id: "gold-chain", label: "Gold chain", svg: `<path d="M74 114 Q97 134 120 114" fill="none" stroke="#f5c542" stroke-width="3.2" stroke-linecap="round" stroke-dasharray="4 2.5"/>` },
    { id: "scarf", label: "Scarf", svg: `<path d="M72 116 Q97 128 122 116 L122 124 Q97 136 72 124Z" fill="#e5484d"/><path d="M108 126 L114 146 L106 147 L102 128Z" fill="#b9343a"/>` },
  ],
  hold: [
    { id: "none", label: "None" },
    { id: "coin", label: "Bitcoin", svg: `<circle cx="150" cy="140" r="15" fill="#f7931a" stroke="#c97a12" stroke-width="2"/>${BTC(150, 146.5, 18)}` },
    { id: "coffee", label: "Coffee", svg: `<rect x="138" y="132" width="20" height="22" rx="4" fill="#f4f4f6" stroke="#c8c8ce" stroke-width="2"/><path d="M158 137 Q166 139 158 147" fill="none" stroke="#c8c8ce" stroke-width="3"/><rect x="139" y="133" width="18" height="5" fill="#8b5a2b"/><path d="M144 126 q-3 -4 0 -8 M152 126 q-3 -4 0 -8" stroke="#8f8f97" stroke-width="2" fill="none" stroke-linecap="round"/>` },
    { id: "phone", label: "Phone", svg: `<rect x="140" y="124" width="20" height="34" rx="4" fill="#1b1b1f" ${OUT}/><rect x="143" y="129" width="14" height="22" rx="1.5" fill="#3b82f6"/>` },
    { id: "flower", label: "Flower", svg: `<path d="M150 160 Q148 146 150 134" stroke="#22c55e" stroke-width="3" fill="none"/><g fill="#ff8aa0"><circle cx="150" cy="124" r="5"/><circle cx="157" cy="129" r="5"/><circle cx="154" cy="137" r="5"/><circle cx="146" cy="137" r="5"/><circle cx="143" cy="129" r="5"/></g><circle cx="150" cy="131" r="4" fill="#f5c542"/>` },
    { id: "balloon", label: "Balloon", svg: `<path d="M150 170 Q146 150 152 136" stroke="#8f8f97" stroke-width="1.5" fill="none"/><ellipse cx="154" cy="120" rx="13" ry="16" fill="#e5484d"/><path d="M152 136 l4 0 -2 -3z" fill="#b9343a"/>` },
    { id: "wand", label: "Magic wand", svg: `<path d="M136 160 L156 128" stroke="#2b2b31" stroke-width="4" stroke-linecap="round"/><path d="M158 112 l3 7 7 1 -5 5 1.5 7 -6.5 -3.5 -6.5 3.5 1.5 -7 -5 -5 7 -1z" fill="#f5c542"/>` },
  ],
};
const LOOK_PARTS = ["color", "hat", "eyes", "face", "neck", "hold"];
const pick = (part, id) => LOOKS[part].find((o) => o.id === id) || LOOKS[part][0];

const svgCache = new Map();
function blipSvg(look = {}, tight = false) {
  const key = JSON.stringify([look, tight]);
  if (svgCache.has(key)) return svgCache.get(key);
  const hat = pick("hat", look.hat), eyes = pick("eyes", look.eyes), face = pick("face", look.face);
  const neck = pick("neck", look.neck), hold = pick("hold", look.hold);
  // "tight" crops to the character (avatars, logo) so the face reads at small sizes; tall hats widen the crop.
  const top = Math.min(26, (hat.top ?? 26) + 1);
  const sz = 182 - top;
  const viewBox = tight ? `${110 - sz / 2} ${top} ${sz} ${sz}` : "0 0 200 200";
  const out = `<svg viewBox="${viewBox}" aria-hidden="true">
  <g class="fx-work"><circle class="fx-ring ripple" cx="62" cy="36" r="14"/><circle class="fx-ring ripple" cx="62" cy="36" r="14"/></g>
  <g class="g-body">
    <path class="bd" d="M62 34 L62 158 L94 128 L114 172 L136 162 L116 120 L158 120 Z" stroke-width="18" stroke-linejoin="round"/>
    ${face.under || ""}${neck.svg || ""}
    <g class="eyes-open"><ellipse class="ink eo" cx="84.5" cy="98" rx="5.6" ry="7.4"/><ellipse class="ink eo" cx="109.5" cy="98" rx="5.6" ry="7.4"/>
      <circle class="hl eo" cx="86.5" cy="95" r="1.8"/><circle class="hl eo" cx="111.5" cy="95" r="1.8"/></g>
    <path class="inks eh" d="M78.9 100 Q84.5 90.6 90.1 100 M103.9 100 Q109.5 90.6 115.1 100"/>
    <path class="inks ec" d="M78.9 98 Q84.5 102.4 90.1 98 M103.9 98 Q109.5 102.4 115.1 98"/>
    <ellipse class="ck" cx="73.9" cy="109.4" rx="6.5" ry="4"/><ellipse class="ck" cx="120.1" cy="109.4" rx="6.5" ry="4"/>
    <path class="inks mo-smile" d="M92 112 Q97 117 102 112"/>
    <ellipse class="ink mo-o" cx="97" cy="114" rx="3.6" ry="4.4"/>
    <path class="ink mo-big" d="M89 111 Q97 123 105 111 Z"/>
    ${face.over || ""}${eyes.svg || ""}${hat.svg ? `<g transform="translate(-1 5)">${hat.svg}</g>` : ""}${hold.svg || ""}
  </g>
  <g class="bang"><rect x="132" y="60" width="26" height="30" rx="9"/><path d="M142.5 66 h5 l-1 12 h-3 z M145 81 a2.6 2.6 0 1 0 0.01 0z"/></g>
  <g class="spark-g"><path class="spark" d="M150 40 l3 -9 3 9 9 3 -9 3 -3 9 -3 -9 -9 -3z"/><path class="spark" d="M30 70 l2.4 -7 2.4 7 7 2.4 -7 2.4 -2.4 7 -2.4 -7 -7 -2.4z"/><path class="spark" d="M166 150 l2 -6 2 6 6 2 -6 2 -2 6 -2 -6 -6 -2z"/></g>
  <g class="zz-g"><text class="zz" x="140" y="58">z</text><text class="zz" x="152" y="44" style="font-size:16px">z</text></g>
</svg>`;
  svgCache.set(key, out);
  return out;
}
function Blip({ size, state = "idle", still = false, tight = false, look }) {
  const tint = look?.color ? pick("color", look.color).body : null;
  const style = `${size ? `width:${size}px;` : ""}${tint ? `--m-body:${tint};--m-ink:#0b0b0c;` : ""}`;
  return html`<div class=${`m ${still ? "still" : ""}`} data-state=${state} style=${style} dangerouslySetInnerHTML=${{ __html: blipSvg(look, tight) }} />`;
}
const Mark = () => html`<${Blip} size=${26} still tight />`;
// Every mascot blinks together off one class toggle, so the SVGs only repaint during the blink.
if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
  setInterval(() => {
    document.documentElement.classList.add("blink");
    setTimeout(() => document.documentElement.classList.remove("blink"), 150);
  }, 4600);
}

// ============================================================ small components
/** A group chat, shown like a bot: its members' avatars overlapping, the lead in front. */
function groupAsBot(g, st) {
  const members = g.members.map((id) => st.bots.find((b) => b.id === id)).filter(Boolean);
  const lead = members.find((b) => b.id === g.leadId) || members[0];
  return { id: g.id, name: g.name, group: g, members, lead, look: lead?.look, job: members.map((m) => m.name).join(", "), running: g.running, waiting: g.waiting, step: g.running ? "Working…" : null, model: lead?.model || "auto" };
}
const botById = (id) => store.state?.bots.find((b) => b.id === id);

function Avatar({ bot, size = 34, status, still }) {
  if (bot?.group) {
    const [a, b] = [bot.lead, bot.members.find((m) => m.id !== bot.lead?.id)];
    return html`<div class="avatar group-avatar" title=${bot.name} style=${`width:${size}px;height:${size}px`}>
      ${b ? html`<span class="ga back"><${Blip} still tight look=${b.look} /></span>` : null}
      <span class="ga front"><${Blip} still=${still} tight look=${a?.look} state=${status === "live" ? "working" : status === "wait" ? "needs" : "idle"} /></span>
      ${status ? html`<span class=${`dot ${status}`} />` : null}
    </div>`;
  }
  const mood = status === "live" ? "working" : status === "wait" ? "needs" : "idle";
  return html`<div class="avatar" title=${bot?.name} style=${`width:${size}px;height:${size}px`}>
    <${Blip} state=${mood} still=${still} tight look=${bot?.look} />${status ? html`<span class=${`dot ${status}`} />` : null}
  </div>`;
}
const Switch = ({ on, onChange }) => html`<button class=${`switch ${on ? "on" : ""}`} role="switch" aria-checked=${on} onClick=${() => onChange(!on)} />`;
function Seg({ value, options, onChange }) {
  return html`<div class="seg">${options.map(([v, label]) => html`<button class=${v === value ? "on" : ""} onClick=${() => onChange(v)}>${label}</button>`)}</div>`;
}
function Sheet({ title, onClose, children, actions }) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && close.current();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return html`<div class="overlay" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="sheet" role="dialog" aria-label=${title}>
      <div class="sheet-head"><h2>${title}</h2>${actions}<button class="icon-btn" onClick=${onClose} aria-label="Close"><${I.close} /></button></div>
      <div class="sheet-body">${children}</div>
    </div>
  </div>`;
}
function useLoad(fn, deps) {
  const [data, setData] = useState(null);
  const [tick, setTick] = useState(0);
  // Different deps (another bot) start empty, so one bot's data never shows under another's name.
  const key = JSON.stringify(deps);
  const lastKey = useRef(key);
  if (lastKey.current !== key) {
    lastKey.current = key;
    if (data !== null) setData(null);
  }
  useEffect(() => {
    let alive = true;
    fn().then((d) => alive && setData(d)).catch(fail);
    return () => (alive = false);
  }, [...deps, tick]);
  return [data, () => setTick((t) => t + 1)];
}

function botStatus(bot, st) {
  const rt = st.runtime;
  if (bot.running) return bot.waiting ? { cls: "wait", dot: "wait", text: "Waiting for you" } : { cls: "live", dot: "live", text: bot.step || "Working…" };
  if (bot.queued) return { cls: "", dot: "", text: `${bot.queued} queued` };
  return { cls: "", dot: null, text: bot.job };
}

// ============================================================ login
function Login({ onDone }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const failed = new URLSearchParams(location.search).get("login") === "failed";
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/login", { method: "POST", body: { code: code.trim() } });
      onDone();
    } catch {
      toast("That code didn't work");
    } finally {
      setBusy(false);
    }
  };
  return html`<div class="login"><form class="login-box" onSubmit=${submit}>
    <div style="margin:0 auto"><${Blip} size=${84} /></div>
    <h1>Blip</h1>
    <p>${failed ? "That link didn't work. " : ""}On your Mac, open Blip and go to <b>Settings → Connect your phone</b>. Type the 6-digit code it shows.</p>
    <input class="input" style="text-align:center;font-size:20px;letter-spacing:0.18em;height:52px" placeholder="000 000" value=${code} onInput=${(e) => setCode(e.target.value)} autocomplete="one-time-code" inputmode="text" autofocus />
    <p class="hint">Or paste the access code from <code>~/Blip/blip.sh link</code>.</p>
    <button class="btn primary" disabled=${!code.trim() || busy}>${busy ? "Checking…" : "Open"}</button>
  </form></div>`;
}

// ============================================================ sidebar
function Sidebar({ st, open, onSelect, onSheet, onClose }) {
  const { budget } = st;
  const pct = Math.min(100, (budget.today / budget.limit) * 100);
  return html`<aside class=${`sidebar ${open ? "open" : ""}`}>
    <div class="brand"><${Mark} />Blip</div>
    <button class="new-btn" onClick=${() => onSheet({ type: "newbot" })}><${I.plus} /> New bot</button>
    <div class="side-scroll">
      <div>
        <div class="side-label">Bots</div>
        ${st.bots.map((b) => {
          const s = botStatus(b, st);
          const unread = store.unread[b.id];
          const waiting = b.waiting || (store.threads[b.id] || []).filter((m) => m.card?.status === "pending").length;
          return html`<button class=${`bot-row ${b.id === selected ? "active" : ""}`} onClick=${() => onSelect(b.id)}>
            <${Avatar} bot=${b} size=${36} status=${s.dot} />
            <div class="meta">
              <div class="name">${b.name}${b.id === st.primaryBotId ? html`<span class="chip" style="padding:0 6px;font-size:10.5px">Primary</span>` : null}</div>
              <div class=${`sub ${s.cls}`}>${s.text}</div>
            </div>
            ${waiting ? html`<span class="badge" title="Waiting for you">${waiting}</span>` : unread ? html`<span class="badge neutral">${unread}</span>` : null}
          </button>`;
        })}
      </div>
      <div>
        <div class="side-label">Groups</div>
        ${(st.groups || []).map((g) => {
          const gb = groupAsBot(g, st);
          const s = botStatus(gb, st);
          const unread = store.unread[g.id];
          return html`<button class=${`bot-row ${g.id === selected ? "active" : ""}`} onClick=${() => onSelect(g.id)}>
            <${Avatar} bot=${gb} size=${36} status=${s.dot} />
            <div class="meta"><div class="name">${g.name}</div><div class=${`sub ${s.cls}`}>${g.running ? s.text : gb.job}</div></div>
            ${g.waiting ? html`<span class="badge" title="Waiting for you">${g.waiting}</span>` : unread ? html`<span class="badge neutral">${unread}</span>` : null}
          </button>`;
        })}
        ${st.bots.length >= 2 ? html`<button class="nav-row" onClick=${() => onSheet({ type: "newgroup" })}><${I.plus} /> New group</button>` : null}
      </div>
      <div>
        <div class="side-label">Workspace</div>
        <button class="nav-row" onClick=${() => onSheet({ type: "routines" })}><${I.clock} /> Routines</button>
        <button class="nav-row" onClick=${() => onSheet({ type: "skills" })}><${I.book} /> Skills</button>
        <button class="nav-row" onClick=${() => onSheet({ type: "activity" })}><${I.pulse} /> Activity</button>
        <button class="nav-row" onClick=${() => onSheet({ type: "settings" })}><${I.gear} /> Settings</button>
      </div>
    </div>
    <div class="side-foot">
      ${st.authMode === "plan"
        ? html`<div class="plan"><span class="pip" /> Running on your Claude plan</div>`
        : html`<div>Today ${money(budget.today)} of ${money(budget.limit)}</div><div class=${`meter ${pct >= 80 ? "hot" : ""}`}><i style=${`width:${pct}%`} /></div>`}
    </div>
  </aside>
  ${open ? html`<div class="scrim mobile-only" onClick=${onClose} />` : null}`;
}

// ============================================================ messages
function Files({ files, onImage }) {
  if (!files?.length) return null;
  return html`<div class="files">${files.map((f) =>
    isImage(f)
      ? html`<img class="thumb" src=${fileUrl(f)} alt=${f} loading="lazy" onClick=${() => onImage(fileUrl(f))} />`
      : html`<a class="file-chip" href=${fileUrl(f)} target="_blank" rel="noopener"><span class="ext">${(f.split(".").pop() || "").slice(0, 4)}</span><span>${f.split("/").pop()}</span></a>`,
  )}</div>`;
}

function Feedback({ m }) {
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const send = (up, text) =>
    api("/feedback", { method: "POST", body: { botId: m.botId, msgId: m.id, up, note: text } })
      .then(() => toast(up ? "Thanks — noted" : "Got it — it'll remember that"))
      .catch(fail);
  return html`<span style="display:inline-flex;gap:6px;align-items:center">
    <button class=${`fb ${m.meta?.feedback === "up" ? "picked" : ""}`} onClick=${() => send(true)} aria-label="Good answer"><${I.up} /></button>
    <button class=${`fb ${m.meta?.feedback === "down" ? "picked" : ""}`} onClick=${() => setAsking(!asking)} aria-label="Bad answer"><${I.down} /></button>
    ${asking
      ? html`<form style="display:flex;gap:6px" onSubmit=${(e) => { e.preventDefault(); send(false, note); setAsking(false); }}>
          <input class="input fb-note" placeholder="What should it do differently?" value=${note} onInput=${(e) => setNote(e.target.value)} autofocus />
          <button class="btn small primary">Save</button>
        </form>`
      : null}
  </span>`;
}

function TextMsg({ m, bot, onImage }) {
  if (m.role === "system") return html`<div class="msg system"><div class="text" dangerouslySetInnerHTML=${{ __html: md(m.text || "") }} /></div>`;
  const user = m.role === "user";
  // In a group (or when a teammate answers in your chat), each message shows who said it.
  const speaker = (m.meta?.from && botById(m.meta.from)) || (bot.group ? bot.lead : bot);
  const named = !user && (bot.group || (m.meta?.from && m.meta.from !== bot.id));
  return html`<div class=${`msg ${user ? "user" : "bot"}`}>
    ${user ? null : html`<${Avatar} bot=${speaker} size=${28} still />`}
    <div class="body">
      ${named ? html`<div class="speaker">${speaker?.name}</div>` : null}
      ${m.meta?.header ? html`<div class="header-line">${m.meta.header}</div>` : null}
      ${m.text?.trim() ? html`<div class=${`text ${m.meta?.error ? "error" : ""}`} dangerouslySetInnerHTML=${{ __html: md(m.text) }} />` : null}
      <${Files} files=${m.files} onImage=${onImage} />
      <div class=${`msg-foot ${m.meta?.feedback ? "keep" : ""}`}>
        ${m.meta?.voice && user ? "Voice · " : ""}${fmtTime(m.at)}
        ${m.meta?.seconds !== undefined && m.meta?.costUsd !== undefined ? html`<span>· ${dur(m.meta.seconds * 1000)}${store.state?.authMode !== "plan" ? ` · ${money(m.meta.costUsd)}` : ""}</span>` : null}
        ${!user && m.meta?.costUsd !== undefined && !m.meta?.error ? html`<${Feedback} m=${m} />` : null}
      </div>
    </div>
  </div>`;
}

function RunBlock({ m, bot: chatBot }) {
  const r = m.run;
  const bot = (r.bot && botById(r.bot)) || (chatBot.group ? chatBot.lead : chatBot); // whose task this is
  const live = r.status === "running" || r.status === "waiting";
  const [open, setOpen] = useState(null);
  const isOpen = open ?? live;
  const now = useNow(live);
  const elapsed = (r.endedAt || now) - r.startedAt;
  const last = r.steps.at(-1)?.text;
  const stateIcon = { done: I.okCircle, failed: I.xCircle, stopped: I.dash, "nothing new": I.dash, waiting: I.pauseCircle }[r.status];
  const title = r.status === "waiting" ? "Waiting for you" : live ? (r.stalled ? "Still working" : "Working") : r.status === "failed" ? "Failed" : r.status === "stopped" ? "Stopped" : r.status === "nothing new" ? "Nothing new" : `Worked for ${dur(elapsed)}`;
  const sub = live ? (r.status === "waiting" ? "answer below" : last || "Starting") : `${r.model ? `${r.model} · ` : ""}${r.steps.length} step${r.steps.length === 1 ? "" : "s"}${r.costUsd && store.state?.authMode !== "plan" ? ` · ${money(r.costUsd)}` : ""}`;
  const shown = live ? r.steps.slice(-8) : r.steps;
  // The reply streams in under the timeline while it's being written; the saved reply replaces it.
  const streaming = live && r.live
    ? html`<div class="msg bot streaming">
        <${Avatar} bot=${bot} size=${28} still />
        <div class="body"><div class="text" dangerouslySetInnerHTML=${{ __html: md(r.live) }} /></div>
      </div>`
    : null;
  return html`<div class=${`run ${live ? "live" : ""} ${r.status === "waiting" ? "waiting" : ""}`}>
    <button class="run-head" onClick=${() => setOpen(!isOpen)}>
      ${live ? html`<${Blip} size=${32} look=${bot?.look} state=${r.status === "waiting" ? "needs" : "working"} />` : html`<span class="state-dot" style=${r.status === "failed" ? "color:var(--danger)" : ""}><${stateIcon || I.okCircle} /></span>`}
      <span class="label"><b class=${live && r.status !== "waiting" ? "shimmer" : ""}>${r.bot || chatBot.group ? `${bot?.name} · ` : ""}${title}</b><span>${sub}</span></span>
      ${live ? html`<span class="time">${r.model ? `${r.model} · ` : ""}${dur(elapsed)}</span>` : null}
      <span class=${`chev ${isOpen ? "open" : ""}`}><${I.chevron} /></span>
    </button>
    ${r.replay && !live
      ? html`<button class="replay-link" onClick=${() => setOpen(true)}><${I.play} /> Watch replay${isOpen ? "" : " · what it did in the browser"}</button>`
      : null}
    ${isOpen && (r.plan.length || r.steps.length || r.replay)
      ? html`<div class="run-body">
          ${r.replay && !live ? html`<video class="replay" controls playsinline preload="metadata" src=${`/api/file?path=${encodeURIComponent(r.replay)}`} />` : null}
          ${r.plan.length
            ? html`<div class="plan">${r.plan.map((t) => html`<div class=${t.status === "completed" ? "done" : t.status === "in_progress" ? "now" : ""}>
                <span class=${`tick ${t.status === "completed" ? "done" : t.status === "in_progress" ? "now" : ""}`}>${t.status === "completed" ? html`<${I.check} />` : null}</span>
                <span>${t.status === "in_progress" ? t.activeForm || t.content : t.content}</span>
              </div>`)}</div>`
            : null}
          ${shown.length ? html`<div class="steps">${shown.map((s) => html`<div><time>${fmtTime(s.at)}</time><span>${s.text}</span></div>`)}</div>` : null}
        </div>`
      : null}
  </div>${streaming}`;
}

const KICKER = { approval: "Needs your approval", draft: "Draft · review before it's sent", takeover: "Your turn", suggestion: "Suggestion", secret: "Secret · saved to the Keychain" };

function Card({ m, onTakeover }) {
  const c = m.card;
  const pending = c.status === "pending";
  const [busy, setBusy] = useState(false);
  const [draftBody, setDraftBody] = useState(c.draft?.body ?? "");
  const [secret, setSecret] = useState("");
  const [reveal, setReveal] = useState(false);
  useEffect(() => setDraftBody(c.draft?.body ?? ""), [c.draft?.body]);
  const answer = async (value) => {
    if (c.type === "secret" && value === "save" && !secret) return toast("Type the secret first");
    setBusy(true);
    try {
      await api(`/card/${m.id}`, { method: "POST", body: { value, body: c.draft ? draftBody : c.type === "secret" && value === "save" ? secret : undefined } });
      setSecret(""); // never keep it around in the page
    } catch (e) {
      fail(e);
      setBusy(false);
    }
  };
  return html`<div class=${`card ${c.type} ${pending ? "pending" : ""}`}>
    <div class="card-kicker"><span class="k-dot" />${KICKER[c.type]}</div>
    <div class="card-title">${c.title}</div>
    ${c.draft
      ? html`<div class="hint">To: ${c.draft.to}${c.draft.subject ? html` · Subject: <b>${c.draft.subject}</b>` : null}</div>
        ${pending
          ? html`<label class="draft-field">Message (edit before sending)<textarea value=${draftBody} onInput=${(e) => setDraftBody(e.target.value)} /></label>`
          : html`<div class="card-body">${c.draft.body}</div>`}`
      : c.body ? html`<div class=${`card-body ${/terminal|file$/i.test(c.title) ? "code" : ""}`}>${c.body}</div>` : null}
    ${c.type === "secret" && pending
      ? html`<form class="secret-field" onSubmit=${(e) => { e.preventDefault(); answer("save"); }}>
          <input class="input" type=${reveal ? "text" : "password"} autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste or type it here" value=${secret} onInput=${(e) => setSecret(e.target.value)} />
          <button type="button" class="btn small" onClick=${() => setReveal(!reveal)}>${reveal ? "Hide" : "Show"}</button>
        </form>`
      : null}
    ${c.note ? html`<div class=${`card-note ${c.type === "takeover" || c.type === "suggestion" || c.type === "secret" ? "info" : ""}`}>${c.note}</div>` : null}
    ${pending
      ? html`<div class="card-actions">
          ${c.type === "takeover" ? html`<button class="btn" onClick=${onTakeover}><${I.computer} /> Open computer</button>` : null}
          ${c.buttons.map((b) => html`<button class=${`btn ${b.style || ""}`} disabled=${busy} onClick=${() => answer(b.value)}>${b.label}</button>`)}
        </div>`
      : html`<div class="card-answer">${c.status === "expired" ? null : html`<span class="state-dot"><${I.okCircle} /></span>`} ${c.answer || (c.status === "expired" ? "Expired: Blip restarted before you answered" : "")}</div>`}
  </div>`;
}

function MessageList({ bot, messages, onImage, onTakeover }) {
  const ref = useRef();
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  // Switching bots always opens at the latest message.
  useLayoutEffect(() => {
    stick.current = true;
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [bot.id]);
  const onScroll = () => {
    const el = ref.current;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };
  return html`<div class="messages" ref=${ref} onScroll=${onScroll}>
    <div class="messages-inner">
      ${messages === undefined ? html`<div class="empty">Loading…</div>` : null}
      ${messages?.length === 0 ? html`<div class="hello" style="min-height:50vh"><${Blip} size=${104} look=${bot.look} /><h1>${bot.name}</h1><p>${bot.job}</p></div>` : null}
      ${(messages || []).map((m) =>
        m.kind === "run" ? html`<${RunBlock} key=${m.id} m=${m} bot=${bot} />`
        : m.kind === "card" ? html`<${Card} key=${m.id} m=${m} onTakeover=${onTakeover} />`
        : html`<${TextMsg} key=${m.id} m=${m} bot=${bot} onImage=${onImage} />`,
      )}
    </div>
  </div>`;
}

// ============================================================ composer
function Composer({ bot, st, onModel, preset, clearPreset }) {
  const [text, setText] = useState(() => localStorage.getItem(`draft:${bot.id}`) || "");
  const [files, setFiles] = useState([]);
  const [rec, setRec] = useState(null);
  const [busy, setBusy] = useState(false);
  const ta = useRef();
  const fileInput = useRef();
  const recRef = useRef(null);
  const sending = useRef(false);
  const running = bot.running;

  // Leaving this bot (or the app) while recording turns the mic off: it must never stay on in the background.
  useEffect(() => () => {
    const r = recRef.current;
    if (r) {
      r.onstop = null;
      if (r.state !== "inactive") r.stop();
      r.stream.getTracks().forEach((t) => t.stop());
    }
  }, []);
  const filesRef = useRef(files);
  filesRef.current = files;
  useEffect(() => () => filesRef.current.forEach((f) => f.preview && URL.revokeObjectURL(f.preview)), []);

  useEffect(() => setText(localStorage.getItem(`draft:${bot.id}`) || ""), [bot.id]);
  useEffect(() => {
    if (!preset) return;
    setText(preset);
    clearPreset();
    setTimeout(() => ta.current?.focus(), 0);
  }, [preset]);
  useEffect(() => {
    try {
      localStorage.setItem(`draft:${bot.id}`, text);
    } catch {}
    const el = ta.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    }
  }, [text]);

  const send = async (overrideText, voice) => {
    const body = (overrideText ?? text).trim();
    if ((!body && !files.length) || sending.current) return; // a double Enter on a slow link sends once
    sending.current = true;
    setBusy(true);
    const sentFiles = files;
    // Clear right away, so anything typed while it sends isn't wiped; put it back if sending fails.
    if (overrideText === undefined) setText("");
    setFiles([]);
    try {
      await api("/send", { method: "POST", body: { botId: bot.id, text: body, voice, attachments: sentFiles.map(({ name, type, data }) => ({ name, type, data })) } });
      sentFiles.forEach((f) => f.preview && URL.revokeObjectURL(f.preview));
    } catch (e) {
      if (overrideText === undefined) setText((now) => (now ? now : body));
      setFiles((now) => [...sentFiles, ...now]);
      fail(e);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  const pick = async (e) => {
    const list = [...e.target.files];
    e.target.value = "";
    let total = filesRef.current.reduce((n, f) => n + f.data.length * 0.75, 0);
    for (const f of list) {
      if (f.size > 25_000_000) {
        toast(`${f.name} is over 25 MB`);
        continue;
      }
      if (total + f.size > 40_000_000) {
        toast("That's over 40 MB in one message. Send the rest in another message.");
        break;
      }
      total += f.size;
      const data = await readAsBase64(f);
      setFiles((prev) => [...prev, { name: f.name, type: f.type, data, preview: f.type.startsWith("image/") ? URL.createObjectURL(f) : null }]);
    }
  };
  // Talk mode: a hands-free conversation. Listen → send → wait for the reply → hear it → listen again.
  const [talk, setTalk] = useState(false);
  const [talkState, setTalkState] = useState("");
  useEffect(() => {
    if (!talk) return;
    let on = true, stream;
    const stillOn = () => on;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      } catch {
        toast("Talk mode needs the mic. On iPhone use the https:// Tailscale link and allow the microphone.");
        return setTalk(false);
      }
      while (on) {
        setTalkState("Listening…");
        const blob = await recordUtterance(stream, stillOn);
        if (!on) break;
        if (!blob) continue;
        setTalkState("Transcribing…");
        let heard = "";
        try {
          const ext = blob.type.includes("mp4") ? "m4a" : "webm";
          heard = (await api("/voice", { method: "POST", body: { name: `voice.${ext}`, data: await readAsBase64(blob) } })).text?.trim();
        } catch (e) {
          fail(e);
        }
        if (!heard || !on) continue;
        if (/^(stop|exit|end) talk(ing)?( mode)?[.!]?$/i.test(heard)) break;
        const sentAt = Date.now();
        await api("/send", { method: "POST", body: { botId: bot.id, text: heard, voice: true } }).catch(fail);
        setTalkState("Thinking…");
        // Wait for this bot's reply (it's spoken automatically), then for the voice to finish. If it stops to
        // ask for approval, say so once: approvals are only ever given by tapping, never by voice.
        let toldAboutCard = false;
        for (let i = 0; on && i < 1800; i++) {
          const list = store.threads[bot.id] || [];
          if (list.some((m) => m.role === "bot" && m.kind === "text" && m.at > sentAt)) break;
          if (!toldAboutCard && list.some((m) => m.kind === "card" && m.card.status === "pending" && m.at > sentAt)) {
            toldAboutCard = true;
            setTalkState("Needs your OK in the chat…");
            await speakText("I need your OK for that. Tap the card in the chat.");
          }
          await new Promise((r) => setTimeout(r, 300));
        }
        setTalkState("Speaking…");
        await new Promise((r) => setTimeout(r, 200));
        await speechDone;
      }
      on = false;
      setTalk(false);
    })();
    return () => {
      on = false;
      stream?.getTracks().forEach((t) => t.stop());
      if ("speechSynthesis" in window) speechSynthesis.cancel();
      setTalkState("");
    };
  }, [talk, bot.id]);

  // The mic: tap to start and tap again to send, or hold it while you talk and let go to send.
  const press = useRef({ at: 0, stopOnUp: false });
  const micDown = (e) => {
    if (e.button > 0) return;
    press.current = { at: Date.now(), stopOnUp: !!recRef.current };
    if (!recRef.current) toggleMic();
  };
  const micUp = () => {
    const held = Date.now() - press.current.at > 450;
    if (press.current.stopOnUp || held) {
      if (recRef.current) recRef.current.stop();
      else press.current.stopWhenReady = held; // released before the mic finished starting
    }
  };
  const toggleMic = async () => {
    if (rec) return rec.stop();
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      const chunks = [];
      mr.ondataavailable = (e) => chunks.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        recRef.current = null;
        setRec(null);
        const blob = new Blob(chunks, { type: mr.mimeType });
        toast("Transcribing…");
        try {
          const ext = mr.mimeType.includes("mp4") ? "m4a" : "webm";
          const { text: heard } = await api("/voice", { method: "POST", body: { name: `voice.${ext}`, data: await readAsBase64(blob) } });
          if (!heard) return toast("Didn't catch that");
          await send(heard, true);
        } catch (e) {
          fail(e);
        }
      };
      mr.start();
      recRef.current = mr;
      setRec(mr);
      if (press.current.stopWhenReady) {
        press.current.stopWhenReady = false;
        setTimeout(() => mr.state !== "inactive" && mr.stop(), 300);
      }
    } catch (err) {
      stream?.getTracks().forEach((t) => t.stop());
      const name = err?.name || "";
      toast(
        !window.isSecureContext ? "The mic needs the secure https:// link. Open Blip from the Tailscale link."
        : name === "NotAllowedError" ? "Blip isn't allowed to use the mic. iPhone: Settings → Apps → Safari → Microphone → Allow, then reopen Blip."
        : name === "NotFoundError" ? "No microphone found on this device."
        : typeof MediaRecorder === "undefined" ? "This browser can't record audio. Update iOS, or use Safari or Chrome."
        : `Couldn't start the mic: ${err?.message || name || "unknown error"}`,
      );
    }
  };
  const onKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !coarse) {
      e.preventDefault();
      send();
    }
  };
  const empty = !text.trim() && !files.length;
  const queued = st.runtime.queued.length;
  const hint = talk ? `Talk mode · ${talkState || "Starting…"} Say "stop talking" or tap the wave to end.` : rec ? "Listening. Tap the mic again (or let go) to send." : running ? "Messages you send now steer the task in progress." : queued ? `${queued} task${queued > 1 ? "s" : ""} queued` : "";
  return html`<div class="composer-wrap">
    <div class="composer">
      ${files.length
        ? html`<div class="attach-list">${files.map((f, i) => html`<span class="chip">${f.preview ? html`<img src=${f.preview} style="width:20px;height:20px;border-radius:4px;object-fit:cover" />` : html`<${I.clip} />`} ${f.name.slice(0, 24)}
            <button onClick=${() => { if (f.preview) URL.revokeObjectURL(f.preview); setFiles(files.filter((_, j) => j !== i)); }} aria-label="Remove">×</button></span>`)}</div>`
        : null}
      <textarea ref=${ta} rows="1" placeholder=${bot.group ? (running ? "Steer the team while it works…" : `Message ${bot.name} (@Name asks one bot)`) : running ? `Steer ${bot.name} while it works…` : `What should ${bot.name} do?`} value=${text} onInput=${(e) => setText(e.target.value)} onKeyDown=${onKey} />
      <div class="composer-row">
        <button class="icon-btn" onClick=${() => fileInput.current.click()} aria-label="Attach"><${I.clip} /></button>
        <input type="file" multiple hidden ref=${fileInput} onChange=${pick} />
        <button class=${`icon-btn ${rec ? "rec" : ""}`} onPointerDown=${micDown} onPointerUp=${micUp} onPointerCancel=${micUp} onKeyDown=${(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), toggleMic())} onContextMenu=${(e) => e.preventDefault()} aria-label="Voice message (tap, or hold and talk)"><${I.mic} /></button>
        <button class=${`icon-btn ${talk ? "rec" : ""}`} onClick=${() => { if (!talk) speakText(""); setTalk(!talk); }} aria-label=${talk ? "End talk mode" : "Talk mode"} title="Talk mode: a hands-free conversation"><${I.wave} /></button>
        ${bot.group ? null : html`<button class="chip btn" onClick=${onModel}>${shortModel(bot.model)}</button>`}
        <span class="spacer" />
        ${running && empty
          ? html`<button class="send stop" onClick=${() => api("/stop", { method: "POST", body: { botId: bot.id } }).catch(fail)} aria-label="Stop"><${I.stop} /></button>`
          : html`<button class="send" disabled=${empty || busy} onClick=${() => send()} aria-label="Send"><${I.send} /></button>`}
      </div>
    </div>
    <div class="composer-hint">${hint}</div>
  </div>`;
}

// ============================================================ right panel
// ============================================================ remote control (Chrome Remote Desktop-style)
const QUALITY = { smooth: { w: 1024, fps: 12, label: "Smooth" }, balanced: { w: 1280, fps: 10, label: "Balanced" }, sharp: { w: 1680, fps: 6, label: "Sharp" } };

/** Live video of the Mac's screen. Streams JPEG frames; falls back to snapshots if the stream can't get through. */
/** True while the app is on screen. Streams pause in the background so the Mac isn't recording for nobody. */
function usePageVisible() {
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => {
    const on = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
}

function useScreenStream(imgRef, { w, fps }, wanted) {
  const [info, setInfo] = useState({ live: false, slow: false, fps: 0, error: null });
  const visible = usePageVisible();
  const enabled = wanted && visible;
  useEffect(() => {
    if (!enabled) return;
    let alive = true, frames = 0, lastFrame = 0, ctrl, attempts = 0, polling = false;
    // Every frame's image URL is freed as soon as a newer one is on screen (frames can arrive faster than
    // the phone decodes them, and leaking them crashes the app within minutes).
    const urls = new Set();
    const show = (blob) => {
      const img = imgRef.current;
      if (!img) return;
      const next = URL.createObjectURL(blob);
      urls.add(next);
      img.onload = img.onerror = () => {
        for (const u of urls) if (u !== next) { URL.revokeObjectURL(u); urls.delete(u); }
      };
      img.src = next;
      frames++;
      attempts = 0; // it's working again
      lastFrame = Date.now();
    };
    const poll = async () => {
      polling = true;
      while (alive) {
        try {
          const res = await fetch("/api/screen", { cache: "no-store" });
          if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "The screen isn't available");
          show(await res.blob());
          setInfo((i) => ({ ...i, slow: true, error: null }));
        } catch (e) {
          if (alive) setInfo((i) => ({ ...i, error: e.message }));
        }
        await new Promise((r) => setTimeout(r, 400));
      }
    };
    const stream = async () => {
      ctrl = new AbortController();
      try {
        const res = await fetch(`/api/screen/stream?w=${w}&fps=${fps}`, { signal: ctrl.signal, cache: "no-store" });
        if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || "Live view unavailable");
        const reader = res.body.getReader();
        let buf = new Uint8Array(0);
        for (;;) {
          const { value, done } = await reader.read();
          if (done || !alive) break;
          const merged = new Uint8Array(buf.length + value.length);
          merged.set(buf);
          merged.set(value, buf.length);
          buf = merged;
          let latest = null; // several frames in one chunk: only the newest is worth drawing
          while (buf.length >= 4) {
            const n = ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0;
            if (buf.length < 4 + n) break;
            latest = buf.slice(4, 4 + n);
            buf = buf.slice(4 + n);
          }
          if (latest) show(new Blob([latest], { type: "image/jpeg" }));
        }
      } catch (e) {
        if (alive && e.name !== "AbortError") setInfo((i) => ({ ...i, error: e.message }));
      }
    };
    const start = () => {
      attempts++;
      lastFrame = Date.now();
      stream();
    };
    start();
    // Watchdog: restart a stalled stream, and switch to snapshots if streaming keeps failing.
    const tick = setInterval(() => {
      const fpsNow = frames;
      frames = 0;
      const stalled = Date.now() - lastFrame > 5000;
      setInfo((i) => ({ ...i, fps: fpsNow, live: !stalled && fpsNow > 0 }));
      if (stalled && !polling) {
        ctrl?.abort();
        // Say why, if the Mac knows (e.g. Screen Recording permission is off).
        api("/screen/status").then((st) => alive && st?.error && setInfo((i) => ({ ...i, error: st.error }))).catch(() => {});
        if (attempts < 3) start();
        else poll();
      }
    }, 1000);
    return () => {
      alive = false;
      clearInterval(tick);
      ctrl?.abort();
      for (const u of urls) URL.revokeObjectURL(u);
    };
  }, [enabled, w, fps]);
  return info;
}

const screenApi = (action, body) => api(`/screen/${action}`, { method: "POST", body }).catch(fail);

function ComputerPanel({ setControl, control }) {
  const img = useRef();
  // While full-screen control is open it has its own stream; two at once would halve the frame rate.
  const info = useScreenStream(img, { w: 960, fps: 4 }, !control);
  return html`<div style="display:grid;gap:12px">
    <button class="btn primary" style="height:44px" onClick=${() => setControl(true)}><${I.computer} /> Control this Mac</button>
    <div class="screen-box">
      <img ref=${img} alt="Your Mac's screen" draggable="false" />
      <span class="chip screen-badge">${info.live ? `Live · ${info.fps} fps` : info.slow ? "Snapshots" : "Connecting…"}</span>
    </div>
    ${info.error && !info.live ? html`<div class="card-note">${info.error}</div>` : null}
    <p class="hint">This is your bots' computer, live. Tap “Control this Mac” for full-screen control like Chrome Remote Desktop: use it for passwords, codes and payments. The bot never sees what you type there.</p>
  </div>`;
}

const REMOTE_KEYS = [
  ["Esc", "esc"], ["Tab", "tab"], ["Return", "return"], ["⌫", "delete"], ["Space", "space"],
  ["⌘ Space", "cmd+space"], ["⌘ Tab", "cmd+tab"], ["⌘ C", "cmd+c"], ["⌘ V", "cmd+v"], ["⌘ X", "cmd+x"], ["⌘ A", "cmd+a"], ["⌘ Z", "cmd+z"],
  ["⌘ F", "cmd+f"], ["⌘ W", "cmd+w"], ["⌘ R", "cmd+r"], ["←", "arrow-left"], ["↑", "arrow-up"], ["↓", "arrow-down"], ["→", "arrow-right"],
  ["Page ↑", "page-up"], ["Page ↓", "page-down"],
];

// ---- Chrome Remote Desktop-style link: H.264 video decoded by the device's hardware (WebCodecs) and input,
// clipboard and latency pings over one WebSocket. Old browsers fall back to JPEG snapshots + HTTP input.
const LADDER = [
  { w: 960, fps: 20, kbps: 700 },
  { w: 1280, fps: 30, kbps: 1600 },
  { w: 1600, fps: 30, kbps: 2800 },
  { w: 1920, fps: 30, kbps: 4500 },
];
const REMOTE_QUALITY = {
  auto: { label: "Auto", step: 1 },
  smooth: { label: "Smooth", step: 1 },
  sharp: { label: "Sharp", step: 3 },
  saver: { label: "Data saver", step: 0 },
};
const canDecodeVideo = typeof VideoDecoder !== "undefined" && typeof EncodedVideoChunk !== "undefined";

function useRemoteLink(canvasRef, quality, enabled, onClip) {
  const [info, setInfo] = useState({ mode: canDecodeVideo ? "connecting" : "fallback", live: false, fps: 0, rtt: null, kbps: 0, error: null, step: null });
  const wsRef = useRef(null);
  const clipRef = useRef(onClip);
  clipRef.current = onClip;
  const stepRef = useRef(REMOTE_QUALITY[quality]?.step ?? 1);
  const qualityRef = useRef(quality);
  qualityRef.current = quality;
  const sendQuality = () => {
    const ws = wsRef.current;
    if (canDecodeVideo && ws?.readyState === 1) ws.send(JSON.stringify({ t: "quality", ...LADDER[stepRef.current] }));
    setInfo((i) => ({ ...i, step: stepRef.current }));
  };
  useEffect(() => {
    stepRef.current = REMOTE_QUALITY[quality]?.step ?? 1;
    sendQuality();
  }, [quality]);
  useEffect(() => {
    if (!enabled) return; // without video decoding (old browser, plain http) the link still carries input
    let alive = true, decoder = null, waitKey = true, frames = 0, bytes = 0, lastFrame = 0, failures = 0, retry, lastStep = 0, calm = 0, lastRtt = null;
    const draw = (frame) => {
      const c = canvasRef.current;
      if (c) {
        if (c.width !== frame.displayWidth) c.width = frame.displayWidth;
        if (c.height !== frame.displayHeight) c.height = frame.displayHeight;
        c.getContext("2d").drawImage(frame, 0, 0);
      }
      frame.close();
      frames++;
      lastFrame = Date.now();
    };
    const configure = async (cfg) => {
      const config = { codec: cfg.codec, description: Uint8Array.from(atob(cfg.description), (ch) => ch.charCodeAt(0)), optimizeForLatency: true, hardwareAcceleration: "prefer-hardware" };
      let ok = await VideoDecoder.isConfigSupported(config).then((r) => r.supported, () => false);
      if (!ok) {
        delete config.hardwareAcceleration;
        ok = await VideoDecoder.isConfigSupported(config).then((r) => r.supported, () => false);
      }
      if (!ok) return setInfo((i) => ({ ...i, mode: "fallback" })); // this device can't decode it
      try { decoder?.close(); } catch {}
      decoder = new VideoDecoder({ output: draw, error: () => (waitKey = true) });
      decoder.configure(config);
      waitKey = true;
    };
    const connect = () => {
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/remote`);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      ws.onopen = () => {
        setInfo((i) => ({ ...i, connected: true }));
        sendQuality();
      };
      ws.onmessage = (e) => {
        if (typeof e.data === "string") {
          const m = JSON.parse(e.data);
          if (m.t === "config") configure(m);
          else if (m.t === "error") setInfo((i) => ({ ...i, error: m.msg }));
          else if (m.t === "pong") {
            lastRtt = Math.round(performance.now() - m.at);
            setInfo((i) => ({ ...i, rtt: lastRtt }));
          }
          else if (m.t === "clip") clipRef.current?.(m.text);
          else if (m.t === "clip-set") toast("Copied to the Mac's clipboard");
          else if (m.t === "health" && qualityRef.current === "auto") {
            // Auto quality: step down as soon as frames are being skipped, back up after a calm 20 s.
            const now = Date.now();
            if (m.drops > 0 && stepRef.current > 0 && now - lastStep > 4000) {
              stepRef.current--;
              lastStep = now;
              calm = 0;
              sendQuality();
            } else if (m.drops || (lastRtt ?? 0) > 300) {
              calm = 0;
            } else if ((calm += 2) >= (now - lastStep < 120_000 ? 60 : 20) && stepRef.current < 2) { // slower to retry after a slowdown
              stepRef.current++;
              lastStep = now;
              calm = 0;
              sendQuality();
            }
          }
          return;
        }
        const buf = new Uint8Array(e.data);
        bytes += buf.length;
        failures = 0;
        // Confirm every frame right away: the Mac only sends more while frames are arriving promptly.
        const seqNo = ((buf[1] << 24) | (buf[2] << 16) | (buf[3] << 8) | buf[4]) >>> 0;
        if (ws.readyState === 1) ws.send(`{"t":"ack","seq":${seqNo}}`);
        if (!decoder || decoder.state !== "configured") return;
        const key = buf[0] === 1;
        if (waitKey && !key) return;
        if (decoder.decodeQueueSize > 6 && !key) return void (waitKey = true); // the device is behind: skip to the next keyframe
        waitKey = false;
        const ts = ((buf[1] << 24) | (buf[2] << 16) | (buf[3] << 8) | buf[4]) >>> 0;
        try {
          decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: ts * 33_333, data: buf.subarray(5) }));
        } catch {
          waitKey = true;
        }
      };
      ws.onclose = () => {
        if (!alive) return;
        setInfo((i) => ({ ...i, connected: false }));
        // Reconnect; after repeated failures use the simpler snapshot view instead.
        if (++failures >= 4) return setInfo((i) => ({ ...i, mode: "fallback" }));
        retry = setTimeout(connect, 1000 * failures);
      };
    };
    connect();
    const tick = setInterval(() => {
      const ws = wsRef.current;
      if (ws?.readyState === 1) ws.send(JSON.stringify({ t: "ping", at: performance.now() }));
      const live = Date.now() - lastFrame < 3000;
      setInfo((i) => ({ ...i, mode: i.mode === "fallback" || !canDecodeVideo ? "fallback" : live ? "video" : "connecting", live, fps: frames, kbps: Math.round((bytes * 8) / 1000) }));
      frames = 0;
      bytes = 0;
    }, 1000);
    return () => {
      alive = false;
      clearInterval(tick);
      clearTimeout(retry);
      wsRef.current?.close();
      wsRef.current = null;
      try { decoder?.close(); } catch {}
    };
  }, [enabled]);
  /** Sends a message over the link; false when it isn't connected (the caller then uses HTTP). */
  const send = (m) => {
    const ws = wsRef.current;
    if (ws?.readyState !== 1) return false;
    ws.send(JSON.stringify(m));
    return true;
  };
  return { info, send };
}

/** Full-screen remote control: trackpad or touch mode, pinch zoom, two-finger scroll, live keyboard. */
function RemoteView({ onClose }) {
  const [mode, setMode] = useState(() => localStorage.getItem("remote-mode") || (coarse ? "trackpad" : "touch"));
  const [quality, setQuality] = useState(() => {
    const saved = localStorage.getItem("remote-quality");
    return REMOTE_QUALITY[saved] ? saved : "auto";
  });
  const [clip, setClip] = useState(null); // text fetched from the Mac's clipboard
  const [keysOpen, setKeysOpen] = useState(false);
  const [cursor, setCursor] = useState({ x: 0.5, y: 0.5 });
  const [view, setView] = useState({ s: 1, tx: 0, ty: 0 });
  const [dragging, setDragging] = useState(false);
  const stage = useRef(), img = useRef(), canvas = useRef(), kbd = useRef();
  const link = useRemoteLink(canvas, quality, true, setClip);
  const fallback = link.info.mode === "fallback";
  const info = useScreenStream(img, QUALITY[quality === "sharp" ? "sharp" : quality === "saver" ? "smooth" : "balanced"], fallback);
  const media = () => (fallback ? img.current : canvas.current);
  const cur = useRef(cursor);
  cur.current = cursor;
  const v = useRef(view);
  v.current = view;

  useEffect(() => {
    try { localStorage.setItem("remote-mode", mode); localStorage.setItem("remote-quality", quality); } catch {}
  }, [mode, quality]);

  // ---- input senders. Everything except plain pointer moves goes through one queue so keys, text and
  // clicks reach the Mac in the order you did them; moves and scrolls are throttled.
  const chain = useRef(Promise.resolve());
  // Each action gets at most 8 s, so one hung request can't silently block every later click and key.
  const toLink = (action, b) =>
    action === "pointer" ? { t: "pointer", a: b.action, x: b.nx, y: b.ny }
    : action === "wheel" ? { t: "wheel", dx: b.dx, dy: b.dy }
    : action === "type" ? { t: "type", text: b.text }
    : { t: "key", keys: b.keys };
  // Over the live link everything arrives in order by itself; the HTTP fallback queues requests.
  const act = (action, body) =>
    link.send(toLink(action, body))
      ? Promise.resolve()
      : (chain.current = chain.current.then(() => Promise.race([screenApi(action, body), new Promise((r) => setTimeout(r, 8000))])));
  const fast = () => !!link.info.connected;
  const moveTimer = useRef(), pendingMove = useRef(null);
  const sendMove = (nx, ny, action = "move") => {
    pendingMove.current = { nx, ny, action };
    if (moveTimer.current) return;
    moveTimer.current = setTimeout(() => {
      moveTimer.current = null;
      const m = pendingMove.current;
      if (!m) return;
      if (m.action === "move") {
        if (!link.send({ t: "pointer", a: "move", x: m.nx, y: m.ny })) screenApi("pointer", { action: "move", nx: m.nx, ny: m.ny });
      } else act("pointer", { action: m.action, nx: m.nx, ny: m.ny });
    }, fast() ? 16 : 70); // about 60 updates a second over the live link
  };
  const scrollAcc = useRef({ dx: 0, dy: 0 }), scrollTimer = useRef();
  const sendScroll = (dx, dy) => {
    scrollAcc.current.dx += dx;
    scrollAcc.current.dy += dy;
    if (scrollTimer.current) return;
    scrollTimer.current = setTimeout(() => {
      scrollTimer.current = null;
      const a = scrollAcc.current;
      scrollAcc.current = { dx: 0, dy: 0 };
      if (Math.abs(a.dx) + Math.abs(a.dy) > 1) act("wheel", { dx: Math.round(a.dx), dy: Math.round(a.dy) });
    }, fast() ? 24 : 110);
  };
  const textQueue = useRef(""), textTimer = useRef();
  const flushText = () => {
    clearTimeout(textTimer.current);
    textTimer.current = null;
    const t = textQueue.current;
    textQueue.current = "";
    if (t) act("type", { text: t });
  };
  const typeText = (t) => {
    textQueue.current += t;
    if (!textTimer.current) textTimer.current = setTimeout(flushText, fast() ? 30 : 120);
  };
  const pressKey = (keys) => {
    flushText();
    act("key", { keys });
  };

  // ---- coordinates
  const norm = (clientX, clientY) => {
    const r = media().getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (clientY - r.top) / r.height)) };
  };
  const clampView = (s, tx, ty) => {
    const st = stage.current.getBoundingClientRect();
    const maxX = (st.width * (s - 1)) / 2, maxY = (st.height * (s - 1)) / 2;
    return { s, tx: Math.min(maxX, Math.max(-maxX, tx)), ty: Math.min(maxY, Math.max(-maxY, ty)) };
  };

  // ---- clicks with double-tap detection
  const tapTimer = useRef(), lastTap = useRef(null);
  const tapAt = (nx, ny) => {
    if (tapTimer.current && lastTap.current && Math.hypot(lastTap.current.nx - nx, lastTap.current.ny - ny) < 0.04) {
      clearTimeout(tapTimer.current);
      tapTimer.current = null;
      lastTap.current = null;
      return act("pointer", { action: "double", nx, ny });
    }
    lastTap.current = { nx, ny };
    tapTimer.current = setTimeout(() => {
      tapTimer.current = null;
      act("pointer", { action: "click", nx, ny });
    }, 230);
  };

  // ---- touch gestures
  const pts = useRef(new Map()), g = useRef({}), lastTouch = useRef(0);
  const fromTouch = () => Date.now() - lastTouch.current < 1000;
  const onPointerDown = (e) => {
    if (e.pointerType === "mouse") return;
    e.preventDefault();
    lastTouch.current = Date.now();
    stage.current.setPointerCapture?.(e.pointerId);
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const list = [...pts.current.values()];
    if (list.length === 1) {
      g.current = { kind: "one", sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, t: Date.now(), moved: 0 };
      clearTimeout(g.current.hold);
      g.current.hold = setTimeout(() => {
        if (g.current.kind !== "one" || g.current.moved > 8) return;
        navigator.vibrate?.(12);
        if (mode === "trackpad") {
          g.current.kind = "drag"; // long-press then move = drag
          setDragging(true);
          act("pointer", { action: "down", nx: cur.current.x, ny: cur.current.y });
        } else {
          g.current.kind = "done";
          const n = norm(g.current.sx, g.current.sy);
          act("pointer", { action: "right", nx: n.x, ny: n.y });
        }
      }, 480);
    } else if (list.length === 2) {
      clearTimeout(g.current.hold);
      const [a, b] = list;
      g.current = { kind: "two", d0: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, t: Date.now(), moved: 0, s0: v.current.s, tx0: v.current.tx, ty0: v.current.ty, pinch: false };
    }
  };
  const onPointerMove = (e) => {
    if (e.pointerType === "mouse") {
      if (mode === "touch") {
        const n = norm(e.clientX, e.clientY);
        sendMove(n.x, n.y);
      }
      return;
    }
    if (!pts.current.has(e.pointerId)) return;
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const st = g.current;
    const list = [...pts.current.values()];
    if ((st.kind === "one" || st.kind === "drag") && list.length === 1) {
      const dx = e.clientX - st.lx, dy = e.clientY - st.ly;
      st.lx = e.clientX;
      st.ly = e.clientY;
      st.moved += Math.abs(dx) + Math.abs(dy);
      if (mode === "trackpad") {
        const r = media().getBoundingClientRect();
        const speed = Math.hypot(dx, dy);
        const accel = 1 + Math.min(1.2, speed / 25); // faster swipes move further, like a real trackpad
        const nx = Math.min(1, Math.max(0, cur.current.x + (dx * accel) / r.width));
        const ny = Math.min(1, Math.max(0, cur.current.y + (dy * accel) / r.height));
        setCursor({ x: nx, y: ny });
        sendMove(nx, ny, st.kind === "drag" ? "drag" : "move");
      } else if (v.current.s > 1) {
        setView(clampView(v.current.s, v.current.tx + dx, v.current.ty + dy));
      }
    } else if (st.kind === "two" && list.length === 2) {
      const [a, b] = list;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      st.moved += Math.abs(cy - st.cy) + Math.abs(d - st.d0) / 4;
      if (st.pinch || Math.abs(d - st.d0) > 24) {
        st.pinch = true; // pinch zooms the view (not the Mac)
        const s = Math.min(4, Math.max(1, (st.s0 * d) / st.d0));
        setView(clampView(s, st.tx0 + (cx - st.cx), st.ty0 + (cy - st.cy)));
      } else {
        sendScroll(0, (cy - (st.ly ?? st.cy)) * 3); // two-finger drag scrolls the Mac
        st.ly = cy;
      }
    }
  };
  const flushDrag = () => {
    // The last bit of a drag must arrive before the button is released, not after.
    clearTimeout(moveTimer.current);
    moveTimer.current = null;
    const m = pendingMove.current;
    pendingMove.current = null;
    if (m && m.action === "drag") act("pointer", m);
  };
  const onPointerCancel = (e) => {
    // The phone took the touch away (a system gesture or call): never treat that as a tap.
    if (e.pointerType === "mouse") return;
    lastTouch.current = Date.now();
    const st = g.current;
    pts.current.delete(e.pointerId);
    clearTimeout(st.hold);
    if (st.kind === "drag") {
      flushDrag();
      setDragging(false);
      act("pointer", { action: "up", nx: cur.current.x, ny: cur.current.y });
    }
    if (pts.current.size === 0) g.current = {};
  };
  const onPointerUp = (e) => {
    if (e.pointerType === "mouse") return;
    lastTouch.current = Date.now();
    const st = g.current;
    pts.current.delete(e.pointerId);
    clearTimeout(st.hold);
    if (st.kind === "drag") {
      flushDrag();
      setDragging(false);
      act("pointer", { action: "up", nx: cur.current.x, ny: cur.current.y });
    } else if (st.kind === "one" && st.moved < 10 && Date.now() - st.t < 450) {
      if (mode === "trackpad") tapAt(cur.current.x, cur.current.y);
      else {
        const n = norm(e.clientX, e.clientY);
        setCursor(n);
        tapAt(n.x, n.y);
      }
    } else if (st.kind === "two" && !st.pinch && st.moved < 16 && Date.now() - st.t < 400) {
      const at = mode === "trackpad" ? cur.current : norm(st.cx, st.cy);
      act("pointer", { action: "right", nx: at.x, ny: at.y }); // two-finger tap = right-click
    }
    if (pts.current.size === 0) g.current = {};
    else if (st.kind === "two") g.current = { kind: "done" };
  };

  // ---- mouse and keyboard on a computer
  const onClick = (e) => {
    if ((e.pointerType && e.pointerType !== "mouse") || fromTouch()) return;
    if (e.detail > 1) return;
    const n = norm(e.clientX, e.clientY);
    act("pointer", { action: "click", nx: n.x, ny: n.y });
  };
  const onDblClick = (e) => {
    if (fromTouch()) return;
    const n = norm(e.clientX, e.clientY);
    act("pointer", { action: "double", nx: n.x, ny: n.y });
  };
  const onContextMenu = (e) => {
    e.preventDefault();
    if (coarse || fromTouch()) return;
    const n = norm(e.clientX, e.clientY);
    act("pointer", { action: "right", nx: n.x, ny: n.y });
  };
  const onWheel = (e) => {
    e.preventDefault();
    sendScroll(-e.deltaX, -e.deltaY);
  };
  useEffect(() => {
    const SPECIAL = { Enter: "return", Backspace: "delete", Tab: "tab", Escape: "esc", ArrowLeft: "arrow-left", ArrowRight: "arrow-right", ArrowUp: "arrow-up", ArrowDown: "arrow-down", Delete: "fwd-delete", PageUp: "page-up", PageDown: "page-down", Home: "home", End: "end" };
    const onKey = (e) => {
      if (e.target === kbd.current) return; // the phone keyboard has its own handler
      if (e.target.closest?.("input, textarea, select")) return;
      const mods = [e.metaKey && "cmd", e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && SPECIAL[e.key] && "shift"].filter(Boolean);
      if (SPECIAL[e.key]) {
        e.preventDefault();
        pressKey([...mods, SPECIAL[e.key]].join("+"));
      } else if (e.key.length === 1) {
        e.preventDefault();
        if (e.metaKey || e.ctrlKey || e.altKey) pressKey([...mods, e.key.toLowerCase()].join("+"));
        else typeText(e.key);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---- phone keyboard: a hidden field that forwards every keystroke
  const onBeforeInput = (e) => {
    e.preventDefault();
    if (e.inputType === "insertText" || e.inputType === "insertReplacementText") typeText(e.data || "");
    else if (e.inputType === "deleteContentBackward") pressKey("delete");
    else if (e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") pressKey("return");
  };
  const onKbdKey = (e) => {
    const map = { Enter: "return", Backspace: "delete", Tab: "tab", Escape: "esc" };
    if (map[e.key] && e.key !== "Backspace") {
      e.preventDefault();
      pressKey(map[e.key]);
    }
  };

  // Clipboard sync, like Chrome Remote Desktop: this device's clipboard → the Mac's.
  const sendClipboard = async () => {
    let text = null;
    try { text = await navigator.clipboard.readText(); } catch {}
    if (text == null) text = prompt("Text to put on the Mac's clipboard:");
    if (!text) return;
    if (!link.send({ t: "clip-set", text })) toast("Clipboard needs the live connection");
  };
  const cursorStyle = `left:${cursor.x * 100}%;top:${cursor.y * 100}%`;
  return html`<div class="remote" role="dialog" aria-label="Control your Mac">
    <div class="remote-top">
      ${fallback
        ? html`<span class=${`chip ${info.live ? "live" : ""}`}>${info.live ? `Live · ${info.fps} fps` : info.slow ? "Snapshots (slow link)" : info.error ? "Not connected" : "Connecting…"}</span>`
        : html`<span class=${`chip ${link.info.live ? "live" : ""}`}>${link.info.live ? `Live · ${link.info.fps} fps${link.info.rtt != null ? ` · ${link.info.rtt} ms` : ""}` : link.info.error ? "Not connected" : "Connecting…"}</span>`}
      ${view.s > 1 ? html`<button class="chip btn" onClick=${() => setView({ s: 1, tx: 0, ty: 0 })}>${view.s.toFixed(1)}× · Reset zoom</button>` : null}
      ${dragging ? html`<span class="chip">Dragging</span>` : null}
      <span style="flex:1" />
      <button class="icon-btn" onClick=${onClose} aria-label="Close remote control"><${I.close} /></button>
    </div>
    <div class="remote-stage" ref=${stage} onPointerDown=${onPointerDown} onPointerMove=${onPointerMove} onPointerUp=${onPointerUp} onPointerCancel=${onPointerCancel}
      onClick=${onClick} onDblClick=${onDblClick} onContextMenu=${onContextMenu} onWheel=${onWheel}>
      <div class="remote-canvas" style=${`transform:translate(${view.tx}px,${view.ty}px) scale(${view.s})`}>
        <div class="remote-frame">
          <canvas ref=${canvas} class="remote-video" style=${fallback ? "display:none" : ""} aria-label="Your Mac's screen" />
          <img ref=${img} alt="Your Mac's screen" draggable="false" style=${fallback ? "" : "display:none"} />
          ${mode === "trackpad" ? html`<span class="remote-cursor" style=${cursorStyle}><svg viewBox="0 0 24 24"><path d="M5 3v16l4.5-4 3 7 3-1.3-3-6.7H18z" fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/></svg></span>` : null}
        </div>
      </div>
      ${fallback
        ? info.error && !info.live && !info.slow ? html`<div class="remote-error">${info.error}</div>` : null
        : link.info.error && !link.info.live ? html`<div class="remote-error">${link.info.error}</div>` : null}
      ${clip !== null
        ? html`<div class="remote-clip" onPointerDown=${(e) => e.stopPropagation()} onPointerUp=${(e) => e.stopPropagation()} onClick=${(e) => e.stopPropagation()} onDblClick=${(e) => e.stopPropagation()}><b>Mac clipboard</b><div class="remote-clip-text">${clip || "(empty)"}</div>
            <div style="display:flex;gap:8px"><button class="btn small primary" onClick=${() => (navigator.clipboard ? navigator.clipboard.writeText(clip).then(() => toast("Copied to this device")).catch(() => toast("Select the text and copy it")) : toast("Select the text and copy it"))}>Copy here</button>
            <button class="btn small" onClick=${() => setClip(null)}>Close</button></div></div>`
        : null}
    </div>
    ${keysOpen
      ? html`<div class="remote-keys">${REMOTE_KEYS.map(([label, k]) => html`<button class="btn small" onClick=${() => pressKey(k)}>${label}</button>`)}
          <button class="btn small" onClick=${sendClipboard}>Paste to Mac clipboard</button>
          <button class="btn small" onClick=${() => (link.send({ t: "clip-get" }) ? null : toast("Clipboard needs the live connection"))}>Get Mac clipboard</button></div>`
      : null}
    <div class="remote-bar">
      <${Seg} value=${mode} options=${[["trackpad", "Trackpad"], ["touch", "Touch"]]} onChange=${setMode} />
      <button class="btn small" onClick=${() => kbd.current?.focus()}>Keyboard</button>
      <button class=${`btn small ${keysOpen ? "primary" : ""}`} onClick=${() => setKeysOpen(!keysOpen)}>Keys</button>
      <button class="btn small" onClick=${() => act("pointer", { action: "right", nx: cursor.x, ny: cursor.y })}>Right-click</button>
      <select class="input" style="height:30px;width:auto;flex:none;padding:0 8px;font-size:13px" value=${quality} onChange=${(e) => setQuality(e.target.value)} aria-label="Stream quality">
        ${Object.entries(REMOTE_QUALITY).map(([k, q]) => html`<option value=${k}>${q.label}</option>`)}
      </select>
      <input ref=${kbd} class="remote-kbd" value="··" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" onBeforeInput=${onBeforeInput} onKeyDown=${onKbdKey} aria-label="Type on your Mac" />
    </div>
    <p class="remote-help">${mode === "trackpad"
      ? "Drag to move the pointer · tap to click · tap twice to double-click · two-finger tap for right-click · two fingers up and down to scroll · hold, then drag to drag · pinch to zoom"
      : "Tap where you want to click · hold for right-click · two fingers to scroll · pinch to zoom, then drag to look around"}</p>
  </div>`;
}

function FilesPanel({ onImage }) {
  const [files, reload] = useLoad(() => api("/files"), []);
  const store_ = useStore();
  const count = Object.values(store_.threads).reduce((n, t) => n + t.filter((m) => m.files?.length).length, 0);
  useEffect(() => reload(), [count]);
  if (!files) return html`<div class="empty">Loading…</div>`;
  if (!files.length) return html`<div class="empty">Files your bots create show up here.</div>`;
  return html`<div class="list">${files.map((f) => html`<div class="row">
    <span class="file-chip" style="padding:0;border:0;background:none"><span class="ext">${(f.path.split(".").pop() || "").slice(0, 4)}</span></span>
    <button class="grow" style="text-align:left" onClick=${() => (isImage(f.path) ? onImage(fileUrl(f.path)) : window.open(fileUrl(f.path), "_blank"))}>
      <b>${f.path.split("/").pop()}</b><span>${bytes(f.size)} · ${ago(f.mtime)} · ${f.path.split("/").slice(0, -1).join("/") || "workspace"}</span>
    </button>
    <a class="icon-btn" href=${fileUrl(f.path, true)} aria-label="Download"><${I.download} /></a>
  </div>`)}</div>`;
}

function MemoryPanel({ bot }) {
  const [data, reload] = useLoad(() => api(`/memory/${bot.id}`), [bot.id]);
  const [text, setText] = useState("");
  const del = (l) =>
    api(`/memory/${bot.id}/delete`, { method: "POST", body: l })
      .then((r) => {
        if (!r.ok) toast("Memory changed — refreshed");
        reload();
      })
      .catch(fail);
  const remember = (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    api("/send", { method: "POST", body: { botId: bot.id, text: `Remember this: ${text.trim()}` } }).then(() => toast("Sent — it'll save it")).catch(fail);
    setText("");
  };
  if (!data) return html`<div class="empty">Loading…</div>`;
  return html`<div>
    <div class="section-title">What ${bot.name} remembers</div>
    ${data.lines.length
      ? html`<div class="list">${data.lines.map((l) => html`<div class="row"><div class="grow"><span style="color:var(--text);white-space:normal">${l.text.replace(/^-\s*/, "")}</span></div>
          <button class="icon-btn" onClick=${() => del(l)} aria-label="Forget"><${I.trash} /></button></div>`)}</div>`
      : html`<div class="hint">Nothing yet. It saves lasting preferences as you chat.</div>`}
    <form class="type-row" onSubmit=${remember}><input class="input" placeholder="Tell it to remember…" value=${text} onInput=${(e) => setText(e.target.value)} /><button class="btn small primary">Save</button></form>
    <div class="section-title">Shared notes about you</div>
    <div class="card-body code" style="max-height:none">${data.shared || "(empty)"}</div>
  </div>`;
}

function Panel({ tab, setTab, bot, onClose, onImage, control, setControl }) {
  return html`<aside class="panel">
    <div class="panel-tabs">
      <button class=${`tab ${tab === "computer" ? "on" : ""}`} onClick=${() => setTab("computer")}>Computer</button>
      <button class=${`tab ${tab === "files" ? "on" : ""}`} onClick=${() => setTab("files")}>Files</button>
      <button class=${`tab ${tab === "memory" ? "on" : ""}`} onClick=${() => setTab("memory")}>Memory</button>
      <span style="flex:1" />
      <button class="icon-btn" onClick=${onClose} aria-label="Close panel"><${I.close} /></button>
    </div>
    <div class="panel-body">
      ${tab === "computer" ? html`<${ComputerPanel} setControl=${setControl} control=${control} />` : tab === "files" ? html`<${FilesPanel} onImage=${onImage} />` : html`<${MemoryPanel} bot=${bot} />`}
    </div>
  </aside>`;
}

// ============================================================ sheets
const copyText = (t, done = "Copied") =>
  navigator.clipboard ? navigator.clipboard.writeText(t).then(() => toast(done)).catch(() => toast(t)) : toast(t);

function RoutinesSheet({ st, botId, onClose }) {
  const [routines, reload] = useLoad(() => api("/routines"), []);
  const [tpl] = useLoad(() => api("/templates"), []);
  const run = (r) => api(`/routines/${r.id}/run`, { method: "POST" }).then(() => toast(`Test run of "${r.name}" started`)).catch(fail);
  const del = (r) => confirm(`Delete routine "${r.name}"?`) && api(`/routines/${r.id}`, { method: "DELETE" }).then(reload).catch(fail);
  const setup = (key) => api("/templates/routine", { method: "POST", body: { key, botId } }).then(() => { toast("Setting it up in the chat…"); onClose(); }).catch(fail);
  return html`<${Sheet} title="Routines" onClose=${onClose}>
    ${routines === null ? html`<div class="empty">Loading…</div>`
      : routines.length ? html`<div class="list">${routines.map((r) => html`<div class="row">
          <div class="grow"><b>${r.name}</b><span>${r.bot} · ${r.when ? r.when : `${r.schedule} · next ${r.next ? fmtDay(r.next) : "—"}`}</span></div>
          ${r.hook ? html`<button class="btn small" onClick=${() => copyText(location.origin + r.hook, "Link copied. Treat it like a password.")}>Copy link</button>` : null}
          <button class="btn small" onClick=${() => run(r)}><${I.play} /> Test</button>
          <button class="icon-btn" onClick=${() => del(r)} aria-label="Delete"><${I.trash} /></button>
        </div>`)}</div>`
      : html`<div class="hint">No routines yet. Pick one below, or just ask a bot: “every weekday at 9, check my inbox for invoices”.</div>`}
    <div class="section-title" style="margin-top:22px">Popular with real users</div>
    <div class="grid-cards">${tpl ? Object.entries(tpl.routines).map(([key, t]) => html`<button class="tpl" onClick=${() => setup(key)}><b>${t.label}</b><span>${t.schedule}</span></button>`) : null}</div>
  <//>`;
}

function SkillsSheet({ botId, onClose, setControl }) {
  const [skills, reload] = useLoad(() => api("/skills"), []);
  const [library, reloadLibrary] = useLoad(() => api("/skills/library"), []);
  const [editing, setEditing] = useState(null); // { name, text, versions }
  const importInput = useRef();
  const importFile = async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    api("/skills/import", { method: "POST", body: { fileName: file.name, data: await readAsBase64(file) } })
      .then((r) => { toast(`Imported ${r.name}`); reload(); })
      .catch(fail);
  };
  const addLibrary = (s) => api(`/skills/library/${s.name}`, { method: "POST" }).then(() => { toast(`Added ${s.name}`); reload(); reloadLibrary(); }).catch(fail);
  const restore = (v) => api(`/skills/${editing.name}/restore`, { method: "POST", body: { version: v.id } }).then(() => api(`/skills/${editing.name}`)).then((s) => { setEditing(s); toast("Restored that version"); }).catch(fail);
  const [title, setTitle] = useState("");
  const run = (s) => api(`/skills/${s.name}/run`, { method: "POST", body: { botId } }).then(() => { toast(`Running ${s.name}`); onClose(); }).catch(fail);
  const del = (s) => confirm(`Delete skill "${s.name}"?`) && api(`/skills/${s.name}`, { method: "DELETE" }).then(reload).catch(fail);
  const open = (s) => api(`/skills/${s.name}`).then(setEditing).catch(fail);
  const saveEdit = () => api(`/skills/${editing.name}`, { method: "PUT", body: { text: editing.text } }).then(() => { toast("Skill saved"); setEditing(null); reload(); }).catch(fail);
  const record = (e) => {
    e.preventDefault();
    api("/teach/start", { method: "POST", body: { botId, title } })
      .then(() => { toast("Recording. Do the task on the Mac, then tap Stop."); onClose(); if (coarse) setControl?.(true); })
      .catch(fail);
  };
  const walkthrough = () =>
    api("/send", { method: "POST", body: { botId, text: "I want to teach you a task so you can do it again later. Ask me what you need, then walk through it with me step by step (do the steps on this Mac as we go so we know they work). Note the criteria and edge cases I mention. When we're done, save it with save_skill and tell me how to run it." } })
      .then(onClose)
      .catch(fail);
  if (editing) {
    return html`<${Sheet} title=${editing.name} onClose=${() => setEditing(null)} actions=${html`<button class="btn small primary" onClick=${saveEdit}>Save</button>`}>
      <p class="hint" style="margin-top:0">Every bot follows these steps when it uses this skill. Keep the --- header at the top.</p>
      <textarea id="skill-text" class="input skill-editor" value=${editing.text} onInput=${(e) => setEditing({ ...editing, text: e.target.value })} spellcheck="false" />
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        <a class="btn small" href=${`/api/skills/${editing.name}/export`} download=${`${editing.name}.skill.md`}><${I.download} /> Export</a>
      </div>
      ${editing.versions?.length
        ? html`<div class="section-title">Earlier versions</div>
          <div class="list">${editing.versions.slice(0, 8).map((v) => html`<div class="row"><div class="grow"><b>${fmtDay(Date.parse(v.at))}</b><span>${Math.max(1, Math.round(v.bytes / 1000))} KB</span></div>
            <button class="btn small" onClick=${() => restore(v)}>Restore</button></div>`)}</div>`
        : null}
    <//>`;
  }
  return html`<${Sheet} title="Skills" onClose=${onClose}>
    <p class="hint" style="margin-top:0">Skills are how-tos your bots learned from you. Every bot can use them. Tap one to read or edit it.</p>
    <div class="section-title" style="margin-top:4px">Teach by showing</div>
    <form class="type-row" onSubmit=${record}>
      <input id="teach-title" class="input" placeholder="What's the task? e.g. Download my bank statement" value=${title} onInput=${(e) => setTitle(e.target.value)} />
      <button class="btn small primary" disabled=${!title.trim()}><span class="rec-dot" /> Record</button>
    </form>
    <p class="hint">Do it once on the Mac (up to 10 minutes), at the Mac or with remote control. Blip watches, then writes the steps and asks about anything unclear. Passwords you type are never shown to it.</p>
    <button class="btn small" style="margin-bottom:6px" onClick=${walkthrough}>Or explain it in the chat instead</button>
    <div style="display:flex;justify-content:space-between;align-items:center"><div class="section-title">Saved skills</div>
      <button class="btn small" onClick=${() => importInput.current.click()}>Import</button>
      <input type="file" accept=".md,text/markdown,text/plain" hidden ref=${importInput} onChange=${importFile} /></div>
    ${skills === null ? html`<div class="empty">Loading…</div>`
      : skills.length ? html`<div class="list">${skills.map((s) => html`<div class="row">
          <button class="grow skill-open" onClick=${() => open(s)}><b>${s.name}</b><span>${s.description}</span></button>
          <button class="btn small" onClick=${() => run(s)}><${I.play} /> Run</button>
          <button class="icon-btn" onClick=${() => del(s)} aria-label="Delete"><${I.trash} /></button>
        </div>`)}</div>`
      : html`<div class="empty">No skills yet. Record one above, add one from the library, or after a job say “save this as a skill”.</div>`}
    ${library?.some((s) => !s.installed)
      ? html`<div class="section-title">Library</div>
        <div class="list">${library.filter((s) => !s.installed).map((s) => html`<div class="row">
          <div class="grow"><b>${s.name}</b><span>${s.description}</span></div>
          <button class="btn small" onClick=${() => addLibrary(s)}>Add</button></div>`)}</div>`
      : null}
  <//>`;
}

/** Shown while a demo is being recorded: how long so far, and Stop (also over the remote screen). */
function TeachBanner({ st, setControl }) {
  const t = st.teach;
  const now = useNow(!!t?.recording, 1000);
  const [stopping, setStopping] = useState(false);
  if (!t?.recording) return null;
  const secs = Math.max(0, Math.round((now - t.startedAt) / 1000));
  const clock = (n) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
  const stop = () => {
    setStopping(true);
    api("/teach/stop", { method: "POST", body: {} })
      .then((r) => { toast(`Sent ${r.moments} key moments. Your bot is writing the skill.`); setControl?.(false); })
      .catch(fail)
      .finally(() => setStopping(false));
  };
  return html`<div class="teach-banner" role="status">
    <span class="rec-dot" /><span class="teach-clock">${clock(secs)} / ${clock(t.maxSeconds)}</span><span class="grow">Recording “${t.title || "demo"}”</span>
    ${coarse ? html`<button class="btn small" onClick=${() => setControl?.(true)}>Screen</button>` : null}
    <button class="btn small primary" disabled=${stopping} onClick=${stop}>${stopping ? "Saving…" : "Stop"}</button>
  </div>`;
}

function ActivitySheet({ onClose }) {
  const [tab, setTab] = useState("runs");
  const [runs] = useLoad(() => api("/history"), []);
  const [log] = useLoad(() => api("/log"), []);
  const icon = (st) => html`<span class="state-dot" style=${st === "failed" ? "color:var(--danger)" : ""}><${st === "done" ? I.okCircle : st === "failed" ? I.xCircle : I.dash} /></span>`;
  const decisionIcon = (d) => html`<span class="state-dot" style=${d === "denied" ? "color:var(--danger)" : ""}><${d === "denied" ? I.xCircle : I.okCircle} /></span>`;
  return html`<${Sheet} title="Activity" onClose=${onClose}>
    <${Seg} value=${tab} options=${[["runs", "Task runs"], ["log", "Actions & approvals"]]} onChange=${setTab} />
    <div class="list" style="margin-top:14px">
      ${tab === "runs"
        ? runs?.length ? runs.map((r) => html`<div class="row">${icon(r.status)}<div class="grow"><b>${r.bot} · ${r.label}</b><span>${fmtDay(r.at)} · ${dur(r.seconds * 1000)} · ${money(r.costUsd)}${r.summary ? ` · ${r.summary}` : ""}</span></div></div>`) : html`<div class="empty">No tasks yet.</div>`
        : log?.length ? log.map((e) => html`<div class="row">${decisionIcon(e.decision)}<div class="grow"><b>${e.bot || ""} · ${String(e.input).split("\n")[0]}</b><span>${fmtDay(e.at)} · ${e.decision}${e.reason ? ` · ${e.reason}` : ""}</span></div></div>`) : html`<div class="empty">No actions yet.</div>`}
    </div>
    <p class="hint">“Nothing new” means a routine checked and found nothing, so you weren't pinged. “auto” means allowed automatically (safe, or approved by Auto Review).</p>
  <//>`;
}

function urlB64ToUint8Array(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
async function enablePush(key) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("On iPhone: first add this app to your Home Screen (Share → Add to Home Screen), then open it from there.");
  if (!window.isSecureContext) throw new Error("Notifications need the secure https:// link (Tailscale). Run blip.sh link on the Mac.");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notifications were not allowed");
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(key) }));
  await api("/push/subscribe", { method: "POST", body: sub.toJSON() });
}

function PairPhone() {
  const [pair, setPair] = useState(null);
  const now = useNow(!!pair, 1000);
  const left = pair ? Math.max(0, Math.round((pair.expires - now) / 1000)) : 0;
  const start = () => api("/pair", { method: "POST" }).then(setPair).catch(fail);
  const copy = (t) => (navigator.clipboard ? navigator.clipboard.writeText(t).then(() => toast("Copied")).catch(() => toast(t)) : toast(t));
  const links = pair ? [...(pair.tailscale ? [pair.tailscale] : []), ...pair.lan] : [];
  return html`<div class="section-title">Connect your phone</div>
    ${!pair || left === 0
      ? html`<div class="row" style="border:1px solid var(--line);border-radius:14px"><div class="grow"><b>Use Blip on your iPhone or Android</b><span>Install it on the Home Screen like an app. No App Store needed.</span></div><button class="btn small primary" onClick=${start}>Show code</button></div>`
      : html`<div class="row" style="border:1px solid var(--line);border-radius:14px;display:grid;gap:12px">
          <div style="display:flex;align-items:baseline;gap:12px"><b style="font:600 34px var(--mono);letter-spacing:0.12em">${pair.pin.slice(0, 3)} ${pair.pin.slice(3)}</b><span class="hint">expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}</span></div>
          <ol class="hint" style="margin:0;padding-left:18px;display:grid;gap:4px">
            <li>On your phone, open ${links.length ? html`<b style="color:var(--text)">${links[0]}</b>` : "this Mac's address"} in Safari (iPhone) or Chrome (Android).</li>
            <li>iPhone: tap Share, then <b style="color:var(--text)">Add to Home Screen</b>. Android: tap <b style="color:var(--text)">Install app</b>.</li>
            <li>Open Blip from the Home Screen and type this code.</li>
          </ol>
          <div style="display:flex;gap:6px;flex-wrap:wrap">${links.map((l) => html`<button class="chip btn" onClick=${() => copy(l)}>Copy ${l.startsWith("https") ? "anywhere link" : "home Wi-Fi link"}</button>`)}</div>
          ${pair.tailscale ? null : html`<p class="hint" style="margin:0">The home Wi-Fi link only works on the same network, without notifications or the mic. For anywhere access, install Tailscale on the Mac and phone, then run <code>~/Blip/blip.sh remote</code>.</p>`}
        </div>`}`;
}

/** The agent's own email address: people can email Blip, and it writes back (every email is a draft you approve). */
function AgentEmail({ st }) {
  const [data, reload] = useLoad(() => api("/email"), []);
  const [form, setForm] = useState({ address: "", password: "", imapHost: "", smtpHost: "" });
  const [known, setKnown] = useState(true);
  const [busy, setBusy] = useState(false);
  const f = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const checkPreset = () => form.address.includes("@") && api(`/email/preset?address=${encodeURIComponent(form.address)}`).then((r) => setKnown(r.known)).catch(() => {});
  const save = (e) => {
    e.preventDefault();
    setBusy(true);
    api("/email", { method: "POST", body: form })
      .then(() => { toast("Connected. Your bot can now be emailed."); setForm({ address: "", password: "", imapHost: "", smtpHost: "" }); reload(); })
      .catch(fail)
      .finally(() => setBusy(false));
  };
  const email = data?.email;
  return html`<div class="section-title">Agent email</div>
    ${email
      ? html`<div class="row"><div class="grow"><b>${email.address}</b><span>${email.bot} reads it · ${email.lastCheck ? (email.lastCheck.ok ? `checked ${fmtDay(Date.parse(email.lastCheck.at))}` : `last check failed: ${email.lastCheck.error}`) : "checks every 2 minutes"}</span></div>
          <button class="btn small" onClick=${() => api("/email/check", { method: "POST" }).then((r) => { toast(r.found ? `${r.found} new email${r.found === 1 ? "" : "s"}` : "No new email"); reload(); }).catch(fail)}>Check now</button>
          <button class="icon-btn" onClick=${() => confirm(`Disconnect ${email.address}?`) && api("/email", { method: "DELETE" }).then(reload).catch(fail)} aria-label="Disconnect"><${I.trash} /></button></div>
        <p class="hint">People can email this address. ${email.bot} reads new mail, tells you what matters, and drafts replies. Nothing is sent until you approve the draft.</p>`
      : html`<p class="hint" style="margin-top:0">Give your bot its own email address. Make a new mailbox for it (for example a new Gmail), turn on 2-step verification there, create an app password, and enter both here. Every email it sends is a draft you approve first.</p>
        <form class="email-form" onSubmit=${save}>
          <input id="email-address" class="input" type="email" placeholder="blip.yourname@gmail.com" value=${form.address} onInput=${f("address")} onBlur=${checkPreset} autocapitalize="off" />
          <input id="email-password" class="input" type="password" placeholder="App password" value=${form.password} onInput=${f("password")} autocomplete="off" />
          ${known ? null : html`<input id="email-imap" class="input" placeholder="IMAP server (e.g. imap.example.com)" value=${form.imapHost} onInput=${f("imapHost")} autocapitalize="off" />
            <input id="email-smtp" class="input" placeholder="SMTP server (e.g. smtp.example.com)" value=${form.smtpHost} onInput=${f("smtpHost")} autocapitalize="off" />`}
          <button class="btn small primary" disabled=${busy || !form.address || !form.password}>${busy ? "Connecting…" : "Connect"}</button>
        </form>`}`;
}

/** Outage alerts: a ping link from a free uptime monitor, which alerts you when the Mac goes quiet. */
function HeartbeatRow({ h, reload }) {
  const [url, setUrl] = useState("");
  const [editing, setEditing] = useState(false);
  const save = (e) => {
    e.preventDefault();
    api("/heartbeat", { method: "POST", body: { url } })
      .then((r) => { toast(r.cleared ? "Outage alerts off" : r.ok ? "Ping sent. Your monitor should show it now." : `The monitor didn't answer (${r.status || r.error})`); setEditing(false); reload(); })
      .catch(fail);
  };
  const hb = h?.heartbeat;
  return html`<div class="section-title">Outage alerts</div>
    ${hb?.set && !editing
      ? html`<div class="row"><div class="grow"><b>On</b><span>${hb.last ? `Last ping ${fmtDay(Date.parse(hb.last.at))} · ${hb.last.ok ? "received" : "failed"}` : "Pinging every 5 minutes"}</span></div>
          <button class="btn small" onClick=${() => setEditing(true)}>Change</button></div>`
      : html`<p class="hint" style="margin-top:0">A Mac that's off can't warn you. Make a free check at healthchecks.io (period 5 minutes, grace 10), paste its ping link here, and it emails or texts you when Blip goes quiet.</p>
        <form class="type-row" onSubmit=${save}>
          <input id="heartbeat-url" class="input" placeholder="https://hc-ping.com/…" value=${url} onInput=${(e) => setUrl(e.target.value)} autocapitalize="off" />
          ${hb?.set
            ? html`<button class="btn small primary">${url ? "Save & test" : "Turn off"}</button>`
            : html`<button class="btn small primary" disabled=${!url.trim()}>Save & test</button>`}
        </form>`}`;
}

/** The Mac's health: last backup and self-test, plus Recover and Reset for when something gets stuck. */
function HealthSection() {
  const [h, reload] = useLoad(() => api("/health"), []);
  const [busy, setBusy] = useState(null);
  const [armed, setArmed] = useState(false); // Reset needs a second tap
  const [access, setAccess] = useState(null);
  const checkAccess = () => {
    setBusy("check");
    api("/check-mac", { method: "POST" }).then(setAccess).catch(fail).finally(() => setBusy(null));
  };
  const act = (what, label, body = {}) => {
    setBusy(what);
    api(`/${what}`, { method: "POST", body })
      .then((r) => { toast(r.steps ? r.steps.join(" · ") : label(r)); reload(); })
      .catch(fail)
      .finally(() => { setBusy(null); setArmed(false); });
  };
  const b = h?.lastBackup, t = h?.lastSelfTest;
  return html`<div class="section-title">This Mac</div>
    <div class="list">
      <div class="row"><div class="grow"><b>Self-test</b><span>${t ? `${t.passed}/${t.total} passed · ${fmtDay(Date.parse(t.at))}${t.failures.length ? ` · ${t.failures.join("; ")}` : ""}` : "Runs every night at 03:40"}</span></div>
        <button class="btn small" disabled=${!!busy} onClick=${() => act("selftest", (r) => `${r.passed}/${r.total} checks passed`)}>${busy === "selftest" ? "Testing…" : "Run now"}</button></div>
      <div class="row"><div class="grow"><b>Backup</b><span>${b ? (b.ok ? `${fmtDay(Date.parse(b.at))} · ${b.bytes >= 1e6 ? `${(b.bytes / 1e6).toFixed(0)} MB` : `${Math.max(1, Math.round(b.bytes / 1e3))} KB`} · 14 kept` : `Failed: ${b.error}`) : "Every night at 03:30, kept on this Mac"}</span></div>
        <button class="btn small" disabled=${!!busy} onClick=${() => act("backup", (r) => (r.ok ? "Backed up" : `Backup failed: ${r.error}`))}>${busy === "backup" ? "Backing up…" : "Back up now"}</button></div>
      ${h ? html`<div class="row"><div class="grow"><b>Running</b><span>Up ${dur(h.uptimeSeconds * 1000)} · ${h.engines.running} engine${h.engines.running === 1 ? "" : "s"} · ${h.diskFreeGB} GB free · v${h.version}</span></div></div>` : null}
    </div>
    <div style="display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap">
      <button class="btn small" disabled=${!!busy} onClick=${checkAccess}>${busy === "check" ? "Checking… (macOS may ask for permission)" : "Check Mac access"}</button>
      ${access ? html`<span class="hint">${access.passed}/${access.total} working</span>` : null}
    </div>
    ${access
      ? html`<div class="list access-list">${access.checks.map((c) => html`<div class="row">
          <span class="state-dot" style=${c.ok ? "" : "color:var(--danger)"}><${c.ok ? I.okCircle : I.xCircle} /></span>
          <div class="grow"><b>${c.name}</b><span>${c.ok ? c.detail : c.fix || c.detail}</span></div>
        </div>`)}</div>`
      : html`<p class="hint">Tries Calendar, Reminders, Contacts, Mail, file search, screen recording, mouse control and voice for real (a test event and reminder are made and deleted). Run it once on the Blip Mac after setup.</p>`}
    <p class="hint">Stuck? <b>Recover</b> stops tasks and restarts the engines and the browser; nothing is lost. <b>Reset</b> also starts a fresh chat for every bot (memory, routines and secrets stay).</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn" disabled=${!!busy} onClick=${() => act("recover")}>${busy === "recover" ? "Recovering…" : "Recover"}</button>
      <button class=${`btn ${armed ? "danger" : ""}`} disabled=${!!busy} onClick=${() => {
        if (!armed) { setArmed(true); setTimeout(() => setArmed(false), 4000); return; }
        act("reset", null, { confirm: "RESET" });
      }}>${busy === "reset" ? "Resetting…" : armed ? "Tap again to reset" : "Reset"}</button>
    </div>
    <${HeartbeatRow} h=${h} reload=${reload} />`;
}

function SettingsSheet({ st, onClose }) {
  const [rules, reloadRules] = useLoad(() => api("/rules"), []);
  const [connectors, reloadConnectors] = useLoad(() => api("/connectors"), []);
  const [secrets, reloadSecrets] = useLoad(() => api("/secrets"), []);
  const [newSecret, setNewSecret] = useState({ name: "", value: "" });
  const addSecret = (e) => {
    e.preventDefault();
    api("/secrets", { method: "POST", body: newSecret })
      .then(() => { setNewSecret({ name: "", value: "" }); reloadSecrets(); toast("Saved to the Keychain"); })
      .catch(fail);
  };
  const [newRule, setNewRule] = useState("");
  const [theme, setTheme] = useState(localStorage.getItem("theme") || "dark");
  // "On" only when this device really has a push subscription the Mac knows about (re-sent on every visit).
  const [pushOn, setPushOn] = useState(false);
  useEffect(() => {
    if (!("serviceWorker" in navigator) || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager?.getSubscription())
      .then((sub) => sub && api("/push/subscribe", { method: "POST", body: sub.toJSON() }).then(() => setPushOn(true)))
      .catch(() => {});
  }, []);
  const set = (patch) => api("/settings", { method: "PATCH", body: patch }).then(loadState).catch(fail);
  const pct = Math.min(100, (st.budget.today / st.budget.limit) * 100);
  const applyTheme = (t) => {
    setTheme(t);
    localStorage.setItem("theme", t);
    if (t === "dark") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
    setThemeColor(t);
  };
  return html`<${Sheet} title="Settings" onClose=${onClose}>
    <div class="section-title">Claude connection</div>
    ${st.authMode === "plan"
      ? html`<div class="row" style="border:1px solid var(--line);border-radius:14px;display:block">
          <div style="display:flex;align-items:center;gap:8px"><span class="pip" /><b style="font-weight:500">Running on your Claude plan</b></div>
          <p class="hint" style="margin:6px 0 0">Using the Claude account signed in on this Mac. Plan usage limits apply; costs shown are estimates. Add an API key later for pay-as-you-go with a daily cap.</p>
        </div>
        <${ConnectClaude} />`
      : html`<div class="row" style="border:1px solid var(--line);border-radius:14px"><span class="pip" /><div class="grow"><b>Anthropic API key</b><span>Pay-as-you-go, capped by your daily budget.</span></div></div>`}

    <div class="section-title">Spending</div>
    <div class="row" style="display:block">
      <div style="display:flex;justify-content:space-between"><b>Today ${money(st.budget.today)}</b><span class="hint">limit ${money(st.budget.limit)} · 7 days ${money(st.budget.week)}</span></div>
      <div class=${`meter ${pct >= 80 ? "hot" : ""}`}><i style=${`width:${pct}%`} /></div>
      <div class="hint" style="margin-top:8px">${st.bots.map((b) => `${b.name} ${money(b.spentToday)} (${shortModel(b.model)})`).join(" · ")}</div>
      <div class="hint" style="margin-top:4px">Change the daily limit with DAILY_BUDGET_USD in .env. You get warnings at 50%, 80% and 100%.</div>
    </div>

    <div class="section-title">Safety</div>
    <div class="toggle-row"><div class="grow"><b>Full access</b><span>Bots act on their own: terminal, files, clicks, sending, deleting. Only payments, protected files and your Ask-first rules still ask.</span></div><${Switch} on=${st.settings.fullAccess} onChange=${(v) => set({ fullAccess: v })} /></div>
    <div class="toggle-row"><div class="grow"><b>Double-check results</b><span>After a task that changes files, your calendar, reminders, routines or skills, an independent checker confirms it really happened. You only hear about it if it didn't.</span></div><${Switch} on=${st.settings.verify !== false} onChange=${(v) => set({ verify: v })} /></div>
    <div class="toggle-row"><div class="grow"><b>Auto Review</b><span>An independent AI checks risky actions and only asks you when it matters.</span></div><${Switch} on=${st.settings.autoReview} onChange=${(v) => set({ autoReview: v })} /></div>
    <div class="toggle-row"><div class="grow"><b>Proactive suggestions</b><span>Your primary bot looks at your calendar, unread mail, failed routines and new files (read-only) and suggests at most 3 things a day.</span></div>
      <${Seg} value=${!st.settings.proactive ? "off" : st.settings.proactiveMode || "thrice"} options=${[["off", "Off"], ["morning", "Mornings"], ["thrice", "3× a day"]]} onChange=${(v) => set(v === "off" ? { proactive: false } : { proactive: true, proactiveMode: v })} /></div>
    <p class="hint" style="margin-top:-4px"><button class="linkish" onClick=${() => api("/proactive/run", { method: "POST" }).then((r) => toast(r.started ? "Checking now; it shows in your primary bot's chat" : "Your primary bot is busy; try again in a minute")).catch(fail)}>Check now</button></p>
    <div class="toggle-row"><div class="grow"><b>Spoken replies</b><span>Read every reply aloud (voice messages always get spoken replies).</span></div><${Switch} on=${st.settings.voiceReplies} onChange=${(v) => set({ voiceReplies: v })} /></div>

    <div class="section-title">Always ask first</div>
    <p class="hint" style="margin-top:0">Anything that sends, pays, deletes, books or accepts is always checked with you. Add your own words here.</p>
    <div class="list">${(rules || []).map((r) => html`<div class="row"><div class="grow"><b>${r.text}</b></div><button class="icon-btn" onClick=${() => api(`/rules/${r.id}`, { method: "DELETE" }).then(reloadRules).catch(fail)} aria-label="Remove"><${I.trash} /></button></div>`)}</div>
    <form class="type-row" onSubmit=${(e) => { e.preventDefault(); api("/rules", { method: "POST", body: { match: newRule } }).then(() => { setNewRule(""); reloadRules(); }).catch(fail); }}>
      <input class="input" placeholder='e.g. "amazon" or "git push"' value=${newRule} onInput=${(e) => setNewRule(e.target.value)} /><button class="btn small primary" disabled=${!newRule.trim()}>Add</button>
    </form>

    <div class="section-title">Secrets</div>
    <p class="hint" style="margin-top:0">Passwords and API keys, kept in this Mac's Keychain. Bots use them by name and never see the values; each use asks you first.</p>
    ${secrets?.length
      ? html`<div class="list">${secrets.map((x) => html`<div class="row"><div class="grow"><b>${x.name}</b><span>${x.note || "Saved"}${x.lastUsedAt ? ` · last used ${fmtDay(Date.parse(x.lastUsedAt))}` : ""}</span></div>
          <button class="icon-btn" onClick=${() => confirm(`Delete the secret "${x.name}" from the Keychain?`) && api(`/secrets/${encodeURIComponent(x.name)}`, { method: "DELETE" }).then(reloadSecrets).catch(fail)} aria-label="Delete"><${I.trash} /></button></div>`)}</div>`
      : null}
    <form class="type-row" onSubmit=${addSecret}>
      <input class="input" style="flex:0.8" placeholder="Name" value=${newSecret.name} onInput=${(e) => setNewSecret({ ...newSecret, name: e.target.value })} autocapitalize="off" />
      <input class="input" type="password" autocomplete="off" placeholder="Value" value=${newSecret.value} onInput=${(e) => setNewSecret({ ...newSecret, value: e.target.value })} />
      <button class="btn small primary" disabled=${!newSecret.name.trim() || !newSecret.value}>Save</button>
    </form>

    <${HealthSection} />

    <${AgentEmail} st=${st} />

    <div class="section-title">Connected apps</div>
    ${connectors?.length
      ? html`<div class="list">${connectors.map((c) => html`<div class="row"><div class="grow"><b>${c.name}</b><span>${c.target}</span></div>
          <${Seg} value=${c.access} options=${[["read", "Read"], ["full", "Full"], ["off", "Off"]]} onChange=${(v) => api(`/connectors/${c.name}`, { method: "PATCH", body: { access: v } }).then(reloadConnectors).catch(fail)} />
          <button class="icon-btn" onClick=${() => api(`/connectors/${c.name}`, { method: "DELETE" }).then(reloadConnectors).catch(fail)} aria-label="Remove"><${I.trash} /></button></div>`)}</div>`
      : html`<p class="hint">None yet — ask a bot “connect my Notion”. Most sites already work through the bot's browser once you sign in.</p>`}

    <${PairPhone} />

    <div class="section-title">This device</div>
    ${nativeBridge?.blipNotify ? null : html`<div class="toggle-row"><div class="grow"><b>Notifications</b><span>Get pinged for approvals, replies and routine results.</span></div>
      <button class="btn small" disabled=${pushOn} onClick=${() => enablePush(st.pushKey).then(() => { setPushOn(true); toast("Notifications on"); }).catch(fail)}>${pushOn ? "On" : "Turn on"}</button></div>`}
    <div class="toggle-row"><div class="grow"><b>Appearance</b></div><${Seg} value=${theme} options=${[["dark", "Dark"], ["light", "Light"], ["auto", "Auto"]]} onChange=${applyTheme} /></div>
    <p class="hint">Install on iPhone: open this page in Safari → Share → Add to Home Screen. ${st.telegram ? "Telegram is connected as an extra channel." : ""}</p>
  <//>`;
}

function NewBotSheet({ onClose, onCreated }) {
  const [tpl] = useLoad(() => api("/templates"), []);
  const [form, setForm] = useState({ name: "", job: "", style: "" });
  const create = (body) => api("/bots", { method: "POST", body }).then(({ id }) => { onClose(); onCreated(id, !body.template); }).catch(fail);
  const f = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return html`<${Sheet} title="New bot" onClose=${onClose}>
    <div class="section-title">Start from a template</div>
    <div class="grid-cards">${tpl ? Object.entries(tpl.bots).map(([key, t]) => html`<button class="tpl" onClick=${() => create({ template: key })}><${Blip} size=${48} still tight look=${t.look} /><b>${t.label}</b><span>${t.job.slice(0, 90)}…</span></button>`) : null}</div>
    <div class="section-title" style="margin-top:22px">Or make your own</div>
    <div style="display:flex;gap:10px">
      <div class="field" style="flex:1"><label>Name</label><input class="input" value=${form.name} onInput=${f("name")} placeholder="e.g. Max" /></div>
    </div>
    <div class="field"><label>Job</label><textarea class="input" value=${form.job} onInput=${f("job")} placeholder="What should it own? e.g. Find deals and get quotes; never buy without asking." /></div>
    <div class="field"><label>Personality (optional)</label><input class="input" value=${form.style} onInput=${f("style")} placeholder="e.g. Witty and brief" /></div>
    <button class="btn primary" disabled=${!form.name.trim() || !form.job.trim()} onClick=${() => create(form)}>Create bot</button>
  <//>`;
}

const PART_LABEL = { color: "Color", hat: "Hat", eyes: "Eyes", face: "Face", neck: "Neck", hold: "Holding" };
const MOODS = [["idle", "Idle"], ["working", "Working"], ["needs", "Needs you"], ["done", "Done"], ["sleep", "Asleep"]];

/** Customize a bot's Blip: every option is previewed on the bot's own Blip. */
function StyleSheet({ bot, onClose }) {
  const [look, setLook] = useState({ ...(bot.look || {}) });
  const [part, setPart] = useState("hat");
  const [mood, setMood] = useState("idle");
  const [busy, setBusy] = useState(false);
  const withPart = (pt, id) => {
    const next = { ...look };
    if (id === "none" || id === "classic") delete next[pt];
    else next[pt] = id;
    return next;
  };
  const randomize = () => {
    const next = {};
    for (const pt of LOOK_PARTS) {
      const opts = LOOKS[pt].slice(1);
      if (Math.random() < (pt === "color" ? 0.45 : pt === "face" ? 0.35 : 0.55)) next[pt] = opts[Math.floor(Math.random() * opts.length)].id;
    }
    setLook(next);
  };
  const save = async () => {
    setBusy(true);
    try {
      await api(`/bots/${bot.id}`, { method: "PATCH", body: { look } });
      await loadState();
      toast(`${bot.name} looks great`);
      onClose();
    } catch (e) {
      fail(e);
      setBusy(false);
    }
  };
  return html`<${Sheet} title=${`Customize ${bot.name}`} onClose=${onClose}>
    <div class="style-stage"><${Blip} size=${170} state=${mood} look=${look} /></div>
    <div style="display:flex;justify-content:center;margin:-4px 0 18px"><${Seg} value=${mood} options=${MOODS} onChange=${setMood} /></div>
    <div class="style-tabs">${LOOK_PARTS.map((pt) => html`<button class=${`tab ${pt === part ? "on" : ""}`} onClick=${() => setPart(pt)}>${PART_LABEL[pt]}</button>`)}</div>
    <div class="style-grid">
      ${LOOKS[part].map((o) => {
        const chosen = (look[part] || (part === "color" ? "classic" : "none")) === o.id;
        return html`<button class=${`style-tile ${chosen ? "on" : ""}`} onClick=${() => setLook(withPart(part, o.id))} aria-pressed=${chosen}>
          <${Blip} size=${62} still tight look=${withPart(part, o.id)} />
          <span>${o.label}</span>
        </button>`;
      })}
    </div>
    <div style="display:flex;gap:8px;margin-top:18px;flex-wrap:wrap">
      <button class="btn" onClick=${randomize}>Randomize</button>
      <button class="btn ghost" onClick=${() => setLook({})}>Reset</button>
      <span style="flex:1" />
      <button class="btn primary" disabled=${busy} onClick=${save}>${busy ? "Saving…" : "Save look"}</button>
    </div>
  <//>`;
}

function BotSheet({ bot, st, onClose, onStyle }) {
  const [form, setForm] = useState({ name: bot.name, job: bot.job, style: bot.style });
  const alias = bot.model === "auto" ? "auto" : st.models.find((m) => m.id === bot.model)?.alias || bot.model;
  const patch = (body) => api(`/bots/${bot.id}`, { method: "PATCH", body }).then(loadState).then(() => true, (e) => (fail(e), false));
  const f = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return html`<${Sheet} title=${bot.name} onClose=${onClose}>
    <div class="row" style="border:1px solid var(--line);border-radius:16px;margin-bottom:16px">
      <${Blip} size=${64} look=${bot.look} />
      <div class="grow"><b>${bot.name}'s Blip</b><span>Hats, glasses, mustaches, a ₿ chain and more.</span></div>
      <button class="btn small primary" onClick=${onStyle}>Customize</button>
    </div>
    <div style="display:flex;gap:10px">
      <div class="field" style="flex:1"><label>Name</label><input class="input" value=${form.name} onInput=${f("name")} /></div>
    </div>
    <div class="field"><label>Job</label><textarea class="input" value=${form.job} onInput=${f("job")} /></div>
    <div class="field"><label>Extra style (optional)</label><input class="input" value=${form.style} onInput=${f("style")} placeholder="e.g. Talks like a trader" /></div>
    <button class="btn primary" onClick=${() => patch(form).then((ok) => ok && toast("Saved"))}>Save</button>
    <div class="section-title" style="margin-top:22px">Personality</div>
    <${Seg} value=${bot.spice || "medium"} options=${[["low", "Professional"], ["medium", "Blip"], ["high", "Spicy"]]} onChange=${(v) => patch({ spice: v })} />
    <p class="hint">${{ low: "Straight to the point, no jokes.", medium: "Sharp, direct, the occasional dry line. The default.", high: "More opinions, more attitude. Still never careless with your money or approvals." }[bot.spice || "medium"]}</p>
    <div class="section-title" style="margin-top:22px">Model</div>
    <${Seg} value=${alias} options=${[["auto", "Auto"], ["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"]]} onChange=${(v) => patch({ model: v })} />
    <p class="hint">Auto answers quick chat on Sonnet and gives real jobs (research, browsing, building, email) to Opus. Context used: ${Math.round(bot.contextTokens / 1000)}k tokens. Long chats cost more per message — start a new chat to reset (memory is kept).</p>
    <div class="toggle-row"><div class="grow"><b>Own browser</b><span>Browses at the same time as your other bots instead of taking turns. Starts with a copy of your logins; sign-ins you do later in it stay with this bot.</span></div><${Switch} on=${bot.ownBrowser} onChange=${(v) => patch({ ownBrowser: v })} /></div>
    <div class="toggle-row"><div class="grow"><b>Quiet</b><span>Deliver this bot's messages without sound. Approvals still notify.</span></div><${Switch} on=${bot.quiet} onChange=${(v) => patch({ quiet: v })} /></div>
    <div class="toggle-row"><div class="grow"><b>Primary bot</b><span>Runs proactive check-ins and offers to help.</span></div>${st.primaryBotId === bot.id ? html`<span class="chip">Primary</span>` : html`<button class="btn small" onClick=${() => patch({ primary: true })}>Make primary</button>`}</div>
    <div style="display:flex;gap:8px;margin-top:18px;flex-wrap:wrap">
      <button class="btn" onClick=${() => api(`/bots/${bot.id}/fresh`, { method: "POST" }).then(() => { toast("New chat started — memory kept"); onClose(); }).catch(fail)}><${I.new} /> New chat</button>
      ${st.bots.length > 1 ? html`<button class="btn danger" onClick=${() => confirm(`Delete ${bot.name}, its chat and its routines?`) && api(`/bots/${bot.id}`, { method: "DELETE" }).then(() => { loadState(); onClose(); }).catch(fail)}><${I.trash} /> Delete bot</button>` : null}
    </div>
  <//>`;
}

// ============================================================ first-run: connect Claude
function ConnectClaude() {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/setup/key", { method: "POST", body: { key } });
      setKey("");
      toast("API key connected");
      loadState();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  return html`<form class="type-row" onSubmit=${save}>
    <input class="input" type="password" placeholder="Paste an API key (sk-ant-…) — optional" value=${key} onInput=${(e) => setKey(e.target.value)} autocomplete="off" />
    <button class="btn primary" disabled=${!key.trim() || busy}>${busy ? "Checking…" : "Add key"}</button>
  </form>`;
}

// ============================================================ main view
const STARTERS = [
  { label: "Morning inbox brief", routine: "inbox" },
  { label: "What am I forgetting?", routine: "forgetting" },
  { label: "Find the best price on…", text: "Find the best price on " },
  { label: "Plan my week", text: "Look at my calendar and plan my week: " },
  { label: "Research a topic", text: "Research this and send me a short PDF report: " },
];

const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
let deferredInstall = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstall = e;
  emit();
});

function InstallHint() {
  const [hidden, setHidden] = useState(() => {
    try { return localStorage.getItem("install-hint") === "hidden"; } catch { return false; }
  });
  if (standalone || hidden || nativeBridge?.blipNotify || (!isIOS && !deferredInstall)) return null;
  const hide = () => {
    setHidden(true);
    try { localStorage.setItem("install-hint", "hidden"); } catch {}
  };
  return html`<div class="card" style="margin:6px 16px 0;padding:12px 14px;grid-template-columns:auto 1fr auto;align-items:center;gap:12px;max-width:740px;align-self:center;width:calc(100% - 32px)">
    <${Blip} size=${30} tight />
    <div class="hint" style="color:var(--text-2)">${isIOS ? html`Install Blip: tap <b style="color:var(--text)">Share</b>, then <b style="color:var(--text)">Add to Home Screen</b>.` : "Install Blip as an app on this device."}</div>
    <div style="display:flex;gap:6px">${!isIOS ? html`<button class="btn small primary" onClick=${() => deferredInstall?.prompt().then(hide)}>Install</button>` : null}<button class="btn small ghost" onClick=${hide}>Later</button></div>
  </div>`;
}

function ChatView({ st, bot, onMenu, panel, setPanel, onSheet, onImage, setControl }) {
  const messages = store.threads[bot.id];
  const s = botStatus(bot, st);
  const [preset, setPreset] = useState(null);
  const togglePanel = (tab) => setPanel(panel === tab ? null : tab);
  const fresh = messages && messages.filter((m) => m.role === "user").length === 0;
  const starter = (x) =>
    x.routine
      ? api("/templates/routine", { method: "POST", body: { key: x.routine, botId: bot.id } }).catch(fail)
      : setPreset(x.text);
  const anyAttention = Object.keys(store.unread).some((k) => store.unread[k] && k !== bot.id) || st.runtime.pendingCards;
  return html`<main class="main">
    <header class="topbar">
      <button class="icon-btn mobile-only" onClick=${onMenu} aria-label="Menu"><${I.menu} />${anyAttention ? html`<span class="badge" style="position:absolute;top:5px;right:5px;min-width:8px;height:8px;padding:0" />` : null}</button>
      <button class="title" onClick=${() => onSheet({ type: "bot" })}>
        <${Avatar} bot=${bot} size=${32} status=${s.dot} />
        <span class="t-wrap"><b>${bot.name}</b><span class=${`sub ${s.cls}`}>${s.text}</span></span>
      </button>
      <button class=${`icon-btn ${panel === "computer" ? "on" : ""}`} onClick=${() => togglePanel("computer")} aria-label="Computer" title="Computer"><${I.computer} /></button>
      <button class=${`icon-btn ${panel === "files" ? "on" : ""}`} onClick=${() => togglePanel("files")} aria-label="Files" title="Files"><${I.files} /></button>
      ${bot.group ? null : html`<button class=${`icon-btn ${panel === "memory" ? "on" : ""}`} onClick=${() => togglePanel("memory")} aria-label="Memory" title="Memory"><${I.brain} /></button>`}
      <button class="icon-btn" onClick=${() => onSheet({ type: "bot" })} aria-label=${bot.group ? "Group settings" : "Bot settings"} title=${bot.group ? "Group settings" : "Bot settings"}><${I.more} /></button>
    </header>
    <${InstallHint} />
    <${MessageList} bot=${bot} messages=${messages} onImage=${onImage} onTakeover=${() => { setPanel("computer"); setControl(true); }} />
    ${fresh && !bot.group ? html`<div class="starters">${STARTERS.map((x) => html`<button class="starter" onClick=${() => starter(x)}>${x.label}</button>`)}</div>` : null}
    <${Composer} key=${bot.id} bot=${bot} st=${st} onModel=${() => onSheet({ type: "bot" })} preset=${preset} clearPreset=${() => setPreset(null)} />
  </main>`;
}

/** Make or edit a group chat: a name, 2 to 6 bots, and which one leads. */
function GroupSheet({ st, group, onClose, onCreated, onDeleted }) {
  const [name, setName] = useState(group?.name || "");
  const [members, setMembers] = useState(group?.members || []);
  const [lead, setLead] = useState(group?.leadId || "");
  const [armed, setArmed] = useState(false);
  const toggle = (id) => setMembers(members.includes(id) ? members.filter((m) => m !== id) : [...members, id]);
  const leadId = members.includes(lead) ? lead : members[0];
  const save = () => {
    const body = { name, members, leadId };
    (group ? api(`/groups/${group.id}`, { method: "PATCH", body }) : api("/groups", { method: "POST", body }))
      .then((r) => (group ? loadState().then(() => { toast("Saved"); onClose(); }) : onCreated(r.id)))
      .catch(fail);
  };
  const remove = () => {
    if (!armed) return setArmed(true);
    api(`/groups/${group.id}`, { method: "DELETE" }).then(loadState).then(onDeleted).catch(fail);
  };
  return html`<${Sheet} title=${group ? group.name : "New group"} onClose=${onClose}>
    <p class="hint" style="margin-top:0">One chat with several bots. The lead answers and hands parts of the job to the others; they work at the same time and you watch it happen. Write "@Name" to ask one bot directly.</p>
    <div class="field"><label>Name</label><input id="group-name" class="input" placeholder="e.g. Content team" value=${name} onInput=${(e) => setName(e.target.value)} /></div>
    <div class="section-title">Bots (${members.length})</div>
    <div class="list">${st.bots.map((b) => html`<label class="row group-pick">
      <input type="checkbox" checked=${members.includes(b.id)} onChange=${() => toggle(b.id)} />
      <${Avatar} bot=${b} size=${30} still />
      <div class="grow"><b>${b.name}${b.helper ? html` <span class="chip" style="padding:0 6px;font-size:10.5px">Helper</span>` : null}</b><span>${b.job}</span></div>
      ${members.includes(b.id) ? html`<button type="button" class=${`btn small ${leadId === b.id ? "primary" : ""}`} onClick=${(e) => { e.preventDefault(); setLead(b.id); }}>${leadId === b.id ? "Lead" : "Make lead"}</button>` : null}
    </label>`)}</div>
    <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">
      <button class="btn primary" disabled=${!name.trim() || members.length < 2 || members.length > 6} onClick=${save}>${group ? "Save" : "Create group"}</button>
      ${group ? html`<button class="btn" onClick=${() => api(`/groups/${group.id}/fresh`, { method: "POST" }).then(() => { toast("New chat started for this group"); onClose(); }).catch(fail)}><${I.new} /> New chat</button>` : null}
      ${group ? html`<button class=${`btn ${armed ? "danger" : ""}`} onClick=${remove}><${I.trash} /> ${armed ? "Tap again to delete" : "Delete group"}</button>` : null}
    </div>
  <//>`;
}

function Shell() {
  const s = useStore();
  const st = s.state;
  const [sidebar, setSidebar] = useState(false);
  const [panel, setPanel] = useState(() => (window.innerWidth > 1200 ? localStorage.getItem("panel") || null : null));
  const [control, setControl] = useState(false);
  const [sheet, setSheet] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [botId, setBotId] = useState(() => {
    // A notification opens the app on its bot once; afterwards the URL mustn't keep overriding your choice.
    const fromLink = new URLSearchParams(location.search).get("bot");
    if (fromLink) {
      try { history.replaceState(null, "", location.pathname); } catch {}
      try { localStorage.setItem("bot", fromLink); } catch {}
    }
    return fromLink || localStorage.getItem("bot");
  });

  const group = (st.groups || []).find((g) => g.id === botId);
  const bot = group ? groupAsBot(group, st) : st.bots.find((b) => b.id === botId) || st.bots.find((b) => b.id === st.activeBotId) || st.bots[0];
  selected = bot.id;
  const select = (id) => {
    setBotId(id);
    setSidebar(false);
    localStorage.setItem("bot", id);
    store.unread = { ...store.unread, [id]: 0 };
    if (!id.startsWith("g-")) api(`/bots/${id}`, { method: "PATCH", body: { active: true } }).catch(() => {});
    emit();
  };
  useEffect(() => {
    if (!store.threads[bot.id]) loadThread(bot.id).catch(() => setTimeout(() => !store.threads[bot.id] && loadThread(bot.id).catch(fail), 3000));
    if (store.unread[bot.id]) {
      store.unread = { ...store.unread, [bot.id]: 0 };
      emit();
    }
  }, [bot.id]);
  useEffect(() => {
    try {
      panel ? localStorage.setItem("panel", panel) : localStorage.removeItem("panel");
    } catch {}
  }, [panel]);
  useEffect(() => {
    const onMsg = (e) => e.data?.type === "open-bot" && e.data.botId && select(e.data.botId);
    navigator.serviceWorker?.addEventListener("message", onMsg);
    return () => navigator.serviceWorker?.removeEventListener("message", onMsg);
  }, []);

  return html`<div class=${`shell ${panel ? "with-panel" : ""}`}>
    <${OfflineBanner} />
    <${TeachBanner} st=${st} setControl=${setControl} />
    <${Sidebar} st=${st} open=${sidebar} onSelect=${select} onSheet=${(x) => { setSheet(x); setSidebar(false); }} onClose=${() => setSidebar(false)} />
    <${ChatView} st=${st} bot=${bot} onMenu=${() => setSidebar(true)} panel=${panel} setPanel=${setPanel} onSheet=${setSheet} onImage=${setLightbox} setControl=${setControl} />
    ${panel ? html`<${Panel} tab=${panel} setTab=${setPanel} bot=${bot} onClose=${() => setPanel(null)} onImage=${setLightbox} control=${control} setControl=${setControl} />` : null}
    ${sheet?.type === "routines" ? html`<${RoutinesSheet} st=${st} botId=${bot.id} onClose=${() => setSheet(null)} />` : null}
    ${sheet?.type === "skills" ? html`<${SkillsSheet} setControl=${setControl} botId=${bot.id} onClose=${() => setSheet(null)} />` : null}
    ${sheet?.type === "activity" ? html`<${ActivitySheet} onClose=${() => setSheet(null)} />` : null}
    ${sheet?.type === "settings" ? html`<${SettingsSheet} st=${st} onClose=${() => setSheet(null)} />` : null}
    ${sheet?.type === "newbot" ? html`<${NewBotSheet} onClose=${() => setSheet(null)} onCreated=${(id, custom) => loadState().then(() => { select(id); if (custom) setSheet({ type: "style" }); })} />` : null}
    ${sheet?.type === "bot" && !bot.group ? html`<${BotSheet} bot=${bot} st=${st} onClose=${() => setSheet(null)} onStyle=${() => setSheet({ type: "style" })} />` : null}
    ${sheet?.type === "bot" && bot.group ? html`<${GroupSheet} st=${st} group=${bot.group} onClose=${() => setSheet(null)} onDeleted=${() => { setSheet(null); select(st.activeBotId); }} />` : null}
    ${sheet?.type === "newgroup" ? html`<${GroupSheet} st=${st} onClose=${() => setSheet(null)} onCreated=${(id) => loadState().then(() => { setSheet(null); select(id); })} />` : null}
    ${sheet?.type === "style" ? html`<${StyleSheet} bot=${bot} onClose=${() => setSheet(null)} />` : null}
    ${control ? html`<${RemoteView} onClose=${() => setControl(false)} />` : null}
    ${lightbox ? html`<div class="lightbox" onClick=${() => setLightbox(null)}><img src=${lightbox} alt="" /></div>` : null}
    ${s.toast ? html`<div class="toast">${s.toast}</div>` : null}
  </div>`;
}

const sinceText = (t) => {
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return today ? fmtTime(t) : fmtDay(t);
};

/** Opened while the Mac is unreachable: say so plainly, keep retrying. */
function OfflineScreen() {
  useNow(true, 30_000);
  return html`<div class="offline-screen">
    <${Blip} size=${72} state="sleep" />
    <h1>Your Mac isn't reachable</h1>
    <p>Since ${sinceText(offlineSince)}. Blip keeps trying and picks up the moment it's back.</p>
    <ul class="hint">
      <li>Is the Mac on, awake and on the charger?</li>
      <li>Is it connected to the internet, with Tailscale on?</li>
      <li>After a restart, Blip starts by itself once you're logged in.</li>
    </ul>
  </div>`;
}

function OfflineBanner() {
  useNow(!!offlineSince, 2000);
  if (!offlineSince || Date.now() - offlineSince < 8000) return null; // ignore blips while it restarts
  return html`<div class="offline-banner" role="status">Mac offline since ${sinceText(offlineSince)} · retrying</div>`;
}

function App() {
  const s = useStore();
  const [authed, setAuthed] = useState(null);
  const boot = () =>
    loadState()
      .then(() => setAuthed(true))
      .catch((e) => {
        if (e instanceof AuthError) setAuthed(false);
        else setTimeout(boot, 2000); // Mac restarting: keep trying
      });
  useEffect(boot, []);
  useEffect(() => {
    if (!authed) return;
    // The server sends "hello" on connect and "ping" every 20s. If neither gets through (some tunnels buffer
    // the stream), poll instead so replies still show up.
    let lastBeat = 0;
    let es;
    let retry;
    let backoff = 1000;
    const beat = () => (lastBeat = Date.now());
    let opened = Date.now();
    const poll = setInterval(() => {
      const quiet = lastBeat ? Date.now() - lastBeat > 45_000 : Date.now() - opened > 4000;
      if (!quiet || document.hidden) return;
      loadState().catch(() => {});
      for (const id of Object.keys(store.threads)) pollThread(id);
    }, 2500);
    const connect = () => {
      es?.close();
      opened = Date.now();
      lastBeat = 0;
      es = new EventSource("/api/events");
      es.addEventListener("hello", () => (beat(), (backoff = 1000)));
      es.addEventListener("ping", beat);
      es.addEventListener("msg", (e) => (beat(), upsert(JSON.parse(e.data), true)));
      es.addEventListener("state", () => (beat(), reloadStateSoon()));
      es.addEventListener("open", () => {
        // Catch anything missed while disconnected, including a chat that never finished loading.
        reloadStateSoon();
        const ids = new Set([...Object.keys(store.threads), selectedBot()].filter(Boolean));
        for (const id of ids) loadThread(id).catch(() => {});
      });
      es.addEventListener("error", () => {
        loadState().catch((e) => e instanceof AuthError && setAuthed(false));
        // A restart behind Tailscale answers 502, which makes the browser give up on the stream for good:
        // reconnect ourselves, waiting a bit longer each time.
        if (es.readyState === EventSource.CLOSED) {
          clearTimeout(retry);
          retry = setTimeout(connect, backoff);
          backoff = Math.min(backoff * 2, 30_000);
        }
      });
    };
    connect();
    const onVisible = () => !document.hidden && reloadStateSoon();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      es?.close();
      clearTimeout(retry);
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [authed]);
  if (authed === null && offlineSince) return html`<${OfflineScreen} />`;
  if (authed === null) return html`<div class="boot"><${Blip} size=${48} state="working" /></div>`;
  if (!authed) return html`<${Login} onDone=${boot} />${s.toast ? html`<div class="toast">${s.toast}</div>` : null}`;
  if (!s.state) return html`<div class="boot"><${Blip} size=${48} state="working" /></div>`;
  return html`<${Shell} />`;
}

const theme = localStorage.getItem("theme");
if (theme === "light" || theme === "auto") document.documentElement.setAttribute("data-theme", theme);
setThemeColor(theme);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
render(html`<${App} />`, document.getElementById("app"));
