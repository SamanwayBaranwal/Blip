import { h, render } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

// ============================================================ api
class AuthError extends Error {}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  if (res.status === 401) throw new AuthError("login required");
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
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
  emit();
}
let stateTimer;
function reloadStateSoon() {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(() => loadState().catch(() => {}), 250);
}
async function loadThread(botId) {
  const { messages } = await api(`/thread/${botId}`);
  store.threads = { ...store.threads, [botId]: messages };
  emit();
}
function upsert(m, live) {
  const list = store.threads[m.botId];
  if (list) {
    const i = list.findIndex((x) => x.id === m.id);
    const next = [...list];
    if (i >= 0) next[i] = m;
    else next.push(m);
    store.threads = { ...store.threads, [m.botId]: next };
  }
  const isNew = !list || !list.some((x) => x.id === m.id);
  if (live && isNew && m.role !== "user" && m.botId !== selectedBot()) {
    store.unread = { ...store.unread, [m.botId]: (store.unread[m.botId] || 0) + 1 };
  }
  if (live && isNew && m.role === "bot" && m.kind === "text" && m.meta?.voice && m.text && "speechSynthesis" in window) {
    speechSynthesis.speak(new SpeechSynthesisUtterance(m.text.replace(/[•*_#`]/g, "").slice(0, 1500)));
  }
  emit();
}
let selected = null;
const selectedBot = () => selected;

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
const shortModel = (m) => (m || "").replace(/^claude-/, "").replace(/-(\d)-(\d)$/, " $1.$2").replace(/-(\d)$/, " $1");
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
const Mark = ({ cls = "mark" }) => html`<svg class=${cls} viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9.2" stroke="currentColor" stroke-width="1.6" /><path d="M8.2 15.8 15.8 8.2" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" /></svg>`;

// ============================================================ small components
function Avatar({ bot, size = 34, status }) {
  const initial = (bot?.name || "?").trim().charAt(0).toUpperCase();
  return html`<div class="avatar" style=${`width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px`}>
    ${initial}${status ? html`<span class=${`dot ${status}`} />` : null}
  </div>`;
}
const Switch = ({ on, onChange }) => html`<button class=${`switch ${on ? "on" : ""}`} role="switch" aria-checked=${on} onClick=${() => onChange(!on)} />`;
function Seg({ value, options, onChange }) {
  return html`<div class="seg">${options.map(([v, label]) => html`<button class=${v === value ? "on" : ""} onClick=${() => onChange(v)}>${label}</button>`)}</div>`;
}
function Sheet({ title, onClose, children, actions }) {
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
  useEffect(() => {
    let alive = true;
    fn().then((d) => alive && setData(d)).catch(fail);
    return () => (alive = false);
  }, [...deps, tick]);
  return [data, () => setTick((t) => t + 1)];
}

function botStatus(bot, st) {
  const rt = st.runtime;
  if (bot.running) return rt.pendingCards ? { cls: "wait", dot: "wait", text: "Waiting for you" } : { cls: "live", dot: "live", text: rt.current?.step || "Working…" };
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
    <${Mark} />
    <h1>Pilot</h1>
    <p>${failed ? "That link didn't work. " : ""}Enter your access code. Run <code>~/PilotBot/pilot.sh link</code> on your Mac to see it, or scan its QR code.</p>
    <input class="input" placeholder="Access code" value=${code} onInput=${(e) => setCode(e.target.value)} autocomplete="one-time-code" autofocus />
    <button class="btn primary" disabled=${!code.trim() || busy}>${busy ? "Checking…" : "Open"}</button>
  </form></div>`;
}

// ============================================================ sidebar
function Sidebar({ st, open, onSelect, onSheet, onClose }) {
  const { budget } = st;
  const pct = Math.min(100, (budget.today / budget.limit) * 100);
  return html`<aside class=${`sidebar ${open ? "open" : ""}`}>
    <div class="brand"><${Mark} />Pilot</div>
    <button class="new-btn" onClick=${() => onSheet({ type: "newbot" })}><${I.plus} /> New bot</button>
    <div class="side-scroll">
      <div>
        <div class="side-label">Bots</div>
        ${st.bots.map((b) => {
          const s = botStatus(b, st);
          const unread = store.unread[b.id];
          const waiting = (store.threads[b.id] || []).filter((m) => m.card?.status === "pending").length;
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
          <input class="input" style="height:30px;font-size:13px;width:230px" placeholder="What should it do differently?" value=${note} onInput=${(e) => setNote(e.target.value)} autofocus />
          <button class="btn small primary">Save</button>
        </form>`
      : null}
  </span>`;
}

function TextMsg({ m, bot, onImage }) {
  if (m.role === "system") return html`<div class="msg system"><div class="text" dangerouslySetInnerHTML=${{ __html: md(m.text || "") }} /></div>`;
  const user = m.role === "user";
  return html`<div class=${`msg ${user ? "user" : "bot"}`}>
    ${user ? null : html`<${Avatar} bot=${bot} size=${28} />`}
    <div class="body">
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

function RunBlock({ m }) {
  const r = m.run;
  const live = r.status === "running" || r.status === "waiting";
  const [open, setOpen] = useState(null);
  const isOpen = open ?? live;
  const now = useNow(live);
  const elapsed = (r.endedAt || now) - r.startedAt;
  const last = r.steps.at(-1)?.text;
  const stateIcon = { done: I.okCircle, failed: I.xCircle, stopped: I.dash, "nothing new": I.dash, waiting: I.pauseCircle }[r.status];
  const title = r.status === "waiting" ? "Waiting for you" : live ? (r.stalled ? "Still working" : "Working") : r.status === "failed" ? "Failed" : r.status === "stopped" ? "Stopped" : r.status === "nothing new" ? "Nothing new" : `Worked for ${dur(elapsed)}`;
  const sub = live ? (r.status === "waiting" ? "answer below" : last || "Starting") : `${r.steps.length} step${r.steps.length === 1 ? "" : "s"}${r.costUsd && store.state?.authMode !== "plan" ? ` · ${money(r.costUsd)}` : ""}`;
  const shown = live ? r.steps.slice(-8) : r.steps;
  return html`<div class=${`run ${live ? "live" : ""} ${r.status === "waiting" ? "waiting" : ""}`}>
    <button class="run-head" onClick=${() => setOpen(!isOpen)}>
      ${live && r.status !== "waiting" ? html`<span class="spinner" />` : html`<span class="state-dot" style=${r.status === "failed" ? "color:var(--danger)" : r.status === "waiting" ? "color:var(--warn)" : ""}><${stateIcon || I.okCircle} /></span>`}
      <span class="label"><b class=${live && r.status !== "waiting" ? "shimmer" : ""}>${title}</b><span>${sub}</span></span>
      ${live ? html`<span class="time">${dur(elapsed)}</span>` : null}
      <span class=${`chev ${isOpen ? "open" : ""}`}><${I.chevron} /></span>
    </button>
    ${isOpen && (r.plan.length || r.steps.length)
      ? html`<div class="run-body">
          ${r.plan.length
            ? html`<div class="plan">${r.plan.map((t) => html`<div class=${t.status === "completed" ? "done" : t.status === "in_progress" ? "now" : ""}>
                <span class=${`tick ${t.status === "completed" ? "done" : t.status === "in_progress" ? "now" : ""}`}>${t.status === "completed" ? html`<${I.check} />` : null}</span>
                <span>${t.status === "in_progress" ? t.activeForm || t.content : t.content}</span>
              </div>`)}</div>`
            : null}
          ${shown.length ? html`<div class="steps">${shown.map((s) => html`<div><time>${fmtTime(s.at)}</time><span>${s.text}</span></div>`)}</div>` : null}
        </div>`
      : null}
  </div>`;
}

const KICKER = { approval: "Needs your approval", draft: "Draft · review before it's sent", takeover: "Your turn", suggestion: "Suggestion" };

function Card({ m, onTakeover }) {
  const c = m.card;
  const pending = c.status === "pending";
  const [busy, setBusy] = useState(false);
  const [draftBody, setDraftBody] = useState(c.draft?.body ?? "");
  useEffect(() => setDraftBody(c.draft?.body ?? ""), [c.draft?.body]);
  const answer = async (value) => {
    setBusy(true);
    try {
      await api(`/card/${m.id}`, { method: "POST", body: { value, body: c.draft ? draftBody : undefined } });
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
    ${c.note ? html`<div class=${`card-note ${c.type === "takeover" || c.type === "suggestion" ? "info" : ""}`}>${c.note}</div>` : null}
    ${pending
      ? html`<div class="card-actions">
          ${c.type === "takeover" ? html`<button class="btn" onClick=${onTakeover}><${I.computer} /> Open computer</button>` : null}
          ${c.buttons.map((b) => html`<button class=${`btn ${b.style || ""}`} disabled=${busy} onClick=${() => answer(b.value)}>${b.label}</button>`)}
        </div>`
      : html`<div class="card-answer">${c.status === "expired" ? null : html`<span class="state-dot"><${I.okCircle} /></span>`} ${c.answer}</div>`}
  </div>`;
}

function MessageList({ bot, messages, onImage, onTakeover }) {
  const ref = useRef();
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => {
    stick.current = true;
  }, [bot.id]);
  const onScroll = () => {
    const el = ref.current;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };
  return html`<div class="messages" ref=${ref} onScroll=${onScroll}>
    <div class="messages-inner">
      ${messages === undefined ? html`<div class="empty">Loading…</div>` : null}
      ${messages?.length === 0 ? html`<div class="hello" style="min-height:50vh"><${Avatar} bot=${bot} size=${52} /><h1>${bot.name}</h1><p>${bot.job}</p></div>` : null}
      ${(messages || []).map((m) =>
        m.kind === "run" ? html`<${RunBlock} key=${m.id} m=${m} />`
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
  const running = bot.running;

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
    if (!body && !files.length) return;
    setBusy(true);
    try {
      await api("/send", { method: "POST", body: { botId: bot.id, text: body, voice, attachments: files.map(({ name, type, data }) => ({ name, type, data })) } });
      if (overrideText === undefined) setText("");
      setFiles([]);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const pick = async (e) => {
    const list = [...e.target.files];
    e.target.value = "";
    for (const f of list) {
      if (f.size > 25_000_000) {
        toast(`${f.name} is over 25 MB`);
        continue;
      }
      const data = await readAsBase64(f);
      setFiles((prev) => [...prev, { name: f.name, type: f.type, data, preview: f.type.startsWith("image/") ? URL.createObjectURL(f) : null }]);
    }
  };
  const toggleMic = async () => {
    if (rec) return rec.stop();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      const chunks = [];
      mr.ondataavailable = (e) => chunks.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
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
      setRec(mr);
    } catch {
      toast("Microphone not available (needs the HTTPS app link)");
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
  const hint = rec ? "Listening — tap the mic again to send" : running ? "Messages you send now steer the task in progress." : queued ? `${queued} task${queued > 1 ? "s" : ""} queued` : "";
  return html`<div class="composer-wrap">
    <div class="composer">
      ${files.length
        ? html`<div class="attach-list">${files.map((f, i) => html`<span class="chip">${f.preview ? html`<img src=${f.preview} style="width:20px;height:20px;border-radius:4px;object-fit:cover" />` : "📎"} ${f.name.slice(0, 24)}
            <button onClick=${() => setFiles(files.filter((_, j) => j !== i))} aria-label="Remove">×</button></span>`)}</div>`
        : null}
      <textarea ref=${ta} rows="1" placeholder=${running ? `Steer ${bot.name} while it works…` : `What should ${bot.name} do?`} value=${text} onInput=${(e) => setText(e.target.value)} onKeyDown=${onKey} />
      <div class="composer-row">
        <button class="icon-btn" onClick=${() => fileInput.current.click()} aria-label="Attach"><${I.clip} /></button>
        <input type="file" multiple hidden ref=${fileInput} onChange=${pick} />
        <button class=${`icon-btn ${rec ? "rec" : ""}`} onClick=${toggleMic} aria-label="Voice"><${I.mic} /></button>
        <button class="chip btn" onClick=${onModel}>${shortModel(bot.model)}</button>
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
function ComputerPanel({ control, setControl }) {
  const [src, setSrc] = useState(null);
  const [error, setError] = useState(null);
  const [ripples, setRipples] = useState([]);
  const [typed, setTyped] = useState("");
  const img = useRef();
  useEffect(() => {
    let alive = true;
    let url;
    const loop = async () => {
      while (alive) {
        if (!document.hidden) {
          try {
            const res = await fetch("/api/screen", { cache: "no-store" });
            if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Screen unavailable");
            const next = URL.createObjectURL(await res.blob());
            if (url) URL.revokeObjectURL(url);
            url = next;
            if (alive) {
              setSrc(next);
              setError(null);
            }
          } catch (e) {
            if (alive) setError(e.message);
          }
        }
        await new Promise((r) => setTimeout(r, control ? 450 : 1100));
      }
    };
    loop();
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [control]);
  const act = (action, body) => api(`/screen/${action}`, { method: "POST", body }).catch(fail);
  const tap = (kind) => (e) => {
    if (!control) return;
    e.preventDefault();
    const el = img.current;
    const rect = el.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * el.naturalWidth;
    const y = ((e.clientY - rect.top) / rect.height) * el.naturalHeight;
    const id = Math.random();
    setRipples((r) => [...r, { id, left: e.clientX - rect.left, top: e.clientY - rect.top }]);
    setTimeout(() => setRipples((r) => r.filter((p) => p.id !== id)), 500);
    act("click", { x, y, kind });
  };
  const keys = [["Return", "return"], ["Tab", "tab"], ["Esc", "esc"], ["⌫", "delete"], ["⌘Space", "cmd+space"], ["⌘A", "cmd+a"], ["⌘C", "cmd+c"], ["⌘V", "cmd+v"], ["↑", "arrow-up"], ["↓", "arrow-down"], ["←", "arrow-left"], ["→", "arrow-right"]];
  return html`<div>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <${Seg} value=${control ? "control" : "watch"} options=${[["watch", "Watching"], ["control", "Take control"]]} onChange=${(v) => setControl(v === "control")} />
    </div>
    ${error
      ? html`<div class="card-note">${error}</div>`
      : html`<div class=${`screen-box ${control ? "control" : ""}`}>
          ${src ? html`<img ref=${img} src=${src} alt="Your Mac's screen" onClick=${tap("left")} onDblClick=${tap("double")} onContextMenu=${tap("right")} draggable="false" />` : html`<div class="empty" style="color:#999">Connecting…</div>`}
          <span class="chip screen-badge" style="background:rgba(0,0,0,.55);color:#fff">${control ? "🎮 You're in control" : "👀 Watching"}</span>
          ${ripples.map((p) => html`<span class="ripple" style=${`left:${p.left}px;top:${p.top}px`} />`)}
        </div>`}
    ${control
      ? html`<form class="type-row" onSubmit=${(e) => { e.preventDefault(); if (typed) act("type", { text: typed }); setTyped(""); }}>
          <input class="input" placeholder="Type on the Mac…" value=${typed} onInput=${(e) => setTyped(e.target.value)} autocomplete="off" autocapitalize="off" />
          <button class="btn primary small">Type</button>
        </form>
        <div class="keys">
          ${keys.map(([label, k]) => html`<button class="btn small" onClick=${() => act("key", { keys: k })}>${label}</button>`)}
          <button class="btn small" onClick=${() => act("scroll", { direction: "up" })}>Scroll ↑</button>
          <button class="btn small" onClick=${() => act("scroll", { direction: "down" })}>Scroll ↓</button>
        </div>
        <p class="hint">Tap to click · double-tap to double-click · long-press for right-click. Use this for passwords, codes and payments — the bot never sees what you type here.</p>`
      : html`<p class="hint">This is your bot's computer — your Mac, live. Switch to “Take control” to click and type yourself.</p>`}
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
      ${tab === "computer" ? html`<${ComputerPanel} control=${control} setControl=${setControl} />` : tab === "files" ? html`<${FilesPanel} onImage=${onImage} />` : html`<${MemoryPanel} bot=${bot} />`}
    </div>
  </aside>`;
}

// ============================================================ sheets
function RoutinesSheet({ st, botId, onClose }) {
  const [routines, reload] = useLoad(() => api("/routines"), []);
  const [tpl] = useLoad(() => api("/templates"), []);
  const run = (r) => api(`/routines/${r.id}/run`, { method: "POST" }).then(() => toast(`Test run of "${r.name}" started`)).catch(fail);
  const del = (r) => confirm(`Delete routine "${r.name}"?`) && api(`/routines/${r.id}`, { method: "DELETE" }).then(reload).catch(fail);
  const setup = (key) => api("/templates/routine", { method: "POST", body: { key, botId } }).then(() => { toast("Setting it up in the chat…"); onClose(); }).catch(fail);
  return html`<${Sheet} title="Routines" onClose=${onClose}>
    ${routines === null ? html`<div class="empty">Loading…</div>`
      : routines.length ? html`<div class="list">${routines.map((r) => html`<div class="row">
          <div class="grow"><b>${r.name}</b><span>${r.bot} · ${r.schedule} · next ${r.next ? fmtDay(r.next) : "—"}</span></div>
          <button class="btn small" onClick=${() => run(r)}><${I.play} /> Test</button>
          <button class="icon-btn" onClick=${() => del(r)} aria-label="Delete"><${I.trash} /></button>
        </div>`)}</div>`
      : html`<div class="hint">No routines yet. Pick one below, or just ask a bot: “every weekday at 9, check my inbox for invoices”.</div>`}
    <div class="section-title" style="margin-top:22px">Popular with real users</div>
    <div class="grid-cards">${tpl ? Object.entries(tpl.routines).map(([key, t]) => html`<button class="tpl" onClick=${() => setup(key)}><b>${t.label}</b><span>${t.schedule}</span></button>`) : null}</div>
  <//>`;
}

function SkillsSheet({ botId, onClose }) {
  const [skills, reload] = useLoad(() => api("/skills"), []);
  const run = (s) => api(`/skills/${s.name}/run`, { method: "POST", body: { botId } }).then(() => { toast(`Running ${s.name}`); onClose(); }).catch(fail);
  const del = (s) => confirm(`Delete skill "${s.name}"?`) && api(`/skills/${s.name}`, { method: "DELETE" }).then(reload).catch(fail);
  const teach = () =>
    api("/send", { method: "POST", body: { botId, text: "I want to teach you a task so you can do it again later. Ask me what you need, then walk through it with me step by step (do the steps on this Mac as we go so we know they work). Note the criteria and edge cases I mention. When we're done, save it with save_skill and tell me how to run it." } })
      .then(onClose)
      .catch(fail);
  return html`<${Sheet} title="Skills" onClose=${onClose} actions=${html`<button class="btn small primary" onClick=${teach}>Teach a task</button>`}>
    <p class="hint" style="margin-top:0">Skills are how-tos your bots saved after you showed them a task once. Every bot can use them.</p>
    ${skills === null ? html`<div class="empty">Loading…</div>`
      : skills.length ? html`<div class="list">${skills.map((s) => html`<div class="row">
          <div class="grow"><b>${s.name}</b><span>${s.description}</span></div>
          <button class="btn small" onClick=${() => run(s)}><${I.play} /> Run</button>
          <button class="icon-btn" onClick=${() => del(s)} aria-label="Delete"><${I.trash} /></button>
        </div>`)}</div>`
      : html`<div class="empty">No skills yet. Tap “Teach a task”, or after a job say “save this as a skill”.</div>`}
  <//>`;
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
  if (!window.isSecureContext) throw new Error("Notifications need the secure https:// link (Tailscale). Run pilot.sh link on the Mac.");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notifications were not allowed");
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(key) }));
  await api("/push/subscribe", { method: "POST", body: sub.toJSON() });
}

function SettingsSheet({ st, onClose }) {
  const [rules, reloadRules] = useLoad(() => api("/rules"), []);
  const [connectors, reloadConnectors] = useLoad(() => api("/connectors"), []);
  const [newRule, setNewRule] = useState("");
  const [theme, setTheme] = useState(localStorage.getItem("theme") || "dark");
  const [pushOn, setPushOn] = useState(typeof Notification !== "undefined" && Notification.permission === "granted");
  const set = (patch) => api("/settings", { method: "PATCH", body: patch }).then(loadState).catch(fail);
  const pct = Math.min(100, (st.budget.today / st.budget.limit) * 100);
  const applyTheme = (t) => {
    setTheme(t);
    localStorage.setItem("theme", t);
    if (t === "dark") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
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
    <div class="toggle-row"><div class="grow"><b>Auto Review</b><span>An independent AI checks risky actions and only asks you when it matters.</span></div><${Switch} on=${st.settings.autoReview} onChange=${(v) => set({ autoReview: v })} /></div>
    <div class="toggle-row"><div class="grow"><b>Proactive suggestions</b><span>Your primary bot looks around (read-only) a few times a day and suggests things. Max 3/day.</span></div><${Switch} on=${st.settings.proactive} onChange=${(v) => set({ proactive: v })} /></div>
    <div class="toggle-row"><div class="grow"><b>Spoken replies</b><span>Read every reply aloud (voice messages always get spoken replies).</span></div><${Switch} on=${st.settings.voiceReplies} onChange=${(v) => set({ voiceReplies: v })} /></div>

    <div class="section-title">Always ask first</div>
    <p class="hint" style="margin-top:0">Anything that sends, pays, deletes, books or accepts is always checked with you. Add your own words here.</p>
    <div class="list">${(rules || []).map((r) => html`<div class="row"><div class="grow"><b>${r.text}</b></div><button class="icon-btn" onClick=${() => api(`/rules/${r.id}`, { method: "DELETE" }).then(reloadRules).catch(fail)} aria-label="Remove"><${I.trash} /></button></div>`)}</div>
    <form class="type-row" onSubmit=${(e) => { e.preventDefault(); api("/rules", { method: "POST", body: { match: newRule } }).then(() => { setNewRule(""); reloadRules(); }).catch(fail); }}>
      <input class="input" placeholder='e.g. "amazon" or "git push"' value=${newRule} onInput=${(e) => setNewRule(e.target.value)} /><button class="btn small primary" disabled=${!newRule.trim()}>Add</button>
    </form>

    <div class="section-title">Connected apps</div>
    ${connectors?.length
      ? html`<div class="list">${connectors.map((c) => html`<div class="row"><div class="grow"><b>${c.name}</b><span>${c.target}</span></div>
          <${Seg} value=${c.access} options=${[["read", "Read"], ["full", "Full"], ["off", "Off"]]} onChange=${(v) => api(`/connectors/${c.name}`, { method: "PATCH", body: { access: v } }).then(reloadConnectors).catch(fail)} />
          <button class="icon-btn" onClick=${() => api(`/connectors/${c.name}`, { method: "DELETE" }).then(reloadConnectors).catch(fail)} aria-label="Remove"><${I.trash} /></button></div>`)}</div>`
      : html`<p class="hint">None yet — ask a bot “connect my Notion”. Most sites already work through the bot's browser once you sign in.</p>`}

    <div class="section-title">This device</div>
    <div class="toggle-row"><div class="grow"><b>Notifications</b><span>Get pinged for approvals, replies and routine results.</span></div>
      <button class="btn small" disabled=${pushOn} onClick=${() => enablePush(st.pushKey).then(() => { setPushOn(true); toast("Notifications on"); }).catch(fail)}>${pushOn ? "On" : "Turn on"}</button></div>
    <div class="toggle-row"><div class="grow"><b>Appearance</b></div><${Seg} value=${theme} options=${[["dark", "Dark"], ["light", "Light"], ["auto", "Auto"]]} onChange=${applyTheme} /></div>
    <p class="hint">Install on iPhone: open this page in Safari → Share → Add to Home Screen. ${st.telegram ? "Telegram is connected as an extra channel." : ""}</p>
  <//>`;
}

function NewBotSheet({ onClose, onCreated }) {
  const [tpl] = useLoad(() => api("/templates"), []);
  const [form, setForm] = useState({ name: "", job: "", style: "" });
  const create = (body) => api("/bots", { method: "POST", body }).then(({ id }) => { onCreated(id); onClose(); }).catch(fail);
  const f = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return html`<${Sheet} title="New bot" onClose=${onClose}>
    <div class="section-title">Start from a template</div>
    <div class="grid-cards">${tpl ? Object.entries(tpl.bots).map(([key, t]) => html`<button class="tpl" onClick=${() => create({ template: key })}><b>${t.label}</b><span>${t.job.slice(0, 90)}…</span></button>`) : null}</div>
    <div class="section-title" style="margin-top:22px">Or make your own</div>
    <div style="display:flex;gap:10px">
      <div class="field" style="flex:1"><label>Name</label><input class="input" value=${form.name} onInput=${f("name")} placeholder="e.g. Max" /></div>
    </div>
    <div class="field"><label>Job</label><textarea class="input" value=${form.job} onInput=${f("job")} placeholder="What should it own? e.g. Find deals and get quotes; never buy without asking." /></div>
    <div class="field"><label>Personality (optional)</label><input class="input" value=${form.style} onInput=${f("style")} placeholder="e.g. Witty and brief" /></div>
    <button class="btn primary" disabled=${!form.name.trim() || !form.job.trim()} onClick=${() => create(form)}>Create bot</button>
  <//>`;
}

function BotSheet({ bot, st, onClose }) {
  const [form, setForm] = useState({ name: bot.name, job: bot.job, style: bot.style });
  const alias = st.models.find((m) => m.id === bot.model)?.alias || (bot.model === st.defaultModel ? "default" : bot.model);
  const patch = (body) => api(`/bots/${bot.id}`, { method: "PATCH", body }).then(loadState).catch(fail);
  const f = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return html`<${Sheet} title=${bot.name} onClose=${onClose}>
    <div style="display:flex;gap:10px">
      <div class="field" style="flex:1"><label>Name</label><input class="input" value=${form.name} onInput=${f("name")} /></div>
    </div>
    <div class="field"><label>Job</label><textarea class="input" value=${form.job} onInput=${f("job")} /></div>
    <div class="field"><label>Personality</label><input class="input" value=${form.style} onInput=${f("style")} /></div>
    <button class="btn primary" onClick=${() => patch(form).then(() => toast("Saved"))}>Save</button>
    <div class="section-title" style="margin-top:22px">Model</div>
    <${Seg} value=${alias} options=${[["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"]]} onChange=${(v) => patch({ model: v })} />
    <p class="hint">Context used: ${Math.round(bot.contextTokens / 1000)}k tokens. Long chats cost more per message — start a new chat to reset (memory is kept).</p>
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
      <button class=${`icon-btn ${panel === "memory" ? "on" : ""}`} onClick=${() => togglePanel("memory")} aria-label="Memory" title="Memory"><${I.brain} /></button>
      <button class="icon-btn" onClick=${() => onSheet({ type: "bot" })} aria-label="Bot settings" title="Bot settings"><${I.more} /></button>
    </header>
    <${MessageList} bot=${bot} messages=${messages} onImage=${onImage} onTakeover=${() => { setPanel("computer"); setControl(true); }} />
    ${fresh ? html`<div class="starters">${STARTERS.map((x) => html`<button class="starter" onClick=${() => starter(x)}>${x.label}</button>`)}</div>` : null}
    <${Composer} key=${bot.id} bot=${bot} st=${st} onModel=${() => onSheet({ type: "bot" })} preset=${preset} clearPreset=${() => setPreset(null)} />
  </main>`;
}

function Shell() {
  const s = useStore();
  const st = s.state;
  const [sidebar, setSidebar] = useState(false);
  const [panel, setPanel] = useState(() => (window.innerWidth > 1200 ? localStorage.getItem("panel") || null : null));
  const [control, setControl] = useState(false);
  const [sheet, setSheet] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [botId, setBotId] = useState(() => new URLSearchParams(location.search).get("bot") || localStorage.getItem("bot"));

  const bot = st.bots.find((b) => b.id === botId) || st.bots.find((b) => b.id === st.activeBotId) || st.bots[0];
  selected = bot.id;
  const select = (id) => {
    setBotId(id);
    setSidebar(false);
    localStorage.setItem("bot", id);
    store.unread = { ...store.unread, [id]: 0 };
    api(`/bots/${id}`, { method: "PATCH", body: { active: true } }).catch(() => {});
    emit();
  };
  useEffect(() => {
    if (!store.threads[bot.id]) loadThread(bot.id).catch(fail);
    if (store.unread[bot.id]) {
      store.unread = { ...store.unread, [bot.id]: 0 };
      emit();
    }
  }, [bot.id]);
  useEffect(() => {
    try {
      panel ? localStorage.setItem("panel", panel) : localStorage.removeItem("panel");
    } catch {}
    if (panel !== "computer") setControl(false);
  }, [panel]);
  useEffect(() => {
    const onMsg = (e) => e.data?.type === "open-bot" && e.data.botId && select(e.data.botId);
    navigator.serviceWorker?.addEventListener("message", onMsg);
    return () => navigator.serviceWorker?.removeEventListener("message", onMsg);
  }, []);

  return html`<div class=${`shell ${panel ? "with-panel" : ""}`}>
    <${Sidebar} st=${st} open=${sidebar} onSelect=${select} onSheet=${(x) => { setSheet(x); setSidebar(false); }} onClose=${() => setSidebar(false)} />
    <${ChatView} st=${st} bot=${bot} onMenu=${() => setSidebar(true)} panel=${panel} setPanel=${setPanel} onSheet=${setSheet} onImage=${setLightbox} setControl=${setControl} />
    ${panel ? html`<${Panel} tab=${panel} setTab=${setPanel} bot=${bot} onClose=${() => setPanel(null)} onImage=${setLightbox} control=${control} setControl=${setControl} />` : null}
    ${sheet?.type === "routines" ? html`<${RoutinesSheet} st=${st} botId=${bot.id} onClose=${() => setSheet(null)} />` : null}
    ${sheet?.type === "skills" ? html`<${SkillsSheet} botId=${bot.id} onClose=${() => setSheet(null)} />` : null}
    ${sheet?.type === "activity" ? html`<${ActivitySheet} onClose=${() => setSheet(null)} />` : null}
    ${sheet?.type === "settings" ? html`<${SettingsSheet} st=${st} onClose=${() => setSheet(null)} />` : null}
    ${sheet?.type === "newbot" ? html`<${NewBotSheet} onClose=${() => setSheet(null)} onCreated=${(id) => loadState().then(() => select(id))} />` : null}
    ${sheet?.type === "bot" ? html`<${BotSheet} bot=${bot} st=${st} onClose=${() => setSheet(null)} />` : null}
    ${lightbox ? html`<div class="lightbox" onClick=${() => setLightbox(null)}><img src=${lightbox} alt="" /></div>` : null}
    ${s.toast ? html`<div class="toast">${s.toast}</div>` : null}
  </div>`;
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
    const es = new EventSource("/api/events");
    es.addEventListener("msg", (e) => upsert(JSON.parse(e.data), true));
    es.addEventListener("state", reloadStateSoon);
    es.addEventListener("open", () => {
      // Catch anything missed while disconnected.
      reloadStateSoon();
      for (const id of Object.keys(store.threads)) loadThread(id).catch(() => {});
    });
    es.addEventListener("error", () => loadState().catch((e) => e instanceof AuthError && setAuthed(false)));
    const onVisible = () => !document.hidden && reloadStateSoon();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      es.close();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [authed]);
  if (authed === null) return html`<div class="boot"><${Mark} /></div>`;
  if (!authed) return html`<${Login} onDone=${boot} />${s.toast ? html`<div class="toast">${s.toast}</div>` : null}`;
  if (!s.state) return html`<div class="boot"><${Mark} /></div>`;
  return html`<${Shell} />`;
}

const theme = localStorage.getItem("theme");
if (theme === "light" || theme === "auto") document.documentElement.setAttribute("data-theme", theme);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
render(html`<${App} />`, document.getElementById("app"));
