import fs from "node:fs";
import path from "node:path";
import { startAgent, type AgentHandle } from "./agent.js";
import { activeBot, appendMemory, createBot, findBot, getBot, primaryBot } from "./bots.js";
import { pendingCards } from "./cards.js";
import { computerHolder, releaseComputer } from "./computer.js";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { hooks } from "./hooks.js";
import { addMessage, findMessage, stateChanged, updateMessage, type Msg, type RunView } from "./hub.js";
import { post } from "./outbox.js";
import { scheduleInternal, setRoutineRunner } from "./routines.js";
import { recordRun, save, spentToday, state, type BotProfile } from "./store.js";
import { BOT_TEMPLATES, ROUTINE_TEMPLATES } from "./templates.js";

type Content = Parameters<typeof startAgent>[0]["prompt"];

// ---------------------------------------------------------------- task queue
// Bots work in parallel: each bot does one task at a time, and up to MAX_PARALLEL bots run at once.
// Only the shared browser and screen are taken in turns (see computer.ts).
type Running = { label: string; bot: BotProfile; abort: AbortController; chat: boolean; handle?: AgentHandle; step: string; startedAt: number; model: string; routineId?: string };
type Ticket = { botId: string; label: string; routineId?: string; start: () => Promise<void> };
const MAX_PARALLEL = Math.max(1, Number(process.env.MAX_PARALLEL || 3));
const running = new Map<string, Running>(); // by bot id
const waiting: Ticket[] = [];

function pump() {
  for (const t of [...waiting]) {
    if (running.size >= MAX_PARALLEL) break;
    if (running.has(t.botId)) continue;
    waiting.splice(waiting.indexOf(t), 1);
    void t
      .start()
      .catch((error) => console.error(`Task "${t.label}" couldn't start:`, error))
      .finally(pump);
  }
  stateChanged();
}

// ---------------------------------------------------------------- smart model choice
// "Auto" (the default) answers quick chat on a fast model and gives real jobs to the strongest one.
const FAST_MODEL = process.env.FAST_MODEL?.trim() || "claude-sonnet-5-5";
const BIG_TASK =
  /\b(research|investigate|compare|analy[sz]e|build|create|make|write|draft|design|code|program|fix|debug|deploy|install|set ?up|configure|book|reserve|buy|order|purchase|apply|fill|sign ?up|register|organi[sz]e|plan|summari[sz]e|report|spreadsheet|website|automate|negotiate|email|send|browse|find|download|upload|edit|update|clean ?up|move|rename|delete|schedule|cancel|refund|track|log ?in|post)\b/i;

export function chooseModel(b: BotProfile, text: string, opts: { chat: boolean; readOnly?: boolean }) {
  if (b.model) return b.model; // the user picked a model for this bot
  if (opts.readOnly) return FAST_MODEL; // proactive look-arounds
  if (!opts.chat) return config.model; // routines do real work
  const bigJob = text.length > 220 || /\[The user attached a file/.test(text) || BIG_TASK.test(text);
  return bigJob ? config.model : FAST_MODEL;
}
const modelName = (id: string) => (/opus/.test(id) ? "Opus" : /sonnet/.test(id) ? "Sonnet" : /haiku/.test(id) ? "Haiku" : /fable/.test(id) ? "Fable" : id);

// Time limits, so nothing runs away (a stuck background check once ran for 75 minutes).
const LIMIT_MIN = { chat: Number(process.env.TASK_LIMIT_MIN || 30), routine: 15, proactive: 5 };

export const localNow = () =>
  new Date().toLocaleString("en-US", { timeZone: config.timezone, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function duration(ms: number) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ""}`;
}

const NOTHING_NEW = /^\s*(NOTHING NEW|NOTHING)\.?\s*$/i;

export function runtime() {
  const list = [...running.values()].map((r) => ({ botId: r.bot.id, label: r.label, step: r.step, startedAt: r.startedAt, model: modelName(r.model) }));
  return {
    current: list[0] ?? null,
    running: list,
    queued: waiting.map(({ botId, label }) => ({ botId, label })),
    pendingCards: pendingCards(),
    computer: computerHolder()?.botName ?? null,
  };
}

export const isRunning = (botId: string) => running.has(botId);

/** Stops one bot's task (and anything queued for it), or every task. */
export function stopCurrent(botId?: string) {
  const targets = botId ? [running.get(botId)].filter((r): r is Running => !!r) : [...running.values()];
  for (const r of targets) r.abort.abort();
  const before = waiting.length;
  for (const t of [...waiting]) if (!botId || t.botId === botId) waiting.splice(waiting.indexOf(t), 1);
  if (waiting.length !== before) stateChanged();
  return targets.length > 0 || waiting.length !== before;
}

// New chat bumps a bot's generation, so a task that was still finishing can't put the old conversation back.
const chatGeneration = new Map<string, number>();
export function freshChat(b: BotProfile) {
  chatGeneration.set(b.id, (chatGeneration.get(b.id) ?? 0) + 1);
  b.sessionId = undefined;
  b.contextTokens = 0;
}

/** Pushes a warning the first time today's spend crosses 50%, 80% and 100% of the daily budget. */
async function budgetCheck(botId: string) {
  if (!config.anthropicKey) return; // on the Claude plan, costs are estimates, not charges
  const pct = (spentToday() / config.dailyBudgetUsd) * 100;
  const level = [100, 80, 50].find((l) => pct >= l) ?? 0;
  const day = new Date().toLocaleDateString("en-CA", { timeZone: config.timezone });
  if (state.budgetWarned.day !== day) state.budgetWarned = { day, level: 0 };
  if (level <= state.budgetWarned.level) return;
  state.budgetWarned.level = level;
  save();
  post(
    botId,
    level >= 100
      ? `Today's budget ($${config.dailyBudgetUsd}) is used up. Bots pause until tomorrow. Raise DAILY_BUDGET_USD in .env to continue.`
      : `${level}% of today's $${config.dailyBudgetUsd} budget used ($${spentToday().toFixed(2)}). Settings shows which bot spent what; switching a bot to Sonnet roughly halves its cost.`,
    { role: "system" },
  );
}

export function runTask(
  b: BotProfile,
  prompt: Content,
  request: string,
  opts: { label: string; chat: boolean; readOnly?: boolean; quiet?: boolean; voice?: boolean; header?: string; routineId?: string },
) {
  // A routine that's still running or waiting its turn isn't queued again (they'd pile up behind a long task).
  if (opts.routineId && ([...running.values()].some((r) => r.routineId === opts.routineId) || waiting.some((t) => t.routineId === opts.routineId))) return;
  waiting.push({ botId: b.id, label: opts.label, routineId: opts.routineId, start: () => execute(b, prompt, request, opts) });
  pump();
}

async function execute(
  b: BotProfile,
  prompt: Content,
  request: string,
  opts: { label: string; chat: boolean; readOnly?: boolean; quiet?: boolean; voice?: boolean; header?: string; routineId?: string },
) {
  // Over budget: background work skips quietly (you already got the warning); chats still get told.
  if (config.anthropicKey && !opts.chat && spentToday() >= config.dailyBudgetUsd) return;
  const abort = new AbortController();
  const runId = randomUUID();
  const generation = chatGeneration.get(b.id) ?? 0;
  const contextBefore = b.contextTokens ?? 0;
  const model = chooseModel(b, request, opts);
  const r: Running = { label: opts.label, bot: b, abort, chat: opts.chat, step: "Starting…", startedAt: Date.now(), model, routineId: opts.routineId };
  running.set(b.id, r);
  stateChanged();

  // The live progress block in the chat (Grok Bot's steps panel).
  const runView: RunView = { label: opts.header ?? opts.label, status: "running", startedAt: r.startedAt, steps: [], plan: [], model: modelName(model) };
  const runMsg: Msg | undefined = opts.quiet ? undefined : addMessage({ botId: b.id, role: "bot", kind: "run", run: runView });
  let lastActivity = Date.now();
  const touch = (fn: (v: RunView) => void) => {
    if (runMsg) updateMessage(b.id, runMsg.id, (m) => fn(m.run!));
  };
  let waitingForComputer = false;
  const step = (text: string) => {
    waitingForComputer = false;
    r.step = text;
    lastActivity = Date.now();
    touch((v) => {
      v.steps = [...v.steps, { at: Date.now(), text }].slice(-80);
      v.stalled = false;
    });
    stateChanged();
  };
  // Only active working time counts toward the limit: waiting for your approval or for another bot to
  // finish with the computer doesn't.
  const limitMin = opts.readOnly ? LIMIT_MIN.proactive : opts.chat ? LIMIT_MIN.chat : LIMIT_MIN.routine;
  let activeMs = 0;
  let limitHit = false;
  const watchdog = setInterval(() => {
    const waitingForUser = pendingCards(b.id) > 0;
    if (waitingForUser || waitingForComputer) lastActivity = Date.now();
    else activeMs += 5_000;
    if (!limitHit && activeMs >= limitMin * 60_000) {
      limitHit = true;
      abort.abort();
    }
    touch((v) => {
      v.status = waitingForUser ? "waiting" : "running";
      if (!waitingForUser && Date.now() - lastActivity > 10 * 60_000 && !v.stalled) {
        v.stalled = true; // Dots/Muse users found jobs that silently stalled: say so
        post(b.id, `${b.name} hasn't made progress for 10 minutes (last step: ${r.step}). It may be stuck — you can stop it.`, { role: "system" });
      }
    });
  }, 5_000);

  let status: RunView["status"] = "done";
  let lastReply = "";
  let costUsd = 0;
  try {
    r.handle = startAgent({
      bot: b,
      prompt,
      request,
      model,
      runId,
      resume: opts.chat ? b.sessionId : undefined,
      readOnly: opts.readOnly,
      keepWarm: opts.chat && !opts.readOnly,
      abort,
      onStep: step,
      onPlan: (todos) => {
        lastActivity = Date.now();
        touch((v) => (v.plan = todos));
      },
      onWait: (holder) => {
        if (holder === null) return step("Got the computer");
        step(`Waiting for the computer: ${holder} is using it`);
        waitingForComputer = true;
      },
      onReply: async (text, isError, costSoFar) => {
        lastReply = text;
        if (opts.readOnly) return; // proactive runs speak only through suggestion cards
        if (limitHit) return; // the time-limit note below says what happened
        if (!opts.chat && NOTHING_NEW.test(text)) {
          status = "nothing new"; // routines that found nothing stay silent instead of pinging you
          return;
        }
        post(b.id, text, {
          meta: {
            header: opts.header,
            costUsd: isError ? undefined : costSoFar,
            seconds: Math.round((Date.now() - r.startedAt) / 1000),
            voice: opts.voice,
            error: isError,
          },
        });
      },
    });
    const result = await r.handle.done;
    costUsd = result.costUsd;
    if (abort.signal.aborted) status = "stopped";
    else if (result.failed && status === "done") status = "failed";
    if (opts.chat && result.sessionId && generation === (chatGeneration.get(b.id) ?? 0)) b.sessionId = result.sessionId;
    save();
  } catch (error) {
    status = "failed";
    lastReply = (error as Error).message;
    console.error(`Task "${opts.label}" failed:`, error);
    post(b.id, `${b.name} hit an error: ${(error as Error).message}`, { role: "system", meta: { error: true } });
  } finally {
    clearInterval(watchdog);
    running.delete(b.id);
    await releaseComputer(runId).catch(() => {});
    if (limitHit && !opts.readOnly) {
      post(
        b.id,
        opts.chat
          ? `${b.name} stopped after ${limitMin} minutes, the time limit for a task. Say "continue" to pick up where it left off.`
          : `"${opts.label}" stopped after ${limitMin} minutes, the time limit for a routine. If it needs longer, ask ${b.name} to split it into smaller steps.`,
        { role: "system" },
      );
    }
    touch((v) => {
      v.status = status;
      v.endedAt = Date.now();
      v.costUsd = costUsd;
    });
    recordRun({
      at: new Date(r.startedAt).toISOString(),
      bot: b.name,
      label: opts.label,
      status,
      costUsd,
      seconds: Math.round((Date.now() - r.startedAt) / 1000),
      summary: lastReply.replace(/\s+/g, " ").slice(0, 160),
    });
    stateChanged();
    await budgetCheck(b.id).catch(() => {});
    // Long conversations get slower and pricier every message (a top Grok Bot complaint): nudge a fresh start.
    if (opts.chat && (b.contextTokens ?? 0) > 400_000 && contextBefore <= 400_000) {
      post(b.id, `This conversation is getting long (${Math.round((b.contextTokens ?? 0) / 1000)}k tokens), so every message costs more. Start a new chat to reset it — memory is kept.`, { role: "system", push: false });
    }
  }
}

// ---------------------------------------------------------------- user messages
export type Attachment = { path: string; mediaType?: string };

/** A message from the user (app or Telegram). Steers the bot if it's mid-task, otherwise queues a task. */
export function handleUserMessage(text: string, opts: { botId?: string; voice?: boolean; attachments?: Attachment[]; source?: "app" | "telegram" } = {}) {
  let target = getBot(opts.botId) ?? activeBot();
  let body = text.trim();
  const mention = /^@(\S+)\s+([\s\S]+)$/.exec(body);
  const mentioned = mention ? findBot(mention[1]!) : undefined;
  if (mentioned) {
    target = mentioned;
    body = mention![2]!;
  }
  const files = (opts.attachments ?? []).map((a) => a.path);
  addMessage({ botId: target.id, role: "user", kind: "text", text: body, files: files.map((f) => path.relative(config.workspace, f)), meta: { voice: opts.voice } });

  const fileNotes = files.map((f) => `[The user attached a file, saved at: ${f}]`).join("\n");
  const fullText = [body, fileNotes].filter(Boolean).join("\n\n") || "(see attachment)";

  // Steering: a message for the bot that's mid-task goes straight into that task.
  const cur = running.get(target.id);
  if (cur?.chat && !files.length && cur.handle?.steer(fullText)) return;

  const images = (opts.attachments ?? []).filter((a) => a.mediaType && fs.existsSync(a.path) && fs.statSync(a.path).size < 4_500_000);
  const prompt: Content = images.length
    ? [
        { type: "text", text: fullText },
        ...images.map((a) => ({ type: "image" as const, source: { type: "base64" as const, media_type: a.mediaType as "image/png" | "image/jpeg", data: fs.readFileSync(a.path).toString("base64") } })),
      ]
    : fullText;
  runTask(target, prompt, fullText, { label: body.slice(0, 60) || "attachment", chat: true, voice: opts.voice || state.settings.voiceReplies });
}

hooks.startTask = (botId, prompt, label) => {
  const b = getBot(botId) ?? primaryBot();
  addMessage({ botId: b.id, role: "system", kind: "text", text: `${label ?? "Task"}` });
  runTask(b, prompt, prompt, { label: label ?? "task", chat: true });
};

// ---------------------------------------------------------------- feedback, templates
export function giveFeedback(botId: string, msgId: string, up: boolean, note?: string) {
  const b = getBot(botId);
  const msg = findMessage(botId, msgId);
  if (!b || !msg) return false;
  if (msg.meta?.feedback === (up ? "up" : "down") && !note) return true; // already recorded; don't repeat it in memory
  const day = new Date().toLocaleDateString("en-CA", { timeZone: config.timezone });
  const replied = (msg.text ?? "").replace(/\s+/g, " ").slice(0, 80);
  appendMemory(b, up ? `- Feedback: liked "${replied}…" (${day})` : `- Feedback: disliked "${replied}…"${note ? ` — ${note.replace(/\s+/g, " ")}` : ""} (${day})`);
  updateMessage(botId, msgId, (m) => (m.meta = { ...m.meta, feedback: up ? "up" : "down" }));
  return true;
}

export function setupRoutineTemplate(key: string, botId?: string) {
  const t = ROUTINE_TEMPLATES[key];
  if (!t) return false;
  handleUserMessage(
    `Set up this routine for me: "${t.label}", ${t.schedule}.\nWhat it should do each time: ${t.prompt}\n\nFirst ask me anything you need (which email or calendar, topics, preferences — and check you can access them in your browser; if I need to sign in, use request_takeover). Confirm the schedule with me, then save it with add_routine and offer a test run.`,
    { botId },
  );
  return true;
}

export function createBotFromTemplate(key: string) {
  const t = BOT_TEMPLATES[key];
  if (!t) throw new Error("Unknown template");
  const nb = createBot(findBot(t.name) ? `${t.name} ${state.bots.length + 1}` : t.name, t.job, t.style);
  if (t.look) nb.look = { ...t.look };
  post(nb.id, `Hi! I'm ${nb.name}. ${nb.job}\n\nTell me a bit about what you need and I'll get going.`, { push: false });
  stateChanged();
  return nb;
}

export function welcome() {
  const b = activeBot();
  post(
    b.id,
    `Hi, I'm ${b.name} — your own AI agent, running on your MacBook.\n\nI can browse the web, use your Mac's apps, handle email and errands, run routines on a schedule, and keep working while you sleep. I always check with you before sending, buying or deleting anything.\n\nTell me a bit about yourself (name, work, what eats your time), or tap one of the suggestions below.`,
    { push: false },
  );
}

// ---------------------------------------------------------------- routines and proactive check-ins
setRoutineRunner((routine) => {
  const b = getBot(routine.botId);
  if (!b) return; // its bot was deleted
  runTask(
    b,
    `[Scheduled routine "${routine.name}" — now is ${localNow()}. The user isn't watching live. Finish it and report the result briefly. If it's a check and there's nothing worth telling them, reply with just: NOTHING NEW]\n\n${routine.prompt}`,
    routine.prompt,
    { label: routine.name, chat: false, header: `Routine · ${routine.name}`, routineId: routine.id },
  );
});

export function testRoutine(id: string) {
  const routine = state.routines.find((r) => r.id === id);
  if (!routine) return false;
  const b = getBot(routine.botId) ?? primaryBot();
  runTask(b, `[Test run of routine "${routine.name}" requested by the user, now ${localNow()}. It does real work.]\n\n${routine.prompt}`, routine.prompt, {
    label: `Test · ${routine.name}`,
    chat: false,
    header: `Test run · ${routine.name}`,
  });
  return true;
}

// Proactive check-ins (Dots' proactive research / Grok's primary bot offering work / Muse's suggestions).
scheduleInternal(config.proactiveSchedule, () => {
  const b = primaryBot();
  if (!state.settings.proactive || running.has(b.id) || waiting.some((t) => t.botId === b.id)) return;
  const recent = state.recentSuggestions.slice(-15);
  const dismissed = state.dismissedSuggestions.slice(-15);
  runTask(
    b,
    `[Proactive check-in at ${localNow()} — the user didn't ask for anything. This run is READ-ONLY.]
Look for things slipping through the cracks that the user would thank you for catching. If they're signed in to email or a calendar in your browser, look there (read only):
• messages where someone has been waiting on them for 2+ days
• bills, invoices or renewals due soon; unsent invoices
• cancelled or changed bookings, double-bookings, travel problems
• deadlines and appointments they may not be ready for
• unusual sign-in or security alerts
Also use your memory, the shared notes, their routines (list_routines) and quick web research on what they care about.
For at most 2 specific, high-value findings, call suggest with a concrete plan. Never suggest "connect more apps" or generic tips. If nothing clearly matters, suggest nothing — silence is better than noise.
${recent.length ? `Already suggested recently (don't repeat): ${recent.join(" | ")}` : ""}
${dismissed.length ? `The user marked these as not useful — avoid similar ideas: ${dismissed.join(" | ")}` : ""}
Finish with a one-line note of what you checked.`,
    "Proactive read-only check-in: look around and suggest useful tasks.",
    // Shown in the chat as a quiet, collapsible line (no notification), so it's always clear what Blip looked at.
    { label: "Proactive check-in", chat: false, readOnly: true, header: "Proactive check-in · read-only" },
  );
});
