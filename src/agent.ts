import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { query, type McpServerConfig, type Options, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { browserProfileFor, personaFor } from "./bots.js";
import { config } from "./config.js";
import { setEngines } from "./computer.js";
import { makeCanUseTool, makeSecretGate, type RunContext } from "./permissions.js";
import { scrub } from "./secrets.js";
import { finishReplay, replaySetup } from "./replay.js";
import { recordCost, spentToday, state, type BotProfile } from "./store.js";
import { createBlipServer } from "./tools.js";

type Content = SDKUserMessage["message"]["content"];
export type Todo = { content: string; status: string; activeForm?: string };

/** Feeds user messages into a running agent; supports steering mid-task. */
class Inbox {
  private queue: SDKUserMessage[] = [];
  private wake?: () => void;
  closed = false;

  push(message: SDKUserMessage) {
    this.queue.push(message);
    this.wake?.();
  }
  close() {
    this.closed = true;
    this.wake?.();
  }
  async *messages(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      while (this.queue.length) yield this.queue.shift()!;
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = undefined;
    }
  }
}

export type AgentHandle = {
  /** Send a new message into the running task. Returns false if the task already finished. */
  steer: (text: string) => boolean;
  done: Promise<{ sessionId?: string; failed: boolean; costUsd: number; tools?: string[] }>;
};

export const MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
  fable: "claude-fable-5-1",
};

function connectorServers(): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, c] of Object.entries(state.connectors)) {
    if (c.access === "off") continue;
    servers[name] = c.type === "http" ? { type: "http", url: c.url!, headers: c.headers } : { type: "stdio", command: c.command!, args: c.args, env: c.env };
  }
  return servers;
}

type TurnResult = { sessionId?: string; failed: boolean; costUsd: number; tools?: string[] };
type Turn = {
  onStep?: (step: string) => void;
  onPartial?: (text: string) => void;
  onPlan?: (todos: Todo[]) => void;
  onReply: (text: string, isError: boolean, costSoFarUsd: number) => Promise<void>;
  cost: number;
  failed: boolean;
  lastText: string;
  tools: Set<string>; // every tool the bot used in this task (for the double-check)
  runMsgId?: string; // the task's progress block in the chat (a replay gets linked from it)
  resolve: (r: TurnResult) => void;
  reject: (e: unknown) => void;
  userAbort: AbortSignal;
};

// Starting the agent engine (and its browser tools) takes several seconds, so after a chat reply a bot's
// session stays alive for a while and its next message goes straight in. Bots work in parallel, so each bot
// can have its own warm engine; at most MAX_ENGINES stay alive, and the least recently used idle one closes first.
const WARM_MS = 10 * 60_000;
const MAX_ENGINES = Math.max(1, Number(process.env.MAX_PARALLEL || 3));

class Session {
  readonly inbox = new Inbox();
  readonly abort = new AbortController();
  readonly outstanding: string[] = [];
  readonly ctx: RunContext;
  readonly exited: Promise<void>;
  private markExited!: () => void;
  private q?: Query;
  model: string;
  sessionId?: string;
  turn?: Turn;
  alive = true;
  /** Close as soon as the current task finishes (its settings changed, or New chat). */
  retiring = false;
  private turnSent = false;
  private partial = ""; // the reply text being written right now (streamed to the app)
  private readonly replayTargets: { botId: string; msgId: string }[] = []; // tasks that used the browser
  lastUsed = Date.now();
  private idleTimer?: NodeJS.Timeout;

  constructor(
    readonly bot: BotProfile,
    readonly keepWarm: boolean,
    readonly readOnly: boolean,
    resume: string | undefined,
    remainingBudget: number | undefined,
    model: string,
    readonly userStarted: boolean,
    readonly handoff = false,
  ) {
    this.model = model;
    this.sessionId = resume;
    this.exited = new Promise((r) => (this.markExited = r));
    this.ctx = { bot, request: "", readOnly, taskAllows: new Set<string>(), runId: "", handoff };
    live.add(this);
    void this.exited.then(() => live.delete(this));
    // The agent's terminal never sees the Telegram token, and never inherits a parent Claude Code session's connection.
    const env: Record<string, string | undefined> = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== "TELEGRAM_BOT_TOKEN" && !/^CLAUDE|^ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)$/.test(key)),
    );
    if (config.anthropicKey) env.ANTHROPIC_API_KEY = config.anthropicKey;
    const secretGate = makeSecretGate(this.ctx);
    // Work replay: the browser records this session; when it ends, the clip is linked from the tasks that browsed.
    const replay = replaySetup(`${bot.id}-${Date.now()}`);
    void this.exited.then(() => finishReplay(replay.videoDir, replay.configFile, this.replayTargets));
    const options: Options = {
      model,
      effort: config.effort,
      cwd: config.workspace,
      permissionMode: "default",
      includePartialMessages: true, // stream the reply to the app as it's written
      settingSources: ["project"], // loads workspace/CLAUDE.md and skills; ignores this Mac's personal Claude Code settings
      systemPrompt: { type: "preset", preset: "claude_code", append: personaFor(bot, { readOnly }) },
      // Teammates are real bots now: they're reached with hand_off (visible in the chat, with their own memory).
      resume,
      abortController: this.abort,
      canUseTool: makeCanUseTool(this.ctx),
      maxBudgetUsd: remainingBudget,
      env,
      mcpServers: {
        ...connectorServers(),
        blip: createBlipServer(bot, { background: !userStarted, context: () => this.ctx }), // chats the user starts may ask macOS; background runs never
        browser: {
          type: "stdio",
          command: process.execPath,
          args: [
            config.playwrightCli, "--browser", "chrome", "--user-data-dir", browserProfileFor(handoff ? { ...bot, ownBrowser: true } : bot), // hand-offs never wait for the shared browser "--output-dir", `${config.workspace}/browser`,
            "--config", replay.configFile,
            // Background work (check-ins, routines) uses an invisible browser so windows never pop up while you
            // use the Mac; chats you start use a visible one you can watch. BLIP_BROWSER_HEADLESS hides it always.
            ...(!keepWarm || process.env.BLIP_BROWSER_HEADLESS ? ["--headless"] : []),
          ],
        },
      },
      // Anything a tool sends back that contains a saved secret is scrubbed before the bot sees it.
      hooks: {
        // {{secret:name}} placeholders are approved and filled in before any tool runs (see makeSecretGate).
        PreToolUse: [
          {
            timeout: 4 * 3600, // the approval card may wait a while
            hooks: [
              async (hook, toolUseID, { signal }) => {
                if (hook.hook_event_name !== "PreToolUse") return {};
                const result = await secretGate(hook.tool_name, (hook.tool_input ?? {}) as Record<string, unknown>, signal, toolUseID);
                if (!result) return {};
                return {
                  hookSpecificOutput:
                    result.behavior === "allow"
                      ? { hookEventName: "PreToolUse" as const, permissionDecision: "allow" as const, updatedInput: result.updatedInput }
                      : { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: result.message },
                };
              },
            ],
          },
        ],
        PostToolUse: [
          {
            hooks: [
              async (hook) => {
                const clean = "tool_response" in hook ? scrub(hook.tool_response) : undefined;
                return clean === undefined ? {} : { hookSpecificOutput: { hookEventName: "PostToolUse" as const, updatedToolOutput: clean } };
              },
            ],
          },
        ],
      },
      stderr: (data) => console.error(`[${bot.name}]`, data.trimEnd()),
    };
    void this.pump(options);
  }

  get busy() {
    return !!this.turn;
  }

  /** Starts one exchange: the user's message, then everything until the agent has answered it. */
  async runTurn(
    prompt: Content,
    request: string,
    handlers: Pick<Turn, "onStep" | "onPlan" | "onReply" | "onPartial">,
    userAbort: AbortSignal,
    run: { runId: string; model: string; onWait?: (holder: string | null) => void; runMsgId?: string; threadId?: string },
  ): Promise<TurnResult> {
    clearTimeout(this.idleTimer);
    if (!this.alive) throw new Error("This bot's engine closed before it could start. Please send your message again.");
    this.lastUsed = Date.now();
    this.ctx.request = request;
    this.ctx.taskAllows = new Set<string>();
    this.ctx.runId = run.runId;
    this.ctx.onWait = run.onWait;
    this.ctx.threadId = run.threadId;
    this.turnSent = false;
    // The turn exists (so the session counts as busy and nothing closes it) before any waiting below.
    const result = new Promise<TurnResult>((resolve, reject) => {
      this.turn = { ...handlers, cost: 0, failed: false, lastText: "", tools: new Set(), runMsgId: run.runMsgId, resolve, reject, userAbort };
    });
    // Smart model choice: the same warm engine can switch models between messages.
    if (run.model !== this.model && this.q) {
      await this.q.setModel(run.model).catch((e) => console.error(`[${this.bot.name}] setModel failed:`, e));
      this.model = run.model;
    }
    if (userAbort.aborted) this.close(true);
    else if (!this.alive) {
      // Closed while switching models (and the engine hasn't already answered for this turn): say so.
      const turn = this.turn;
      this.turn = undefined;
      turn?.reject(new Error("This bot's engine closed before it could start. Please send your message again."));
    } else {
      userAbort.addEventListener("abort", () => this.close(true), { once: true });
      this.send(prompt);
    }
    return result;
  }

  send(content: Content, priority?: "next") {
    const uuid = randomUUID();
    this.turnSent = true;
    this.outstanding.push(uuid);
    this.inbox.push({ type: "user", uuid, message: { role: "user", content }, parent_tool_use_id: null, ...(priority ? { priority } : {}) });
  }

  /** Ends the session. Normally it shuts down gracefully (so the conversation is saved); Stop kills it at once. */
  close(force = false) {
    if (force && !this.abort.signal.aborted && !this.alive) this.abort.abort();
    if (!this.alive) return;
    this.alive = false;
    clearTimeout(this.idleTimer);
    this.inbox.close();
    if (force) this.abort.abort();
    if (sessions.get(this.bot.id) === this) sessions.delete(this.bot.id);
    // If the engine doesn't wind down on its own, stop it.
    setTimeout(() => this.abort.abort(), 8000).unref();
  }

  private finishTurn(result: TurnResult) {
    const turn = this.turn;
    this.turn = undefined;
    this.lastUsed = Date.now();
    turn?.resolve(result);
    if (this.keepWarm && this.alive && !this.retiring) this.idleTimer = setTimeout(() => this.close(), WARM_MS);
    else this.close();
  }

  private async pump(options: Options) {
    try {
      this.q = query({ prompt: this.inbox.messages(), options });
      for await (const message of this.q) {
        const turn = this.turn;
        if (message.type === "system" && message.subtype === "init") {
          this.sessionId = message.session_id;
        } else if (message.type === "stream_event") {
          // Only the bot's own words (not a teammate's), shown as they're written.
          if (!turn || message.parent_tool_use_id !== null) continue;
          const ev = message.event;
          if (ev.type === "message_start") this.partial = "";
          else if (ev.type === "content_block_start" && ev.content_block.type === "tool_use") {
            this.partial = ""; // text before a tool call was thinking aloud; the step timeline covers it
            turn.onPartial?.("");
          } else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
            this.partial += ev.delta.text;
            turn.onPartial?.(this.partial);
          }
        } else if (message.type === "assistant" && turn) {
          // The latest call's prompt size is how long the conversation is now (the result's usage adds up every step).
          const u = message.parent_tool_use_id === null ? message.message.usage : undefined;
          if (u) this.bot.contextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
          for (const block of message.message.content) {
            if (block.type === "text" && block.text.trim()) turn.lastText = block.text;
            if (block.type !== "tool_use") continue;
            const input = block.input as Record<string, unknown>;
            if (block.name === "TodoWrite" && Array.isArray(input.todos)) turn.onPlan?.(input.todos as Todo[]);
            else turn.onStep?.(stepLabel(block.name, input, message.parent_tool_use_id !== null));
            turn.tools.add(block.name);
            if (block.name.startsWith("mcp__browser__") && turn.runMsgId && !this.replayTargets.some((t) => t.msgId === turn.runMsgId)) {
              this.replayTargets.push({ botId: this.bot.id, msgId: turn.runMsgId });
            }
          }
        } else if (message.type === "result") {
          this.sessionId = message.session_id;
          const cost = recordCost(message.session_id, message.total_cost_usd);
          // Mark the user messages this result answered; when none are left, the turn is done.
          const covered = message.user_message_uuids ?? (message.user_message_uuid ? [message.user_message_uuid] : []);
          const before = this.outstanding.length;
          for (const uuid of covered) {
            const i = this.outstanding.indexOf(uuid);
            if (i >= 0) this.outstanding.splice(i, 1);
          }
          if (this.outstanding.length === before) this.outstanding.shift();
          if (!turn) continue;
          turn.cost += cost;
          if (message.subtype === "success") {
            turn.failed = message.is_error;
            await turn.onReply(message.result || turn.lastText, message.is_error, turn.cost);
          } else {
            turn.failed = true;
            const reason = message.subtype === "error_max_budget_usd" ? "it hit today's budget limit" : message.errors.join("; ") || message.subtype;
            await turn.onReply(`${turn.lastText}\n\nStopped early: ${reason}`.trim(), true, turn.cost);
          }
          turn.lastText = "";
          if (!this.outstanding.length) this.finishTurn({ sessionId: this.sessionId, failed: turn.failed, costUsd: turn.cost, tools: [...turn.tools] });
        }
      }
      // The engine ended on its own (closed while idle, or it exited after answering).
      const turn = this.turn;
      this.turn = undefined;
      this.alive = false;
      if (sessions.get(this.bot.id) === this) sessions.delete(this.bot.id);
      if (turn && (this.outstanding.length || !this.turnSent) && !turn.userAbort.aborted) {
        // It stopped before answering: say so instead of quietly marking the task done.
        await turn.onReply("The engine stopped before it could answer. Please send that again.", true, turn.cost).catch(() => {});
        turn.failed = true;
      }
      turn?.resolve({ sessionId: this.sessionId, failed: turn.failed || (turn.userAbort.aborted ?? false), costUsd: turn.cost });
    } catch (error) {
      const turn = this.turn;
      this.turn = undefined;
      this.alive = false;
      this.inbox.close();
      if (sessions.get(this.bot.id) === this) sessions.delete(this.bot.id);
      if (turn) {
        if (turn.userAbort.aborted) {
          await turn.onReply("Stopped.", true, turn.cost);
          turn.resolve({ sessionId: this.sessionId, failed: true, costUsd: turn.cost });
        } else if (!this.outstanding.length) {
          // After an error result the CLI exits non-zero; the user already got that error as a reply.
          console.error(`[${this.bot.name}] agent exited after replying:`, (error as Error).message);
          turn.resolve({ sessionId: this.sessionId, failed: true, costUsd: turn.cost });
        } else {
          turn.reject(error);
        }
      }
    } finally {
      this.markExited();
    }
  }
}

const sessions = new Map<string, Session>(); // warm engines that can take the next message, one per bot
const live = new Set<Session>(); // every engine process still running, warm or not (until it has exited)

/** Retires a bot's engine (or all engines), e.g. after its settings changed: idle ones close now, busy ones
 *  right after their current task, so changing a setting never kills work in progress. */
export function closeWarmSession(botId?: string) {
  for (const s of [...live]) {
    if (botId && s.bot.id !== botId) continue;
    if (sessions.get(s.bot.id) === s) sessions.delete(s.bot.id); // nothing new goes into it
    if (s.busy) s.retiring = true;
    else s.close();
  }
}

/** For the health check: how many engines are running and how many are mid-task. */
export function engineStats() {
  const all = [...live];
  return { running: all.length, warm: sessions.size, busy: all.filter((s) => s.busy).length };
}

/** Recover: stops every engine at once (tasks were already stopped) and waits for them to exit. */
export async function closeAllEngines() {
  const all = [...live];
  for (const s of all) s.close(true);
  await Promise.race([Promise.all(all.map((s) => s.exited)), new Promise((r) => setTimeout(r, 8000))]);
}

/** Closes a bot's engines and waits (briefly) until they have exited, so their Chrome window is gone. */
export async function closeEngineAndWait(botId: string, onlyWithBrowser = false) {
  const mine = [...live].filter((s) => s.bot.id === botId && (!onlyWithBrowser || s.ctx.usedComputer));
  if (!mine.length) return;
  for (const s of mine) s.close();
  const allExited = Promise.all(mine.map((s) => s.exited));
  const timedOut = await Promise.race([allExited.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), 6000))]);
  if (!timedOut) return;
  // Still running: stop it hard, so its Chrome lets go of the profile before the next one starts.
  for (const s of mine) s.close(true);
  await Promise.race([allExited, new Promise((r) => setTimeout(r, 4000))]);
}

setEngines({
  close: (botId) => closeEngineAndWait(botId, true),
  // Busy with a task, after having opened the browser: closing it would kill that task.
  busy: (botId) => [...live].some((s) => s.bot.id === botId && s.alive && s.busy && s.ctx.usedComputer),
});

/** The engine deletes conversations it hasn't touched in a while (30 days by default). Resuming one that's
 *  gone would fail every message, so check the transcript still exists first. */
function sessionExists(sessionId: string) {
  const root = path.join(os.homedir(), ".claude", "projects"); // the engine's env has no CLAUDE_CONFIG_DIR (stripped above)
  try {
    return fs.readdirSync(root).some((dir) => fs.existsSync(path.join(root, dir, `${sessionId}.jsonl`)));
  } catch {
    return true; // can't tell; let the engine try
  }
}

export function startAgent(params: {
  bot: BotProfile;
  prompt: Content;
  request: string; // plain-text version of what the user asked, for Auto Review
  model: string; // chosen per task (see chooseModel in core.ts)
  runId: string;
  resume?: string;
  readOnly?: boolean;
  keepWarm?: boolean; // chats keep their engine running between messages
  abort: AbortController;
  onStep?: (step: string) => void;
  onPlan?: (todos: Todo[]) => void;
  onWait?: (holder: string | null) => void;
  onReply: (text: string, isError: boolean, costSoFarUsd: number) => Promise<void>;
  onPartial?: (text: string) => void;
  runMsgId?: string;
  threadId?: string; // the chat it runs in (a group, or the bot's own)
  handoff?: boolean; // working for another bot: its own browser, no screen control
}): AgentHandle {
  let session: Session | undefined;
  const done = (async (): Promise<TurnResult> => {
    // With an API key, usage is billed per token and capped by the daily budget. Without one, the agent runs on
    // the Claude account signed in on this Mac (Claude plan limits apply; costs shown are estimates).
    const usingKey = !!config.anthropicKey;
    const remaining = config.dailyBudgetUsd - spentToday();
    if (usingKey && remaining <= 0) {
      await params.onReply(`Today's budget of $${config.dailyBudgetUsd} is used up. Raise DAILY_BUDGET_USD in .env or wait until tomorrow.`, true, 0);
      return { sessionId: params.resume, failed: true, costUsd: 0 };
    }
    const keepWarm = !!params.keepWarm && !params.readOnly && !usingKey; // a budgeted key session needs a fresh budget cap
    const existing = sessions.get(params.bot.id);
    const reusable = keepWarm && existing?.alive && !existing.busy && !existing.retiring && !existing.readOnly && existing.handoff === !!params.handoff && (!params.resume || existing.sessionId === params.resume);
    if (reusable) {
      session = existing!;
    } else {
      // Wait for the bot's old engine to exit first, so its browser releases the shared profile.
      if ([...live].some((s) => s.bot.id === params.bot.id)) await closeEngineAndWait(params.bot.id);
      // Keep the number of running engines in check: close the least recently used idle one.
      const idle = [...sessions.values()].filter((s) => !s.busy).sort((a, b) => a.lastUsed - b.lastUsed);
      if (sessions.size >= MAX_ENGINES && idle[0]) idle[0].close();
      let resume = params.resume;
      if (resume && !sessionExists(resume)) {
        console.error(`[${params.bot.name}] conversation ${resume} no longer exists; starting a fresh one (memory is kept)`);
        resume = undefined;
      }
      session = new Session(params.bot, keepWarm, !!params.readOnly, resume, usingKey ? remaining : undefined, params.model, !!params.keepWarm && !params.readOnly, !!params.handoff);
      if (keepWarm) sessions.set(params.bot.id, session);
    }
    return session.runTurn(params.prompt, params.request, params, params.abort.signal, { runId: params.runId, model: params.model, onWait: params.onWait, runMsgId: params.runMsgId, threadId: params.threadId });
  })();

  return {
    steer(textMessage: string) {
      if (!session?.alive || !session.busy) return false;
      session.ctx.request = `${session.ctx.request}\n\nThen the user added: ${textMessage}`;
      session.send(`[Message from the user while you're working — take it into account now]\n${textMessage}`, "next");
      return true;
    },
    done,
  };
}

function stepLabel(name: string, input: Record<string, unknown>, viaTeammate: boolean): string {
  const by = viaTeammate ? "Teammate · " : "";
  const s = (v: unknown, n = 80) => String(v ?? "").slice(0, n);
  if (name === "Agent" || name === "Task") return `Handing to ${s(input.subagent_type || "a helper")}: ${s(input.description, 60)}`;
  if (name === "Bash") return `${by}Running ${s(input.description || input.command)}`;
  if (name === "WebSearch") return `${by}Searching “${s(input.query)}”`;
  if (name === "WebFetch") return `${by}Reading ${s(input.url)}`;
  if (name === "TodoWrite") return `${by}Updating plan`;
  if (name.startsWith("mcp__browser__")) return `${by}Browser · ${name.replace("mcp__browser__browser_", "").replace(/_/g, " ")}${input.url ? ` ${s(input.url, 60)}` : input.element ? ` “${s(input.element, 50)}”` : ""}`;
  if (name.startsWith("mcp__blip__mac_")) return `${by}Mac · ${name.replace("mcp__blip__mac_", "").replace(/_/g, " ")}${input.app ? ` ${s(input.app)}` : input.why ? ` ${s(input.why, 50)}` : ""}`;
  if (["Read", "Write", "Edit"].includes(name)) return `${by}${name === "Read" ? "Reading" : name === "Write" ? "Writing" : "Editing"} ${s(input.file_path).split("/").pop()}`;
  if (name === "Glob" || name === "Grep") return `${by}Looking through files`;
  if (name.startsWith("mcp__blip__")) return `${by}${name.replace("mcp__blip__", "").replace(/_/g, " ")}`;
  if (name === "Skill") return `${by}Using skill ${s(input.skill ?? input.name)}`;
  if (name.startsWith("mcp__")) return `${by}${name.replace(/^mcp__/, "").replace(/__/g, " · ").replace(/_/g, " ")}`;
  return `${by}${name}`;
}
