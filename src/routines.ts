import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import { config } from "./config.js";
import { post } from "./outbox.js";
import { save, state, type Routine } from "./store.js";

const jobs = new Map<string, Cron>();
let runner: (routine: Routine) => void = () => {};

export function setRoutineRunner(fn: (routine: Routine) => void) {
  runner = fn;
}

function schedule(routine: Routine): Date | null {
  jobs.get(routine.id)?.stop();
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
      const when = next ? next.toLocaleString("en-US", { timeZone: config.timezone }) : "not scheduled";
      const owner = state.bots.find((b) => b.id === r.botId)?.name ?? "?";
      return `• ${r.name} [${r.id}] (${owner})\n  ${r.schedule} → next: ${when}\n  "${r.prompt.slice(0, 120)}"`;
    })
    .join("\n");
}

/** Internal schedules (e.g. proactive check-ins) that aren't user routines. */
export function scheduleInternal(pattern: string, fn: () => void) {
  return new Cron(pattern, { timezone: config.timezone, protect: true }, fn);
}
