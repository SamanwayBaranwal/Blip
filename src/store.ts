import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export type Routine = {
  id: string;
  botId: string;
  name: string;
  schedule: string; // cron ("0 8 * * *"), one-time ISO date ("2026-10-18T09:00:00"), or "event" (see trigger)
  trigger?: RoutineTrigger; // event routines: started by something happening instead of the clock
  prompt: string;
  createdAt: string;
};

export type RoutineTrigger =
  | { kind: "webhook"; token: string } // a private URL anything on your network can call (Shortcuts, scripts)
  | { kind: "folder"; path: string } // a new file appears in this folder
  | { kind: "mail"; from?: string; subject?: string }; // a new email in Mail.app matches

/** A group chat: several bots in one conversation. The lead answers and hands parts to the others. */
export type Group = { id: string; name: string; members: string[]; leadId: string; createdAt: string };

export type BotProfile = {
  id: string;
  name: string;
  emoji: string;
  job: string;
  style: string;
  model?: string; // per-bot model choice; falls back to MODEL in .env
  look?: BlipLook; // how this bot's Blip is dressed (avatar customization)
  quiet?: boolean; // deliver this bot's messages silently (no sound)
  spice?: "low" | "medium" | "high";
  ownBrowser?: boolean; // its own Chrome (logins copied from the shared one), so it browses in parallel
  helper?: { createdBy: string; groupId?: string; lastUsedAt: string }; // made by a bot for a job; tidied away when unused // how much personality: low = professional, medium (default), high = playful
  sessionId?: string;
  contextTokens?: number; // size of the current conversation, for the context meter
  createdAt: string;
};

/** Avatar customization. Values are accessory ids defined in web/app.js (LOOKS). */
export type BlipLook = { color?: string; hat?: string; eyes?: string; face?: string; neck?: string; hold?: string };

export type RunRecord = {
  at: string;
  bot: string;
  label: string;
  botId?: string;
  routineId?: string;
  status: "done" | "failed" | "stopped" | "nothing new";
  costUsd: number;
  seconds: number;
  summary: string;
};

/** "ask" rules stop any action whose description contains `match`; "allow" rules skip approval
 *  for a tool (optionally only when its main argument starts with `match`). Ask always wins. */
export type Rule = { id: string; effect: "ask" | "allow"; tool: string; match?: string; botId?: string }; // botId: an "Always allow" for one bot only

export type Connector = {
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  access: "read" | "full" | "off";
};

type State = {
  bots: BotProfile[];
  activeBotId?: string;
  primaryBotId?: string;
  rules: Rule[];
  routines: Routine[];
  connectors: Record<string, Connector>;
  settings: { autoReview: boolean; proactive: boolean; proactiveMode: "morning" | "thrice"; voiceReplies: boolean; fullAccess: boolean; verify: boolean; healthcheckUrl?: string; anywhere?: "off" | "cloudflare" | "tailscale" };
  /** The owner's own email (where Blip sends the phone link), and when it last did. */
  owner?: { email: string; lastEmailAt?: string };
  reachUrl?: string; // the last anywhere-link (to notice when it changes)
  loginLinks?: { hash: string; expires: number }[]; // one-time sign-in links (hashes only)
  setupDone?: boolean; // the first-run "Use Blip on your phone" steps were finished or skipped
  /** What the Mac access check found working (background runs only use these, so they never trigger a prompt). */
  macAccess?: { calendar?: boolean; reminders?: boolean; contacts?: boolean; mail?: boolean; at?: string };
  lastProactiveDay?: string;
  skillOffers?: string[];
  skillUse?: Record<string, { at: string; count: number }>; // when each skill was last used
  lastProactiveAt?: string; // the last check-in (for the app's status strip) // requests Blip already offered to turn into a skill (not offered again)
  groups: Group[];
  groupSessions: Record<string, string>; // "<groupId>:<botId>" → that bot's conversation in that group
  email?: import("./email.js").EmailSettings; // the agent's own email address (password in the Keychain)
  recentSuggestions: string[];
  dismissedSuggestions: string[];
  suggestionsByDay: Record<string, number>;
  runs: RunRecord[];
  budgetWarned: { day: string; level: number };
  onboarded: boolean;
  spendByDay: Record<string, number>;
  sessionTotals: Record<string, number>;
  /** Names of secrets in the Keychain (the values are never stored here). */
  secrets: { name: string; note: string; createdAt: string; lastUsedAt?: string }[];
  health: {
    lastBackup?: { at: string; file: string; bytes: number; ok: boolean; error?: string };
    lastSelfTest?: { at: string; passed: number; total: number; failures: string[] };
  };
};

const STATE_FILE = path.join(config.dataDir, "state.json");
const AUDIT_FILE = path.join(config.dataDir, "audit.jsonl");

function load(): State {
  const empty: State = {
    bots: [],
    rules: [],
    routines: [],
    connectors: {},
    settings: { autoReview: true, proactive: true, proactiveMode: "thrice", voiceReplies: false, fullAccess: false, verify: true },
    recentSuggestions: [],
    dismissedSuggestions: [],
    suggestionsByDay: {},
    runs: [],
    budgetWarned: { day: "", level: 0 },
    onboarded: false,
    spendByDay: {},
    sessionTotals: {},
    secrets: [],
    health: {},
    groups: [],
    groupSessions: {},
  };
  if (!fs.existsSync(STATE_FILE)) return empty;
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return { ...empty, ...saved, settings: { ...empty.settings, ...saved.settings } };
  } catch (error) {
    // Never silently start over on top of the user's bots and routines: keep the broken file to recover from.
    const backup = `${STATE_FILE}.broken-${Date.now()}`;
    fs.copyFileSync(STATE_FILE, backup);
    console.error(`state.json couldn't be read (${(error as Error).message}). Saved a copy at ${backup} and started fresh.`);
    return empty;
  }
}

export const state = load();

/** The name of a chat (a bot's own chat, or a group). */
export const chatName = (id: string) => state.bots.find((b) => b.id === id)?.name ?? state.groups.find((g) => g.id === id)?.name;
export const isGroup = (id: string) => state.groups.some((g) => g.id === id);

export function save() {
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
}

export function today() {
  return new Date().toLocaleDateString("en-CA", { timeZone: config.timezone });
}

export function spentToday() {
  return state.spendByDay[today()] ?? 0;
}

export function spentLastDays(days: number) {
  const cutoff = Date.now() - days * 86_400_000;
  return Object.entries(state.spendByDay)
    .filter(([day]) => new Date(day).getTime() >= cutoff)
    .reduce((sum, [, usd]) => sum + usd, 0);
}

export function addSpend(usd: number) {
  const day = today();
  state.spendByDay[day] = (state.spendByDay[day] ?? 0) + usd;
  const days = Object.keys(state.spendByDay).sort();
  for (const old of days.slice(0, Math.max(0, days.length - 60))) delete state.spendByDay[old];
  save();
}

// total_cost_usd is cumulative for a session, so only add what's new since we last saw it.
export function recordCost(sessionId: string, sessionTotalUsd: number) {
  // A crashed run can report 0, and a lower total than before means a step wasn't saved: neither may re-add
  // the whole history (that once used up a day's budget at once).
  if (!(sessionTotalUsd > 0)) return 0;
  const previous = state.sessionTotals[sessionId] ?? 0;
  const delta = Math.max(0, sessionTotalUsd - previous);
  delete state.sessionTotals[sessionId]; // re-insert at the end, so the oldest-first trim below never drops a live session
  state.sessionTotals[sessionId] = Math.max(previous, sessionTotalUsd);
  const keys = Object.keys(state.sessionTotals);
  for (const key of keys.slice(0, Math.max(0, keys.length - 100))) delete state.sessionTotals[key];
  addSpend(delta);
  return delta;
}

export function recordRun(run: RunRecord) {
  state.runs = [...state.runs, run].slice(-200);
  save();
}

/** Today's spend per bot, from the run history. */
export function spendByBotToday(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of state.runs) {
    if (new Date(r.at).toLocaleDateString("en-CA", { timeZone: config.timezone }) !== today()) continue;
    out[r.bot] = (out[r.bot] ?? 0) + r.costUsd;
  }
  return out;
}

// The action log is kept to about 5 MB: when it grows past that, it moves to audit.old.jsonl (one older copy).
const AUDIT_MAX_BYTES = 5_000_000;
let auditChecks = 0;

export function audit(entry: Record<string, unknown>) {
  try {
    if (++auditChecks % 200 === 1 && fs.existsSync(AUDIT_FILE) && fs.statSync(AUDIT_FILE).size > AUDIT_MAX_BYTES) {
      fs.renameSync(AUDIT_FILE, path.join(config.dataDir, "audit.old.jsonl"));
    }
    fs.appendFileSync(AUDIT_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
  } catch (error) {
    console.error("Couldn't write the action log:", (error as Error).message);
  }
}

/** The last `count` entries, reading only the end of the file. */
export function recentAudit(count: number): Record<string, unknown>[] {
  try {
    const size = fs.statSync(AUDIT_FILE).size;
    const length = Math.min(size, 512_000);
    const buf = Buffer.alloc(length);
    const fd = fs.openSync(AUDIT_FILE, "r");
    try {
      fs.readSync(fd, buf, 0, length, size - length);
    } finally {
      fs.closeSync(fd);
    }
    const lines = buf.toString("utf8").split("\n").filter(Boolean);
    if (length < size) lines.shift(); // probably cut in the middle
    return lines.slice(-count).flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}
