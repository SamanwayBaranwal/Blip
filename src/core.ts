import fs from "node:fs";
import path from "node:path";
import { startAgent, type AgentHandle } from "./agent.js";
import { activeBot, appendMemory, createBot, findBot, getBot, primaryBot } from "./bots.js";
import { pendingCards } from "./cards.js";
import { config } from "./config.js";
import { hooks } from "./hooks.js";
import { addMessage, findMessage, stateChanged, updateMessage, type Msg, type RunView } from "./hub.js";
import { post } from "./outbox.js";
import { scheduleInternal, setRoutineRunner } from "./routines.js";
import { recordRun, save, spentToday, state, type BotProfile } from "./store.js";
import { BOT_TEMPLATES, ROUTINE_TEMPLATES } from "./templates.js";

type Content = Parameters<typeof startAgent>[0]["prompt"];

// ---------------------------------------------------------------- task queue
// One task at a time: every bot shares this Mac, its screen and one browser profile.
type Running = { label: string; bot: BotProfile; abort: AbortController; chat: boolean; handle?: AgentHandle; step: string; startedAt: number };
let queue: Promise<void> = Promise.resolve();
let queuedTasks: { botId: string; label: string }[] = [];
let current: Running | undefined;

export const localNow = () =>
  new Date().toLocaleString("en-US", { timeZone: config.timezone, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function duration(ms: number) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ""}`;
}

const NOTHING_NEW = /^\s*(NOTHING NEW|NOTHING)\.?\s*$/i;

export function runtime() {
  return {
    current: current ? { botId: current.bot.id, label: current.label, step: current.step, startedAt: current.startedAt } : null,
    queued: queuedTasks,
    pendingCards: pendingCards(),
  };
}

export function stopCurrent(botId?: string) {
  if (!current || (botId && current.bot.id !== botId)) return false;
  current.abort.abort();
  return true;
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
  opts: { label: string; chat: boolean; readOnly?: boolean; quiet?: boolean; voice?: boolean; header?: string },
) {
  const ticket = { botId: b.id, label: opts.label };
  queuedTasks.push(ticket);
  stateChanged();
  queue = queue.then(async () => {
    queuedTasks = queuedTasks.filter((t) => t !== ticket);
    // Over budget: background work skips quietly (you already got the 🛑 warning); chats still get told.
    if (config.anthropicKey && !opts.chat && spentToday() >= config.dailyBudgetUsd) return stateChanged();
    const abort = new AbortController();
    const running: Running = { label: opts.label, bot: b, abort, chat: opts.chat, step: "Starting…", startedAt: Date.now() };
    current = running;
    stateChanged();

    // The live progress block in the chat (Grok Bot's steps panel).
    const runView: RunView = { label: opts.header ?? opts.label, status: "running", startedAt: running.startedAt, steps: [], plan: [] };
    const runMsg: Msg | undefined = opts.quiet ? undefined : addMessage({ botId: b.id, role: "bot", kind: "run", run: runView });
    let lastActivity = Date.now();
    const touch = (fn: (r: RunView) => void) => {
      if (runMsg) updateMessage(b.id, runMsg.id, (m) => fn(m.run!));
    };
    const watchdog = setInterval(() => {
      const waiting = pendingCards() > 0;
      if (waiting) lastActivity = Date.now();
      touch((r) => {
        r.status = waiting ? "waiting" : "running";
        if (!waiting && Date.now() - lastActivity > 10 * 60_000 && !r.stalled) {
          r.stalled = true; // Dots/Muse users found jobs that silently stalled: say so
          post(b.id, `${b.name} hasn't made progress for 10 minutes (last step: ${running.step}). It may be stuck — you can stop it.`, { role: "system" });
        }
      });
    }, 5_000);

    let status: RunView["status"] = "done";
    let lastReply = "";
    let costUsd = 0;
    try {
      running.handle = startAgent({
        bot: b,
        prompt,
        request,
        resume: opts.chat ? b.sessionId : undefined,
        readOnly: opts.readOnly,
        abort,
        onStep: (s) => {
          running.step = s;
          lastActivity = Date.now();
          touch((r) => {
            r.steps = [...r.steps, { at: Date.now(), text: s }].slice(-80);
            r.stalled = false;
          });
          stateChanged();
        },
        onPlan: (todos) => {
          lastActivity = Date.now();
          touch((r) => (r.plan = todos));
        },
        onReply: async (text, isError, costSoFar) => {
          lastReply = text;
          if (opts.readOnly) return; // proactive runs speak only through suggestion cards
          if (!opts.chat && NOTHING_NEW.test(text)) {
            status = "nothing new"; // routines that found nothing stay silent instead of pinging you
            return;
          }
          post(b.id, text, {
            meta: {
              header: opts.header,
              costUsd: isError ? undefined : costSoFar,
              seconds: Math.round((Date.now() - running.startedAt) / 1000),
              voice: opts.voice,
              error: isError,
            },
          });
        },
      });
      const result = await running.handle.done;
      costUsd = result.costUsd;
      if (result.failed && status === "done") status = abort.signal.aborted ? "stopped" : "failed";
      if (opts.chat && result.sessionId) b.sessionId = result.sessionId;
      save();
    } catch (error) {
      status = "failed";
      lastReply = (error as Error).message;
      console.error(`Task "${opts.label}" failed:`, error);
      post(b.id, `${b.name} hit an error: ${(error as Error).message}`, { role: "system", meta: { error: true } });
    } finally {
      clearInterval(watchdog);
      current = undefined;
      touch((r) => {
        r.status = status;
        r.endedAt = Date.now();
        r.costUsd = costUsd;
      });
      recordRun({
        at: new Date(running.startedAt).toISOString(),
        bot: b.name,
        label: opts.label,
        status,
        costUsd,
        seconds: Math.round((Date.now() - running.startedAt) / 1000),
        summary: lastReply.replace(/\s+/g, " ").slice(0, 160),
      });
      stateChanged();
      await budgetCheck(b.id).catch(() => {});
      // Long conversations get slower and pricier every message (a top Grok Bot complaint): nudge a fresh start.
      if (opts.chat && (b.contextTokens ?? 0) > 400_000) {
        post(b.id, `This conversation is getting long (${Math.round((b.contextTokens ?? 0) / 1000)}k tokens), so every message costs more. Start a new chat to reset it — memory is kept.`, { role: "system", push: false });
      }
    }
  });
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
  if (current?.chat && current.bot.id === target.id && !files.length && current.handle?.steer(fullText)) return;

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
  const day = new Date().toLocaleDateString("en-CA", { timeZone: config.timezone });
  const replied = (msg.text ?? "").replace(/\s+/g, " ").slice(0, 80);
  appendMemory(b, up ? `- Feedback: 👍 liked "${replied}…" (${day})` : `- Feedback: 👎 on "${replied}…"${note ? ` — ${note.replace(/\s+/g, " ")}` : ""} (${day})`);
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
  const b = getBot(routine.botId) ?? primaryBot();
  runTask(
    b,
    `[Scheduled routine "${routine.name}" — now is ${localNow()}. The user isn't watching live. Finish it and report the result briefly. If it's a check and there's nothing worth telling them, reply with just: NOTHING NEW]\n\n${routine.prompt}`,
    routine.prompt,
    { label: routine.name, chat: false, header: `Routine · ${routine.name}` },
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
  if (!state.settings.proactive || current || queuedTasks.length) return;
  const b = primaryBot();
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
    { label: "Proactive check-in", chat: false, readOnly: true, quiet: true },
  );
});
