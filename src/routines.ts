import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Cron } from "croner";
import { config } from "./config.js";
import { recentMail } from "./macdata.js";
import { post } from "./outbox.js";
import { isSensitive } from "./permissions.js";
import { save, state, type Routine, type RoutineTrigger } from "./store.js";

/** What started a routine run, when it wasn't the clock. `data` comes from outside and is never instructions. */
export type RoutineEvent = { summary: string; data?: string };

const jobs = new Map<string, Cron>();
let runner: (routine: Routine, event?: RoutineEvent) => void = () => {};

export function setRoutineRunner(fn: (routine: Routine, event?: RoutineEvent) => void) {
  runner = fn;
}

// ---------------------------------------------------------------- event triggers (all local)
const watchers = new Map<string, { close: () => void }>();
let mailTimer: NodeJS.Timeout | undefined;
let mailSince = Date.now();

function arm(routine: Routine) {
  const t = routine.trigger;
  if (!t) return;
  if (t.kind === "folder") {
    disarm(routine.id);
    const known = new Set(fs.readdirSync(t.path)); // files already there don't count
    const pending = new Map<string, NodeJS.Timeout>();
    const seen = (name: string) => {
      if (!name || name.startsWith(".") || known.has(name) || /\.(tmp|part|crdownload|download)$/i.test(name)) return;
      clearTimeout(pending.get(name));
      // Wait until the file has finished arriving (downloads and copies write in pieces).
      pending.set(name, setTimeout(() => {
        pending.delete(name);
        const full = path.join(t.path, name);
        if (known.has(name) || !fs.existsSync(full) || !fs.statSync(full).isFile()) return;
        known.add(name);
        runner(routine, { summary: `A new file arrived: ${name}`, data: full });
      }, 3000));
    };
    const w = fs.watch(t.path, (_type, name) => name && seen(name));
    w.on("error", (e) => console.error(`Folder trigger for "${routine.name}" stopped:`, e.message));
    // macOS can drop or coalesce file events: a quick look at the folder every 15 s catches anything missed.
    const rescan = () => {
      try {
        for (const name of fs.readdirSync(t.path)) if (!pending.has(name)) seen(name);
      } catch {}
    };
    const first = setTimeout(rescan, 1000);
    const every = setInterval(rescan, 15_000);
    every.unref();
    watchers.set(routine.id, {
      close: () => {
        w.close();
        clearTimeout(first);
        clearInterval(every);
        for (const p of pending.values()) clearTimeout(p);
      },
    });
  }
  if (t.kind === "mail") startMailPolling();
}

function disarm(id: string) {
  watchers.get(id)?.close();
  watchers.delete(id);
}

/** Checks Mail.app every 5 minutes, only while some routine waits for email (and only if Mail is open). */
function startMailPolling() {
  if (mailTimer) return;
  mailTimer = setInterval(async () => {
    const routines = state.routines.filter((r) => r.trigger?.kind === "mail");
    if (!routines.length) return void (clearInterval(mailTimer), (mailTimer = undefined));
    const since = mailSince;
    mailSince = Date.now();
    let mail: Awaited<ReturnType<typeof recentMail>>;
    try {
      mail = await recentMail({ limit: 30 });
    } catch {
      return; // Mail closed or not allowed yet; the self-test and the tool explain that
    }
    for (const m of mail.filter((x) => Date.parse(x.date) > since)) {
      for (const r of routines) {
        const t = r.trigger as Extract<RoutineTrigger, { kind: "mail" }>;
        if (t.from && !m.from.toLowerCase().includes(t.from.toLowerCase())) continue;
        if (t.subject && !m.subject.toLowerCase().includes(t.subject.toLowerCase())) continue;
        runner(r, { summary: `New email from ${m.from}: "${m.subject}"`, data: `From: ${m.from}\nSubject: ${m.subject}\nDate: ${m.date}\n\n${m.preview ?? ""}` });
      }
    }
  }, 5 * 60_000);
  mailTimer.unref();
}

/** Called by the webhook URL. Returns false if no routine has that token. */
export function fireWebhook(token: string, body: string) {
  const routine = state.routines.find((r) => r.trigger?.kind === "webhook" && r.trigger.token === token);
  if (!routine) return false;
  runner(routine, { summary: "Its webhook was called", data: body.slice(0, 20_000) });
  return true;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const clock = (h: number, m: number) => `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
const nth = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

/** A schedule in words: "0 8 * * 1-5" → "Weekdays at 8:00 AM". Anything unusual is shown as written. */
export function describeSchedule(schedule: string) {
  const s = schedule.trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? s : `Once, ${d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
  }
  const f = s.split(/\s+/);
  if (f.length !== 5) return s;
  const [min, hour, dom, mon, dow] = f as [string, string, string, string, string];
  const every = /^\*\/(\d+)$/;
  if (every.test(min) && hour === "*" && dom === "*" && mon === "*" && dow === "*") return `Every ${every.exec(min)![1]} minutes`;
  if (/^\d+$/.test(min) && every.test(hour) && dom === "*" && mon === "*" && dow === "*") return `Every ${every.exec(hour)![1]} hours`;
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour) || mon !== "*") return s;
  const at = clock(Number(hour), Number(min));
  if (dom === "*" && dow === "*") return `Every day at ${at}`;
  if (dom === "*" && dow === "1-5") return `Weekdays at ${at}`;
  if (dom === "*" && /^(0,6|6,0)$/.test(dow)) return `Weekends at ${at}`;
  if (dom === "*" && /^[0-7](,[0-7])*$/.test(dow)) return `Every ${dow.split(",").map((d) => DAYS[Number(d) % 7]).join(" and ")} at ${at}`;
  if (/^\d+$/.test(dom) && dow === "*") return `Monthly on the ${nth(Number(dom))} at ${at}`;
  return s;
}

export function describeTrigger(t: RoutineTrigger) {
  if (t.kind === "webhook") return `when its link is called (/hook/${t.token})`;
  if (t.kind === "folder") return `when a new file appears in ${t.path}`;
  return `when an email arrives${t.from ? ` from "${t.from}"` : ""}${t.subject ? ` with "${t.subject}" in the subject` : ""}`;
}

/** Adds a routine started by an event instead of the clock. Throws with a plain reason if it can't work. */
export function addEventRoutine(botId: string, name: string, trigger: RoutineTrigger, prompt: string) {
  if (state.routines.filter((r) => r.botId === botId).length >= 50) throw new Error("A bot can have at most 50 routines.");
  if (trigger.kind === "folder") {
    const full = path.resolve(trigger.path.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
    if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) throw new Error(`There's no folder at ${full}.`);
    if (isSensitive(full)) throw new Error("That folder is protected.");
    try {
      fs.readdirSync(full);
    } catch {
      throw new Error("macOS doesn't let Blip read that folder. Use a folder inside ~/Blip/workspace, or give node Full Disk Access.");
    }
    trigger = { kind: "folder", path: full };
  }
  if (trigger.kind === "mail" && !trigger.from && !trigger.subject) throw new Error("Say which emails: a sender, a subject word, or both.");
  const routine: Routine = { id: randomUUID().slice(0, 8), botId, name, schedule: "event", trigger, prompt, createdAt: new Date().toISOString() };
  arm(routine);
  state.routines.push(routine);
  save();
  return routine;
}

export const newWebhookToken = () => randomBytes(18).toString("base64url");

function schedule(routine: Routine): Date | null {
  jobs.get(routine.id)?.stop();
  if (routine.trigger) return null;
  const job = new Cron(routine.schedule, { timezone: config.timezone, protect: true }, () => {
    runner(routine);
    if (!job.nextRun()) removeRoutine(routine.id); // one-time routine is done
  });
  jobs.set(routine.id, job);
  return job.nextRun();
}

const isOneTime = (schedule: string) => /\d{4}-\d{2}-\d{2}/.test(schedule);

export function startRoutines() {
  for (const routine of [...state.routines]) {
    try {
      if (routine.trigger) {
        arm(routine);
        continue;
      }
      if (schedule(routine)) continue;
      // A one-time routine that came due while the Mac was off or restarting: run it late rather than
      // dropping it silently, unless it's more than a day old (then say it was missed).
      const due = new Date(routine.schedule).getTime();
      if (isOneTime(routine.schedule) && Date.now() - due < 24 * 3_600_000) runner(routine);
      else if (state.bots.some((b) => b.id === routine.botId)) {
        post(routine.botId, `Missed "${routine.name}": it was due ${routine.schedule.replace("T", " ")}, while Blip wasn't running.`, { role: "system" });
      }
      removeRoutine(routine.id);
    } catch (error) {
      console.error(`Routine ${routine.name} has an invalid schedule:`, error);
    }
  }
}

/** Throws if the schedule is invalid or never fires. */
export function addRoutine(botId: string, name: string, scheduleText: string, prompt: string) {
  if (state.routines.filter((r) => r.botId === botId).length >= 50) throw new Error("A bot can have at most 50 routines.");
  const routine: Routine = { id: randomUUID().slice(0, 8), botId, name, schedule: scheduleText, prompt, createdAt: new Date().toISOString() };
  const next = schedule(routine);
  const [first, second] = jobs.get(routine.id)?.nextRuns(2) ?? [];
  const tooOften = first && second && second.getTime() - first.getTime() < 10 * 60_000;
  if (!next || tooOften) {
    jobs.get(routine.id)?.stop();
    jobs.delete(routine.id);
    throw new Error(next ? "Routines can run at most every 10 minutes." : "That schedule never runs (is the date in the past?)");
  }
  state.routines.push(routine);
  save();
  return { routine, next };
}

export function removeRoutine(id: string) {
  jobs.get(id)?.stop();
  jobs.delete(id);
  disarm(id);
  const before = state.routines.length;
  state.routines = state.routines.filter((r) => r.id !== id);
  save();
  return state.routines.length < before;
}

export function nextRun(id: string) {
  return jobs.get(id)?.nextRun() ?? null;
}

export function describeRoutines() {
  if (!state.routines.length) return "No routines yet.";
  return state.routines
    .map((r) => {
      const next = nextRun(r.id);
      const when = r.trigger ? describeTrigger(r.trigger) : `${r.schedule} → next: ${next ? next.toLocaleString("en-US", { timeZone: config.timezone }) : "not scheduled"}`;
      const owner = state.bots.find((b) => b.id === r.botId)?.name ?? "?";
      return `• ${r.name} [${r.id}] (${owner})\n  ${when}\n  "${r.prompt.slice(0, 120)}"`;
    })
    .join("\n");
}

/** Internal schedules (e.g. proactive check-ins) that aren't user routines. */
export function scheduleInternal(pattern: string, fn: () => void) {
  return new Cron(pattern, { timezone: config.timezone, protect: true }, fn);
}
