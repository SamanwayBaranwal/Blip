import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { closeAllEngines, engineStats } from "./agent.js";
import { primaryBot } from "./bots.js";
import { computerHolder, resetComputer } from "./computer.js";
import { config, DATA_ROOT, ROOT } from "./config.js";
import { freshChat, runtime, stopCurrent } from "./core.js";
import { stateChanged } from "./hub.js";
import { post } from "./outbox.js";
import { restartRemote, remoteStats } from "./remote.js";
import { nextRun, scheduleInternal } from "./routines.js";
import { keychainWorks } from "./secrets.js";
import * as macdata from "./macdata.js";
import * as mac from "./mac.js";
import { voiceMissing } from "./voice.js";
import { save, state } from "./store.js";

// Keeping one Mac healthy for weeks: a health report, Recover and Reset buttons, nightly backups, a nightly
// self-test that says in one line whether everything still works, and an optional outside heartbeat.

const run = promisify(execFile);
const startedAt = Date.now();
const version = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version as string;
  } catch {
    return "?";
  }
})();
const findBin = (name: string) => ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map((d) => path.join(d, name)).find((p) => fs.existsSync(p));
const diskFreeGB = () => {
  const s = fs.statfsSync(DATA_ROOT);
  return Math.round(((s.bavail * s.bsize) / 1e9) * 10) / 10;
};

/** Chrome (and its browser tools) started with Blip's own profile; nothing else is ever touched. */
async function browserProcesses(kill = false) {
  const { stdout } = await run("/usr/bin/pgrep", ["-f", config.browserProfile]).catch(() => ({ stdout: "" }));
  const pids = stdout.split("\n").filter(Boolean);
  if (kill && pids.length) await run("/usr/bin/pkill", ["-f", config.browserProfile]).catch(() => {});
  return pids.length;
}

// ---------------------------------------------------------------- health report
export async function health() {
  const rt = runtime();
  return {
    ok: true,
    version,
    startedAt,
    uptimeSeconds: Math.round(process.uptime()),
    engines: engineStats(),
    tasks: { running: rt.running.length, queued: rt.queued.length, waitingForYou: rt.pendingCards },
    computer: computerHolder()?.botName ?? null,
    browserProcesses: await browserProcesses(),
    remote: remoteStats(),
    diskFreeGB: diskFreeGB(),
    routines: state.routines.length,
    lastBackup: state.health.lastBackup ?? null,
    lastSelfTest: state.health.lastSelfTest ?? null,
    heartbeat: heartbeatUrl() ? { set: true, last: lastBeat ?? null } : { set: false },
    authMode: config.anthropicKey ? "api" : "plan",
  };
}

// ---------------------------------------------------------------- Recover and Reset
/** Unsticks Blip without losing anything: stops tasks, restarts engines, closes a hung browser. */
export async function recover() {
  const steps: string[] = [];
  steps.push(stopCurrent() ? "Stopped the running tasks" : "No tasks were running");
  await closeAllEngines();
  steps.push("Restarted the bots' engines");
  resetComputer();
  const browsers = await browserProcesses(true);
  steps.push(browsers ? "Closed the bots' browser" : "The browser wasn't open");
  restartRemote();
  steps.push("Restarted screen sharing and input");
  stateChanged();
  console.log(`Recover: ${steps.join("; ")}`);
  return steps;
}

/** Recover, plus a fresh chat for every bot. Memory, routines, skills and secrets are kept. */
export async function reset() {
  const steps = await recover();
  for (const b of state.bots) freshChat(b);
  save();
  stateChanged();
  steps.push("Started a fresh chat for every bot (memory, routines and secrets are kept)");
  return steps;
}

// ---------------------------------------------------------------- backups
const BACKUP_DIR = process.env.BACKUP_DIR?.trim() || (process.env.BLIP_DATA_ROOT ? path.join(DATA_ROOT, "backups") : path.join(os.homedir(), "Blip-backups"));
const KEEP_BACKUPS = 14;

/** Archives data/ and workspace/ (minus the browser's caches) and keeps the newest 14. */
export async function backupNow() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const file = path.join(BACKUP_DIR, `blip-${stamp}.tgz`);
  try {
    await run(
      "/usr/bin/tar",
      [
        "-czf", file,
        "--exclude", "*/Cache", "--exclude", "*/Code Cache", "--exclude", "*/GPUCache", "--exclude", "*/CacheStorage",
        "--exclude", "*/ShaderCache", "--exclude", "*/GrShaderCache", "--exclude", "data/voice", "--exclude", "*.tmp",
        "--exclude", "data/browser-profile/Singleton*",
        "-C", DATA_ROOT, "data", "workspace",
      ],
      { timeout: 15 * 60_000, maxBuffer: 10_000_000 },
    );
    fs.chmodSync(file, 0o600);
    const bytes = fs.statSync(file).size;
    const old = fs.readdirSync(BACKUP_DIR).filter((f) => /^blip-.*\.tgz$/.test(f)).sort();
    for (const f of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) fs.rmSync(path.join(BACKUP_DIR, f), { force: true });
    state.health.lastBackup = { at: new Date().toISOString(), file, bytes, ok: true };
  } catch (error) {
    // tar exits 1 when a file changed while it was read (Chrome's live files): the archive is still usable.
    const usable = fs.existsSync(file) && fs.statSync(file).size > 0 && (error as { code?: number }).code === 1;
    state.health.lastBackup = usable
      ? { at: new Date().toISOString(), file, bytes: fs.statSync(file).size, ok: true }
      : { at: new Date().toISOString(), file, bytes: 0, ok: false, error: (error as Error).message.split("\n")[0] };
  }
  save();
  stateChanged();
  return state.health.lastBackup;
}

// ---------------------------------------------------------------- self-test
type Check = { name: string; ok: boolean; detail?: string };

async function modelReplies(): Promise<Check> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 90_000);
  try {
    for await (const m of query({
      prompt: "Reply with exactly: OK",
      options: {
        model: "claude-haiku-5-5",
        maxTurns: 1,
        tools: [],
        settingSources: [],
        cwd: os.tmpdir(),
        abortController: abort,
        env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE|^ANTHROPIC_(AUTH_TOKEN|BASE_URL)$/.test(k))),
      },
    })) {
      if (m.type === "result") {
        const ok = m.subtype === "success" && /\bOK\b/.test(m.result);
        return { name: "Claude replies", ok, detail: ok ? undefined : m.subtype === "success" ? m.result.slice(0, 80) : m.subtype };
      }
    }
    return { name: "Claude replies", ok: false, detail: "no answer" };
  } catch (error) {
    const msg = (error as Error).message;
    return { name: "Claude replies", ok: false, detail: /login|auth/i.test(msg) ? "Claude isn't signed in on this Mac" : msg.slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

export async function selfTest(opts: { post?: boolean } = {}) {
  const checks: Check[] = [await modelReplies()];
  const free = diskFreeGB();
  checks.push({ name: "Disk space", ok: free >= 5, detail: `${free} GB free` });
  const b = state.health.lastBackup;
  const backupAge = b ? (Date.now() - Date.parse(b.at)) / 3_600_000 : Infinity;
  checks.push({ name: "Last backup", ok: !!b?.ok && backupAge < 26, detail: b ? (b.ok ? `${Math.round(backupAge)} h ago` : b.error) : "none yet" });
  checks.push({ name: "Keychain", ok: await keychainWorks(), detail: "secrets vault" });
  checks.push({ name: "Chrome", ok: fs.existsSync("/Applications/Google Chrome.app") || !!process.env.BLIP_DATA_ROOT, detail: "the bots' browser" });
  checks.push({ name: "Browser tools", ok: fs.existsSync(config.playwrightCli) });
  checks.push({ name: "Screen tools", ok: !!findBin("ffmpeg"), detail: "ffmpeg" });
  const unscheduled = state.routines.filter((r) => !r.trigger && !nextRun(r.id)).map((r) => r.name);
  checks.push({ name: "Routines scheduled", ok: !unscheduled.length, detail: unscheduled.join(", ") || `${state.routines.length} active` });

  const passed = checks.filter((c) => c.ok).length;
  const failures = checks.filter((c) => !c.ok).map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ""}`);
  // healthchecks.io (and compatible monitors) alert on /fail too, so a broken Mac that's still on isn't missed.
  if (failures.length && /hc-ping\.com|healthchecks/.test(heartbeatUrl())) void beat("/fail");
  state.health.lastSelfTest = { at: new Date().toISOString(), passed, total: checks.length, failures };
  save();
  stateChanged();
  if (opts.post) {
    const time = new Date().toLocaleTimeString("en-GB", { timeZone: config.timezone, hour: "2-digit", minute: "2-digit" });
    post(
      primaryBot().id,
      failures.length ? `Self-test ${time} · ${passed}/${checks.length} passed. Needs a look: ${failures.join("; ")}.` : `Self-test ${time} · ${passed}/${checks.length} passed.`,
      { role: "system", push: failures.length > 0 }, // quiet when all is well, a notification when not
    );
  }
  return { passed, total: checks.length, checks };
}

// ---------------------------------------------------------------- Mac access check
// Tried for real on the Blip Mac, once after setup: reads and writes each app (a test event and a test reminder
// are made and deleted again), and says exactly how to fix anything macOS is blocking. macOS asks for each
// permission the first time; that's expected.
type AccessCheck = { name: string; ok: boolean; detail: string; fix?: string };

async function attempt(name: string, fn: () => Promise<string>, fix: (msg: string) => string | undefined): Promise<AccessCheck> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (error) {
    const msg = (error as Error).message;
    return { name, ok: false, detail: msg.split("\n")[0]!.slice(0, 200), fix: fix(msg) ?? msg };
  }
}
const privacyFix = (pane: string) => `On the Blip Mac: System Settings → Privacy & Security → ${pane} → turn on node, then try again.`;

export async function checkMacAccess() {
  const checks: AccessCheck[] = [];
  const tools = await run("/usr/bin/xcode-select", ["-p"]).then(() => true, () => false);
  checks.push({ name: "Apple command line tools", ok: tools, detail: tools ? "installed" : "missing", fix: tools ? undefined : "In Terminal on the Blip Mac: xcode-select --install, then ./blip.sh restart" });
  const soon = new Date(Date.now() + 2 * 3_600_000);
  const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  checks.push(await attempt("Calendar", async () => {
    const events = (await macdata.calendarEvents(local(new Date()).slice(0, 10), local(new Date(Date.now() + 2 * 86_400_000)).slice(0, 10))) as unknown[];
    const made = (await macdata.addCalendarEvent({ title: "Blip access check (deleted right away)", start: local(soon), end: local(new Date(soon.getTime() + 5 * 60_000)) })) as { id: string };
    await macdata.deleteCalendarEvent(made.id);
    return `read ${events.length} event${events.length === 1 ? "" : "s"} in the next 2 days; added and removed a test event`;
  }, (m) => (/access|privacy/i.test(m) ? privacyFix("Calendars") : undefined)));
  checks.push(await attempt("Reminders", async () => {
    const list = (await macdata.reminders()) as unknown[];
    const made = (await macdata.addReminder({ title: "Blip access check (deleted right away)" })) as { id: string };
    await macdata.deleteReminder(made.id);
    return `read ${list.length} open reminder${list.length === 1 ? "" : "s"}; added and removed a test reminder`;
  }, (m) => (/access|privacy/i.test(m) ? privacyFix("Reminders") : undefined)));
  checks.push(await attempt("Contacts", async () => {
    const found = (await macdata.findContacts("a")) as unknown[];
    return `can look people up (${found.length} match "a")`;
  }, (m) => (/access|privacy/i.test(m) ? privacyFix("Contacts") : undefined)));
  checks.push(await attempt("Mail", async () => {
    const mail = await macdata.recentMail({ limit: 5 });
    return `read the ${mail.length} newest message${mail.length === 1 ? "" : "s"}`;
  }, (m) => (/isn't open/.test(m) ? "Open Mail on the Blip Mac and leave it open (it starts with the Mac if you add it to Login Items)." : /Automation/.test(m) ? m : undefined)));
  checks.push(await attempt("Find files", async () => `Spotlight works (${(await macdata.findFiles("Blip")).length} results for "Blip")`, () => "Spotlight may still be indexing; try again in a few minutes."));
  checks.push(await attempt("Screen recording", async () => {
    if (process.env.BLIP_SCREEN_TEST) return "skipped (test mode)";
    const v = await mac.liveView();
    return `captured the screen (${v.width}×${v.height})`;
  }, () => privacyFix("Screen & System Audio Recording")));
  const r = remoteStats();
  const control = r.accessibility;
  checks.push({
    name: "Mouse and keyboard control",
    ok: control === true || !!process.env.BLIP_INPUT_DRYRUN,
    detail: process.env.BLIP_INPUT_DRYRUN ? "skipped (test mode)" : control === true ? "allowed" : control === false ? "blocked by macOS" : r.inputHelperBuilt ? "not checked yet" : "input helper not built",
    fix: control === true ? undefined : r.inputHelperBuilt ? privacyFix("Accessibility") : "Install Apple's command line tools (above), then ./blip.sh restart",
  });
  const ok = (n: string) => checks.find((c) => c.name === n)?.ok ?? false;
  state.macAccess = { calendar: ok("Calendar"), reminders: ok("Reminders"), contacts: ok("Contacts"), mail: ok("Mail"), at: new Date().toISOString() };
  save();
  const voice = voiceMissing();
  checks.push({ name: "Voice messages", ok: !voice, detail: voice ? "speech-to-text isn't installed" : "ready", fix: voice ? `In Terminal on the Blip Mac: ${voice}` : undefined });
  return { passed: checks.filter((c) => c.ok).length, total: checks.length, checks };
}

// ---------------------------------------------------------------- schedules and heartbeat
scheduleInternal(process.env.BACKUP_SCHEDULE?.trim() || "30 3 * * *", () => void backupNow());
scheduleInternal(process.env.SELFTEST_SCHEDULE?.trim() || "40 3 * * *", () => void selfTest({ post: true }));

// A dead Mac can't say it's dead. An outside monitor (e.g. healthchecks.io) alerts you when these pings stop.
// Only a bare GET is sent: no data about you or your bots. The link is set in the app (or HEALTHCHECK_URL).
export const heartbeatUrl = () => (state.settings.healthcheckUrl || process.env.HEALTHCHECK_URL || "").trim();
export let lastBeat: { at: string; ok: boolean; status?: number; error?: string } | undefined;

export async function beat(suffix = "") {
  const url = heartbeatUrl();
  if (!url) return undefined;
  try {
    const res = await fetch(url.replace(/\/$/, "") + suffix, { signal: AbortSignal.timeout(10_000) });
    lastBeat = { at: new Date().toISOString(), ok: res.ok, status: res.status };
  } catch (error) {
    lastBeat = { at: new Date().toISOString(), ok: false, error: (error as Error).message };
  }
  return lastBeat;
}
void beat();
setInterval(() => void beat(), 5 * 60_000).unref();
