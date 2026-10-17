import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import { config } from "./config.js";
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

export function startRoutines() {
  for (const routine of [...state.routines]) {
    try {
      if (!schedule(routine)) removeRoutine(routine.id);
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
  if (!next) {
    jobs.get(routine.id)?.stop();
    jobs.delete(routine.id);
    throw new Error("That schedule never runs (is the date in the past?)");
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
