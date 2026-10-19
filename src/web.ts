import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { closeWarmSession, MODEL_ALIASES } from "./agent.js";
import {
  activeBot, createBot, deleteBot, deleteMemoryLine, getBot, listSkills, memoryLines, primaryBot, renameBot,
} from "./bots.js";
import { answerCard, pendingCards } from "./cards.js";
import { config, setAnthropicKey } from "./config.js";
import {
  createBotFromTemplate, customTemplates, deleteTemplate, duplicateBot, freshChat, runSkillPrompt, saveAsTemplate, todaySummary, giveFeedback, handleUserMessage, runProactive, runtime, stopBot, setupRoutineTemplate, stopCurrent, testRoutine, type Attachment,
} from "./core.js";
import { deleteThread, events, getThread, stateChanged, type Msg } from "./hub.js";
import * as mac from "./mac.js";
import * as screen from "./screen.js";
import { attachRemote } from "./remote.js";
import { deleteSecret, listSecrets, saveSecret } from "./secrets.js";
import { backupNow, beat, checkMacAccess, health, recover, reset, selfTest } from "./health.js";
import { startTeaching, stopTeaching, teachStatus } from "./teach.js";
import * as skills from "./skills.js";
import { checkInbox, emailSettings, fakeInbound, presetFor, removeEmail, setupEmail } from "./email.js";

/** Input failing almost always means macOS hasn't given Blip permission to control the Mac. */
const inputError = (error: unknown) =>
  /not permitted|accessibility|assistive|1002|-25211/i.test(String((error as Error)?.message))
    ? "macOS blocked control. On the Blip Mac: System Settings → Privacy & Security → Accessibility → turn on node, then ./blip.sh restart"
    : (error as Error).message;
import { addSubscription, pushPublicKey } from "./notify.js";
import { cloudflaredPath, newLoginLink, qrSvg, reachStatus, sendLinkEmail, setReach, tailscalePath, useLoginLink } from "./reach.js";
import { addRule, describeRule, inside, isSensitive } from "./permissions.js";
import { describeSchedule, describeTrigger, fireWebhook, nextRun, removeRoutine, restoreRoutine } from "./routines.js";
import { recentAudit, save, spendByBotToday, spentLastDays, spentToday, state } from "./store.js";
import { saveToInbox } from "./telegram.js";
import { BOT_TEMPLATES, ROUTINE_TEMPLATES } from "./templates.js";
import { transcribe } from "./voice.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------- access
// The app is reachable only on your own devices (Tailscale), and also needs this access code.
const TOKEN_FILE = path.join(config.dataDir, "app-access-code");
export const accessCode = fs.existsSync(TOKEN_FILE)
  ? fs.readFileSync(TOKEN_FILE, "utf8").trim()
  : (() => {
      const code = randomBytes(18).toString("base64url");
      fs.writeFileSync(TOKEN_FILE, code, { mode: 0o600 });
      return code;
    })();

const matches = (given: unknown) => {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(accessCode);
  return a.length === b.length && timingSafeEqual(a, b);
};
const cookieOf = (req: { headers: { cookie?: string } }) => /(?:^|;\s*)blip=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];

function setSession(req: Request, res: Response) {
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `blip=${accessCode}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`);
}

// Phone pairing: a signed-in device shows a short 6-digit code that a new device types once.
// It lasts 10 minutes and allows 8 tries, so the long access code never has to be typed on a phone.
let pairing: { pin: string; expires: number; tries: number } | undefined;

function newPairingPin() {
  pairing = { pin: String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0"), expires: Date.now() + 10 * 60_000, tries: 0 };
  return pairing;
}

function pinMatches(given: unknown) {
  if (!pairing || Date.now() > pairing.expires) return false;
  if (++pairing.tries > 8) {
    pairing = undefined;
    return false;
  }
  const ok = String(given ?? "").replace(/\D/g, "") === pairing.pin;
  if (ok) pairing = undefined; // single use
  return ok;
}

/** Addresses a phone can use to reach this Mac: home Wi-Fi, and Tailscale's private HTTPS link if it's on. */
async function phoneUrls(): Promise<{ lan: string[]; tailscale?: string }> {
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === "IPv4" && !i.internal && !i.address.startsWith("100."))
    .map((i) => `http://${i.address}:${config.webPort}`);
  let tailscale: string | undefined;
  for (const bin of ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"]) {
    if (!fs.existsSync(bin)) continue;
    try {
      const { stdout: out } = await execFileAsync(bin, ["serve", "status"], { encoding: "utf8", timeout: 3000 });
      tailscale = /https:\/\/[^\s/]+/.exec(out)?.[0];
    } catch {
      // Tailscale installed but not serving yet
    }
    break;
  }
  return { lan, tailscale };
}

function auth(req: Request, res: Response, next: NextFunction) {
  if (matches(cookieOf(req))) return next();
  res.status(401).json({ error: "login required" });
}

// ---------------------------------------------------------------- helpers
const str = (v: unknown, max = 20_000) => String(v ?? "").slice(0, max);
const botOr404 = (req: Request, res: Response) => {
  const b = getBot(String(req.params.id));
  if (!b) res.status(404).json({ error: "no such bot" });
  return b;
};

function appState() {
  const byBot = spendByBotToday();
  const rt = runtime();
  return {
    bots: state.bots.map((b) => ({
      id: b.id, name: b.name, emoji: b.emoji, job: b.job, style: b.style, quiet: !!b.quiet, look: b.look ?? {}, spice: b.spice ?? "medium", ownBrowser: !!b.ownBrowser, helper: !!b.helper,
      model: b.model ?? "auto", contextTokens: b.contextTokens ?? 0, spentToday: byBot[b.name] ?? 0,
      // Its own chat's task; work it's doing in groups is separate (`elsewhere`), and doesn't block this chat.
      running: rt.running.some((r) => r.botId === b.id && r.threadId === b.id), step: rt.running.find((r) => r.botId === b.id && r.threadId === b.id)?.step ?? null,
      elsewhere: rt.running.filter((r) => r.botId === b.id && r.threadId !== b.id).map((r) => r.threadId),
      waiting: pendingCards(b.id), queued: rt.queued.filter((q) => q.botId === b.id && q.threadId === b.id).length,
    })),
    activeBotId: activeBot().id,
    primaryBotId: primaryBot().id,
    settings: state.settings,
    budget: { today: spentToday(), limit: config.dailyBudgetUsd, week: spentLastDays(7) },
    runtime: rt,
    models: Object.entries(MODEL_ALIASES).map(([alias, id]) => ({ alias, id })),
    defaultModel: config.model,
    timezone: config.timezone,
    telegram: !!config.telegramToken,
    pushKey: pushPublicKey,
    authMode: config.anthropicKey ? "api" : "plan",
    teach: teachStatus(),
    anywhere: { status: reachStatus().status, url: reachStatus().url ?? null, permanent: reachStatus().permanent },
    setupDone: !!state.setupDone,
    lastCheckIn: state.lastProactiveAt ?? null,
    nextRoutine: nextRoutine(),
    groups: state.groups.map((g) => ({
      ...g,
      running: rt.running.some((r) => r.threadId === g.id),
      waiting: pendingCards(g.id),
    })),
  };
}

/** The routine that runs next on the clock (for the status strip). */
function nextRoutine() {
  let best: { name: string; botId: string; at: string } | null = null;
  for (const r of state.routines) {
    const at = nextRun(r.id);
    if (at && (!best || at.toISOString() < best.at)) best = { name: r.name, botId: r.botId, at: at.toISOString() };
  }
  return best;
}

/** A routine's latest run (its own or a test run): when, and whether it worked. */
function lastRunOf(r: { id: string; name: string }) {
  const run = state.runs.findLast((x) => x.routineId === r.id || (!x.routineId && (x.label === r.name || x.label === `Test · ${r.name}`)));
  return run ? { at: run.at, status: run.status, summary: run.summary.slice(0, 140) } : null;
}

function recentFiles(limit: number) {
  const files: { path: string; size: number; mtime: number }[] = [];
  const walk = (dir: string, depth: number) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (files.length > 3000) return; // a bot's big project folder mustn't freeze the app
      if (entry.name.startsWith(".") || ["memory", "browser", "node_modules", "screenshots"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 5) walk(full, depth + 1);
      else if (entry.isFile() && entry.name !== "CLAUDE.md" && !/^view-\d+\.jpg$/.test(entry.name)) {
        const st = fs.statSync(full);
        files.push({ path: path.relative(config.workspace, full), size: st.size, mtime: st.mtimeMs });
      }
    }
  };
  walk(config.workspace, 0);
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

function saveUploads(list: unknown): Attachment[] {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 10).map((f: { name?: string; data?: string; type?: string }) => {
    const saved = saveToInbox(str(f.name, 120) || "file", Buffer.from(str(f.data, 40_000_000), "base64"));
    const type = str(f.type, 60);
    return { path: saved, mediaType: ["image/png", "image/jpeg"].includes(type) ? type : undefined };
  });
}

/** Only known wardrobe ids (see LOOKS in web/app.js). */
function cleanLook(raw: Record<string, unknown>) {
  const look: Record<string, string> = {};
  for (const key of ["color", "hat", "eyes", "face", "neck", "hold"]) {
    const v = raw[key];
    if (typeof v === "string" && /^[a-z0-9-]{1,24}$/.test(v) && v !== "none" && v !== "classic") look[key] = v;
  }
  return look;
}

// ---------------------------------------------------------------- server
export function startWeb() {
  const app = express();
  app.disable("x-powered-by");
  // Small bodies everywhere; only sending files and voice (after sign-in) may be large.
  const bigJson = express.json({ limit: "60mb" });
  const smallJson = express.json({ limit: "256kb" });
  app.use((req, res, next) => (req.path === "/api/send" || req.path === "/api/voice" ? next() : smallJson(req, res, next)));

  // Static app + vendored UI libraries (no build step, no CDN).
  const vendor: Record<string, string> = {
    "preact.mjs": "node_modules/preact/dist/preact.mjs",
    "hooks.mjs": "node_modules/preact/hooks/dist/hooks.mjs",
    "htm.mjs": "node_modules/htm/dist/htm.module.js",
  };
  app.get("/vendor/:file", (req, res) => {
    const rel = vendor[String(req.params.file)];
    if (!rel) return void res.sendStatus(404);
    res.type("text/javascript").sendFile(path.join(config.webDir, "..", rel), { dotfiles: "allow" });
  });
  app.get("/login", (req, res) => {
    if (matches(req.query.code) || useLoginLink(req.query.t)) {
      setSession(req, res);
      return void res.redirect("/");
    }
    res.redirect("/?login=failed");
  });
  app.use(express.static(config.webDir, { index: "index.html", maxAge: 0 }));

  // Webhook triggers: a private link per routine (the token is the password). Anything on your network or
  // Tailscale can call it (iPhone Shortcuts, scripts, other apps). The body is passed to the bot as data.
  const hookLimit = new Map<string, number>();
  app.all("/hook/:token", express.text({ type: "*/*", limit: "64kb" }), (req, res) => {
    const token = String(req.params.token);
    if (Date.now() - (hookLimit.get(token) ?? 0) < 10_000) return void res.status(429).json({ error: "Too many calls; wait a few seconds." });
    hookLimit.set(token, Date.now());
    const body = typeof req.body === "string" ? req.body : req.body && Object.keys(req.body).length ? JSON.stringify(req.body) : "";
    const query = new URLSearchParams(req.query as Record<string, string>).toString();
    if (!fireWebhook(token, [query && `query: ${query}`, body].filter(Boolean).join("\n"))) return void res.status(404).json({ error: "No routine has that link." });
    res.status(202).json({ ok: true });
  });

  // A one-line status anyone on your network can open (no sign-in, no personal data): is Blip up?
  app.get("/status", (_req, res) => {
    const t = state.health.lastSelfTest;
    const up = Math.round(process.uptime() / 60);
    res.type("text/plain").send(`Blip is running · up ${up >= 60 ? `${Math.floor(up / 60)}h ${up % 60}m` : `${up}m`}${t ? ` · self-test ${t.passed}/${t.total}` : ""}\n`);
  });

  app.post("/api/login", (req, res) => {
    if (!matches(req.body?.code) && !pinMatches(req.body?.code)) return void res.status(401).json({ error: "wrong code" });
    setSession(req, res);
    res.json({ ok: true });
  });

  const api = express.Router();
  api.use(auth);

  api.post("/pair", async (_req, res) => {
    const p = newPairingPin();
    res.json({ pin: p.pin, expires: p.expires, ...(await phoneUrls()) });
  });

  api.get("/state", (_req, res) => void res.json(appState()));

  // ---- use Blip anywhere: the public link, the owner's email, the QR code to scan
  const reachView = () => ({ ...reachStatus(), tools: { cloudflare: !!cloudflaredPath(), tailscale: !!tailscalePath() }, agentEmail: state.email?.address ?? null, setupDone: !!state.setupDone });
  api.get("/reach", (_req, res) => void res.json(reachView()));
  api.post("/reach", async (req, res) => {
    const mode = str(req.body.mode);
    if (!["off", "cloudflare", "tailscale"].includes(mode)) return void res.status(400).json({ error: "bad mode" });
    await setReach(mode as "off");
    res.json(reachView());
  });
  api.post("/reach/owner", (req, res) => {
    const email = str(req.body.email, 200).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return void res.status(400).json({ error: "That isn't an email address." });
    state.owner = { ...state.owner, email };
    save();
    res.json(reachView());
  });
  api.post("/reach/email", async (_req, res) => {
    try {
      await sendLinkEmail("setup");
      res.json(reachView());
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });
  api.post("/reach/done", (_req, res) => {
    state.setupDone = true;
    save();
    stateChanged();
    res.json(reachView());
  });
  // A QR code with a 15-minute, one-time sign-in link: point the phone's camera at the Mac's screen.
  api.get("/reach/qr", (_req, res) => {
    const r = reachStatus();
    if (r.status !== "on" || !r.url) return void res.status(409).json({ error: "Turn on “Use Blip anywhere” first." });
    res.set({ "Content-Type": "image/svg+xml", "Cache-Control": "no-store" }).send(qrSvg(newLoginLink(r.url, 15 * 60_000)));
  });

  // ---- health: report, Recover, Reset, backups, self-test
  api.get("/health", async (_req, res) => void res.json(await health()));
  api.post("/recover", async (_req, res) => void res.json({ steps: await recover() }));
  api.post("/reset", async (req, res) => {
    if (req.body?.confirm !== "RESET") return void res.status(400).json({ error: "Confirm the reset first." });
    res.json({ steps: await reset() });
  });
  api.post("/backup", async (_req, res) => void res.json(await backupNow()));
  api.post("/selftest", async (_req, res) => void res.json(await selfTest({ post: true })));
  api.post("/check-mac", async (_req, res) => void res.json(await checkMacAccess()));
  api.post("/heartbeat", async (req, res) => {
    const url = str(req.body.url, 300).trim();
    if (url && !/^https:\/\/[^\s]+$/.test(url)) return void res.status(400).json({ error: "Paste the https:// ping link your monitor gave you." });
    state.settings.healthcheckUrl = url || undefined;
    save();
    res.json(url ? await beat() : { ok: true, cleared: true });
  });
  api.post("/proactive/run", async (_req, res) => void res.json({ started: await runProactive({ now: true }) }));
  // Connect Claude from the app: checks the key with a tiny request, then saves it to .env.
  api.post("/setup/key", async (req, res) => {
    const key = str(req.body.key, 300).trim();
    if (!/^sk-ant-[\w-]{20,}$/.test(key)) return void res.status(400).json({ error: "That doesn't look like an Anthropic API key (it starts with sk-ant-)." });
    const check = await fetch("https://api.anthropic.com/v1/models?limit=1", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } }).catch(() => undefined);
    if (!check) return void res.status(502).json({ error: "Couldn't reach Anthropic. Check the Mac's internet connection." });
    if (check.status === 401 || check.status === 403) return void res.status(400).json({ error: "Anthropic rejected that key. Copy it again from platform.claude.com." });
    setAnthropicKey(key);
    stateChanged();
    res.json({ ok: true });
  });
  api.get("/thread/:id", (req, res) => {
    const id = String(req.params.id);
    if (state.groups.some((g) => g.id === id)) return void res.json({ messages: getThread(id, 200) });
    const b = botOr404(req, res);
    if (b) res.json({ messages: getThread(b.id, 200) });
  });

  // ---- the agent's own email address
  const emailView = () => {
    const s = emailSettings();
    return s ? { address: s.address, name: s.name, bot: getBot(s.botId)?.name ?? primaryBot().name, lastCheck: s.lastCheck ?? null, servers: `${s.imapHost} / ${s.smtpHost}` } : null;
  };
  api.get("/email", (_req, res) => void res.json({ email: emailView() }));
  api.get("/email/preset", (req, res) => void res.json({ known: !!presetFor(str(req.query.address, 200)) }));
  api.post("/email", async (req, res) => {
    try {
      await setupEmail({
        address: str(req.body.address, 200), password: str(req.body.password, 300), name: str(req.body.name, 60) || undefined,
        botId: str(req.body.botId) || undefined,
        imapHost: str(req.body.imapHost, 200) || undefined, smtpHost: str(req.body.smtpHost, 200) || undefined,
        imapPort: Number(req.body.imapPort) || undefined, smtpPort: Number(req.body.smtpPort) || undefined,
      });
      closeWarmSession(); // bots learn their address
      res.json({ email: emailView() });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });
  api.delete("/email", async (_req, res) => {
    await removeEmail();
    closeWarmSession();
    res.json({ ok: true });
  });
  api.post("/email/check", async (_req, res) => void res.json({ found: await checkInbox(), email: emailView() }));
  api.post("/email/test-inbound", (req, res) => {
    try {
      fakeInbound({ from: str(req.body.from, 200), to: emailSettings()?.address ?? "", subject: str(req.body.subject, 300), date: new Date().toISOString(), text: str(req.body.text, 8000), messageId: `<test-${Date.now()}@example.com>` });
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  // ---- group chats: several bots in one conversation, a lead that hands work to the others
  const cleanMembers = (ids: unknown) => [...new Set((Array.isArray(ids) ? ids : []).map(String))].filter((id) => getBot(id));
  api.post("/groups", (req, res) => {
    const members = cleanMembers(req.body.members);
    const name = str(req.body.name, 40).trim();
    if (!name) return void res.status(400).json({ error: "Give the group a name." });
    if (members.length < 2 || members.length > 6) return void res.status(400).json({ error: "Pick 2 to 6 bots." });
    const leadId = members.includes(str(req.body.leadId)) ? str(req.body.leadId) : members[0]!;
    const g = { id: `g-${randomBytes(4).toString("hex")}`, name, members, leadId, createdAt: new Date().toISOString() };
    state.groups.push(g);
    save();
    stateChanged();
    res.json({ id: g.id });
  });
  api.patch("/groups/:id", (req, res) => {
    const g = state.groups.find((x) => x.id === req.params.id);
    if (!g) return void res.status(404).json({ error: "No such group." });
    if (req.body.name) g.name = str(req.body.name, 40).trim() || g.name;
    if (req.body.members) {
      const members = cleanMembers(req.body.members);
      if (members.length < 2 || members.length > 8) return void res.status(400).json({ error: "A group needs 2 to 8 bots." });
      g.members = members;
    }
    if (req.body.leadId && g.members.includes(str(req.body.leadId))) g.leadId = str(req.body.leadId);
    if (!g.members.includes(g.leadId)) g.leadId = g.members[0]!;
    save();
    stateChanged();
    res.json({ ok: true });
  });
  api.post("/groups/:id/fresh", (req, res) => {
    const g = state.groups.find((x) => x.id === req.params.id);
    if (!g) return void res.status(404).json({ error: "No such group." });
    for (const key of Object.keys(state.groupSessions)) if (key.startsWith(`${g.id}:`)) delete state.groupSessions[key];
    for (const id of g.members) closeWarmSession(id);
    save();
    res.json({ ok: true });
  });
  api.delete("/groups/:id", (req, res) => {
    const g = state.groups.find((x) => x.id === req.params.id);
    if (!g) return void res.status(404).json({ error: "No such group." });
    state.groups = state.groups.filter((x) => x.id !== g.id);
    for (const key of Object.keys(state.groupSessions)) if (key.startsWith(`${g.id}:`)) delete state.groupSessions[key];
    deleteThread(g.id);
    save();
    stateChanged();
    res.json({ ok: true });
  });

  // Live updates (Server-Sent Events): new/updated messages and state changes.
  api.get("/events", (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    // "hello" on connect and a named "ping" every 20s let the app notice when a tunnel buffers the stream
    // (it then polls instead), and keep proxies from closing an idle connection.
    res.write("retry: 2000\n\nevent: hello\ndata: {}\n\n");
    const send = (chunk: string) => void (!res.writableEnded && !res.destroyed && res.write(chunk));
    const onMsg = (m: Msg) => send(`event: msg\ndata: ${JSON.stringify(m)}\n\n`);
    const onState = () => send(`event: state\ndata: {}\n\n`);
    const ping = setInterval(() => send("event: ping\ndata: {}\n\n"), 20_000);
    events.on("msg", onMsg);
    events.on("state", onState);
    req.on("close", () => {
      clearInterval(ping);
      events.off("msg", onMsg);
      events.off("state", onState);
    });
  });

  // ---- chat
  api.post("/send", bigJson, (req, res) => {
    const id = str(req.body.botId);
    const to = state.groups.some((g) => g.id === id) ? id : (getBot(id) ?? activeBot()).id; // a bot, or a group chat
    const attachments = saveUploads(req.body.attachments);
    if (!str(req.body.text).trim() && !attachments.length) return void res.status(400).json({ error: "empty" });
    handleUserMessage(str(req.body.text), { botId: to, attachments, voice: !!req.body.voice, source: "app" });
    res.json({ ok: true });
  });
  api.post("/voice", bigJson, async (req, res) => {
    try {
      const saved = saveToInbox(str(req.body.name, 80) || "voice.webm", Buffer.from(str(req.body.data, 40_000_000), "base64"));
      try {
        res.json({ text: await transcribe(saved) });
      } finally {
        fs.rmSync(saved, { force: true }); // the recording isn't needed once it's text
      }
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });
  api.post("/stop", (req, res) => void res.json({ ok: stopCurrent(req.body?.botId) }));
  api.post("/card/:id", (req, res) => {
    const ok = answerCard(String(req.params.id), str(req.body.value, 40), req.body.body === undefined ? undefined : str(req.body.body));
    res.status(ok ? 200 : 409).json({ ok });
  });
  api.post("/feedback", (req, res) => void res.json({ ok: giveFeedback(str(req.body.botId), str(req.body.msgId), !!req.body.up, req.body.note ? str(req.body.note, 500) : undefined) }));

  // ---- bots
  api.post("/bots", (req, res) => {
    try {
      const b = req.body.template ? createBotFromTemplate(str(req.body.template)) : createBot(str(req.body.name, 32), str(req.body.job, 500), str(req.body.style, 300) || undefined);
      if (!req.body.template && req.body.look && typeof req.body.look === "object") b.look = cleanLook(req.body.look);
      if (req.body.emoji) b.emoji = str(req.body.emoji, 8);
      save();
      stateChanged();
      res.json({ id: b.id });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });
  api.post("/bots/:id/duplicate", (req, res) => {
    const b = botOr404(req, res);
    if (!b) return;
    try {
      res.json({ id: duplicateBot(b).id });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });
  api.post("/bots/:id/template", (req, res) => {
    const b = botOr404(req, res);
    if (b) res.json({ key: saveAsTemplate(b) });
  });
  api.get("/today", (_req, res) => void res.json(todaySummary()));
  api.patch("/bots/:id", (req, res) => {
    const b = botOr404(req, res);
    if (!b) return;
    try {
      if (req.body.name) renameBot(b, str(req.body.name, 32));
    } catch (error) {
      return void res.status(400).json({ error: (error as Error).message });
    }
    if (req.body.job) b.job = str(req.body.job, 500);
    if (req.body.style !== undefined) b.style = str(req.body.style, 300); // may be cleared
    if (req.body.emoji) b.emoji = str(req.body.emoji, 8);
    if (req.body.model !== undefined) b.model = req.body.model && req.body.model !== "auto" ? MODEL_ALIASES[str(req.body.model)] ?? str(req.body.model, 60) : undefined;
    if (req.body.quiet !== undefined) b.quiet = !!req.body.quiet;
    if (["low", "medium", "high"].includes(req.body.spice)) b.spice = req.body.spice;
    if (req.body.ownBrowser !== undefined) b.ownBrowser = !!req.body.ownBrowser;
    if (req.body.look && typeof req.body.look === "object") b.look = cleanLook(req.body.look);
    if (req.body.name || req.body.job || req.body.style !== undefined || req.body.model !== undefined || req.body.spice || req.body.ownBrowser !== undefined) closeWarmSession(b.id); // pick up the new settings
    if (req.body.active) state.activeBotId = b.id;
    if (req.body.primary) state.primaryBotId = b.id;
    save();
    stateChanged();
    res.json({ ok: true });
  });
  api.post("/bots/:id/fresh", (req, res) => {
    const b = botOr404(req, res);
    if (!b) return;
    stopCurrent(b.id); // a fresh start: whatever it was doing belongs to the old chat
    freshChat(b);
    closeWarmSession(b.id);
    save();
    stateChanged();
    res.json({ ok: true });
  });
  api.delete("/bots/:id", (req, res) => {
    const b = botOr404(req, res);
    if (!b) return;
    try {
      deleteBot(b);
      stopBot(b.id); // in every chat, not just its own
      // Out of its groups too; a group left with fewer than 2 bots is removed.
      for (const g of state.groups) g.members = g.members.filter((id) => id !== b.id);
      for (const g of state.groups.filter((x) => x.members.length < 2)) deleteThread(g.id);
      state.groups = state.groups.filter((g) => g.members.length >= 2);
      for (const g of state.groups) if (!g.members.includes(g.leadId)) g.leadId = g.members[0]!;
      save();
      closeWarmSession(b.id);
      deleteThread(b.id);
      stateChanged();
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  // ---- memory
  api.get("/memory/:id", (req, res) => {
    const b = botOr404(req, res);
    if (!b) return;
    const sharedFile = path.join(config.workspace, "CLAUDE.md");
    res.json({ lines: memoryLines(b), shared: fs.existsSync(sharedFile) ? fs.readFileSync(sharedFile, "utf8") : "" });
  });
  api.post("/memory/:id/delete", (req, res) => {
    const b = botOr404(req, res);
    if (b) res.json({ ok: deleteMemoryLine(b, Number(req.body.index), str(req.body.text)) });
  });

  // ---- routines, templates, skills
  api.get("/routines", (_req, res) =>
    void res.json(
      state.routines.map((r) => ({
        ...r,
        bot: getBot(r.botId)?.name ?? "?",
        next: nextRun(r.id)?.toISOString() ?? null,
        when: r.trigger ? describeTrigger(r.trigger).replace(/ \(\/hook\/.*\)$/, "") : null,
        hook: r.trigger?.kind === "webhook" ? `/hook/${r.trigger.token}` : null,
        lastRun: lastRunOf(r),
        scheduleText: r.trigger ? null : describeSchedule(r.schedule),
      })),
    ),
  );
  api.post("/routines/:id/run", (req, res) => void res.json({ ok: testRoutine(String(req.params.id)) }));
  api.delete("/routines/:id", (req, res) => {
    const routine = state.routines.find((r) => r.id === req.params.id);
    const ok = removeRoutine(String(req.params.id));
    stateChanged();
    res.json({ ok, routine }); // the app keeps it for Undo
  });
  api.post("/routines/restore", (req, res) => {
    const r = req.body.routine as Record<string, unknown> | undefined;
    if (!r || typeof r.id !== "string" || !/^[\w-]{1,40}$/.test(r.id) || typeof r.botId !== "string" || typeof r.prompt !== "string" || typeof r.schedule !== "string") return void res.status(400).json({ error: "That routine can't be restored." });
    try {
      const trigger = r.trigger as Record<string, unknown> | undefined;
      const clean = {
        id: r.id, botId: r.botId, name: str(r.name, 120), schedule: str(r.schedule, 120), prompt: str(r.prompt, 20_000), createdAt: str(r.createdAt, 40) || new Date().toISOString(),
        ...(trigger ? { trigger: JSON.parse(JSON.stringify(trigger)) } : {}),
      };
      restoreRoutine(clean as Parameters<typeof restoreRoutine>[0]);
      stateChanged();
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });
  api.get("/templates", (_req, res) => void res.json({ routines: ROUTINE_TEMPLATES, bots: BOT_TEMPLATES, custom: customTemplates() }));
  api.delete("/templates/:key", (req, res) => {
    try {
      deleteTemplate(String(req.params.key));
      res.json({ ok: true });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });
  api.post("/templates/routine", (req, res) => void res.json({ ok: setupRoutineTemplate(str(req.body.key), str(req.body.botId) || undefined) }));
  api.get("/skills", (_req, res) => void res.json(skills.skillsOverview(listSkills())));
  // Skills are plain Markdown the user can read, edit, version, export and import.
  const guard = (fn: (req: Request, res: Response) => void) => (req: Request, res: Response) => {
    try {
      fn(req, res);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  };
  api.get("/skills/library", (_req, res) => void res.json(skills.libraryList()));
  api.post("/skills/library/:name", guard((req, res) => void res.json({ name: skills.addFromLibrary(String(req.params.name)) })));
  api.post("/skills/import", guard((req, res) => {
    const text = req.body.data ? Buffer.from(str(req.body.data, 400_000), "base64").toString("utf8") : str(req.body.text, 200_000);
    res.json({ name: skills.importSkill(text, str(req.body.fileName, 120)) });
  }));
  api.get("/skills/:name", guard((req, res) => {
    const file = skills.skillPath(String(req.params.name));
    if (!fs.existsSync(file)) return void res.status(404).json({ error: "No such skill." });
    res.json({ name: req.params.name, text: fs.readFileSync(file, "utf8"), versions: skills.skillVersions(String(req.params.name)) });
  }));
  api.get("/skills/:name/export", guard((req, res) => {
    const file = skills.skillPath(String(req.params.name));
    if (!fs.existsSync(file)) return void res.sendStatus(404);
    res.attachment(`${req.params.name}.skill.md`).type("text/markdown").send(fs.readFileSync(file, "utf8"));
  }));
  api.put("/skills/:name", guard((req, res) => {
    const name = String(req.params.name);
    if (!fs.existsSync(skills.skillPath(name))) return void res.status(404).json({ error: "No such skill." });
    const text = str(req.body.text, 60_000);
    if (!/^---\n[\s\S]*?\n---/.test(text)) return void res.status(400).json({ error: "Keep the --- header with the name and description at the top." });
    skills.writeSkill(name, skills.cleanSkill(text, name).text.replace(/^name: .*$/m, `name: ${name}`));
    res.json({ ok: true });
  }));
  api.post("/skills/:name/restore", guard((req, res) => {
    skills.restoreSkillVersion(String(req.params.name), str(req.body.version, 80));
    res.json({ ok: true });
  }));

  // ---- teach by demo: record the screen while the user does a task, then the bot writes the skill
  api.post("/teach/start", async (req, res) => {
    try {
      const b = getBot(str(req.body.botId)) ?? activeBot();
      res.json(await startTeaching(b.id, str(req.body.title, 80).trim()));
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });
  api.post("/teach/stop", async (req, res) => {
    try {
      res.json(await stopTeaching(str(req.body?.note, 2000)));
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });
  api.post("/skills/:name/run", (req, res) => {
    const name = String(req.params.name);
    if (!/^[\w-][\w.-]*$/.test(name)) return void res.status(400).json({ error: "bad skill name" });
    handleUserMessage(runSkillPrompt(name), { botId: str(req.body.botId) || undefined, source: "app" });
    res.json({ ok: true });
  });
  api.delete("/skills/:name", (req, res) => {
    const name = String(req.params.name);
    if (!/^[\w-][\w.-]*$/.test(name)) return void res.status(400).json({ error: "bad skill name" });
    const dir = path.join(config.skillsDir, name);
    if (!inside(dir, config.skillsDir) || dir === config.skillsDir) return void res.status(400).json({ error: "bad skill name" });
    // Kept aside for a minute-long Undo (and a day after that), not deleted outright.
    const trash = path.join(config.dataDir, "skill-trash", `${name}-${Date.now()}`);
    fs.mkdirSync(path.dirname(trash), { recursive: true });
    fs.renameSync(dir, trash);
    res.json({ ok: true, undo: path.basename(trash) });
  });
  api.post("/skills/:name/undelete", (req, res) => {
    const name = String(req.params.name);
    const id = str(req.body.undo, 200);
    if (!/^[\w-][\w.-]*$/.test(name) || !/^[\w.-]+$/.test(id) || !id.startsWith(`${name}-`)) return void res.status(400).json({ error: "Nothing to undo." });
    const from = path.join(config.dataDir, "skill-trash", id);
    const to = path.join(config.skillsDir, name);
    if (!fs.existsSync(from) || fs.existsSync(to)) return void res.status(409).json({ error: "That can't be undone any more." });
    fs.renameSync(from, to);
    res.json({ ok: true });
  });

  // ---- safety: rules, connectors, settings, activity
  api.get("/rules", (_req, res) => void res.json(state.rules.map((r) => ({ ...r, text: describeRule(r) }))));
  api.post("/rules", (req, res) => {
    const match = str(req.body.match, 200).trim();
    if (!match) return void res.status(400).json({ error: "empty" });
    addRule({ effect: "ask", tool: "*", match });
    stateChanged();
    res.json({ ok: true });
  });
  api.delete("/rules/:id", (req, res) => {
    state.rules = state.rules.filter((r) => r.id !== req.params.id);
    save();
    stateChanged();
    res.json({ ok: true });
  });
  api.get("/connectors", (_req, res) => void res.json(Object.entries(state.connectors).map(([name, c]) => ({ name, type: c.type, access: c.access, target: c.url ?? c.command }))));
  api.patch("/connectors/:name", (req, res) => {
    const c = Object.hasOwn(state.connectors, String(req.params.name)) ? state.connectors[String(req.params.name)] : undefined;
    if (!c || !["read", "full", "off"].includes(str(req.body.access))) return void res.status(400).json({ error: "bad request" });
    c.access = str(req.body.access) as "read" | "full" | "off";
    save();
    closeWarmSession(); // running engines pick up the new access (busy ones right after their task)
    res.json({ ok: true });
  });
  api.delete("/connectors/:name", (req, res) => {
    if (Object.hasOwn(state.connectors, String(req.params.name))) delete state.connectors[String(req.params.name)];
    save();
    closeWarmSession();
    res.json({ ok: true });
  });
  api.patch("/settings", (req, res) => {
    for (const key of ["autoReview", "proactive", "voiceReplies", "fullAccess", "verify"] as const) {
      if (req.body[key] !== undefined) state.settings[key] = !!req.body[key];
    }
    if (["morning", "thrice"].includes(req.body.proactiveMode)) state.settings.proactiveMode = req.body.proactiveMode;
    save();
    stateChanged();
    res.json(state.settings);
  });
  api.get("/history", (_req, res) => void res.json(state.runs.slice(-60).reverse()));
  api.get("/log", (_req, res) => void res.json(recentAudit(80).reverse()));

  // ---- secrets vault (names only ever leave the Mac; values go into the Keychain)
  api.get("/secrets", (_req, res) => void res.json(listSecrets()));
  api.post("/secrets", async (req, res) => {
    try {
      const name = await saveSecret(str(req.body.name, 60), str(req.body.value, 5000), str(req.body.note, 200));
      closeWarmSession(); // bots learn the new name
      res.json({ ok: true, name });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });
  api.delete("/secrets/:name", async (req, res) => {
    await deleteSecret(String(req.params.name));
    closeWarmSession();
    res.json({ ok: true });
  });

  // ---- files (artifacts)
  api.get("/files", (_req, res) => void res.json(recentFiles(60)));
  api.get("/file", (req, res) => {
    const full = path.resolve(config.workspace, str(req.query.path, 1000));
    if (!inside(full, config.workspace) || isSensitive(full) || !fs.existsSync(full) || !fs.statSync(full).isFile()) return void res.sendStatus(404);
    if (req.query.download) res.attachment(path.basename(full));
    // Files bots make are untrusted: a page or SVG opens sandboxed (no scripts, its own origin), so it can never
    // act with the user's sign-in (approving cards, changing settings). Styles, images and fonts still show.
    if (/\.(html?|svg|xml)$/i.test(full)) {
      res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: blob: 'self'; font-src data:; media-src 'self'");
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.sendFile(full, { dotfiles: "allow" }); // the checks above already keep private files out
  });

  // ---- the bot's computer: watch and take control
  api.get("/screen", async (_req, res) => {
    try {
      const view = await mac.liveView();
      res.set({ "Content-Type": "image/jpeg", "Cache-Control": "no-store", "X-Width": String(view.width), "X-Height": String(view.height) }).send(view.data);
    } catch (error) {
      res.status(503).json({ error: (error as Error).message });
    }
  });
  // Live video of the screen: a stream of JPEG frames, each prefixed with its 4-byte length.
  api.get("/screen/stream", async (req, res) => {
    // The viewer may leave while the stream is still starting: remember that, so it's never left subscribed.
    let closed = false;
    let stop: (() => void) | undefined;
    res.on("close", () => {
      closed = true;
      stop?.();
    });
    try {
      const viewer = {
        busy: false,
        write: (frame: Buffer) => {
          if (closed || res.writableEnded || res.destroyed) return true;
          if (!res.headersSent) {
            res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
          }
          const head = Buffer.alloc(4);
          head.writeUInt32BE(frame.length);
          res.write(head);
          return res.write(frame);
        },
      };
      res.on("drain", () => (viewer.busy = false));
      const unsubscribe = await screen.watchScreen({ width: Number(req.query.w) || 1280, fps: Number(req.query.fps) || 10 }, viewer);
      if (closed) return unsubscribe();
      stop = unsubscribe;
      if (!res.headersSent) {
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
        res.flushHeaders();
      }
    } catch (error) {
      if (!res.headersSent) res.status(503).json({ error: (error as Error).message });
      else res.end();
    }
  });
  api.get("/screen/status", (_req, res) => void res.json({ error: screen.streamError() }));
  api.post("/screen/pointer", async (req, res) => {
    const b = req.body ?? {};
    const actions = ["move", "click", "double", "right", "down", "drag", "up"];
    if (!actions.includes(b.action)) return void res.status(400).json({ error: "bad action" });
    try {
      await screen.pointer(b.action, Number(b.nx), Number(b.ny));
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: inputError(error) });
    }
  });
  api.post("/screen/wheel", async (req, res) => {
    try {
      await screen.scrollWheel(Number(req.body?.dx) || 0, Number(req.body?.dy) || 0);
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: inputError(error) });
    }
  });
  api.post("/screen/:action", async (req, res) => {
    try {
      const b = req.body ?? {};
      switch (req.params.action) {
        case "click": await mac.click(Number(b.x), Number(b.y), b.kind === "right" ? "right" : b.kind === "double" ? "double" : "left"); break;
        case "type": await mac.typeText(str(b.text, 2000)); break;
        case "key": await mac.pressKeys(str(b.keys, 40)); break;
        case "scroll": await mac.scroll(b.direction === "up" ? "up" : "down", 1); break;
        default: return void res.sendStatus(404);
      }
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // ---- notifications
  api.post("/push/subscribe", (req, res) => {
    addSubscription(req.body);
    res.json({ ok: true });
  });

  app.use("/api", api);
  const server = app.listen(config.webPort, "0.0.0.0", () => console.log(`App running on http://localhost:${config.webPort}`));
  attachRemote(server, (req) => matches(cookieOf(req))); // remote desktop: video + input over one WebSocket
}
