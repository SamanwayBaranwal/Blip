import { randomUUID } from "node:crypto";
import { query, type McpServerConfig, type Options, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { personaFor, teamAgents } from "./bots.js";
import { config } from "./config.js";
import { makeCanUseTool } from "./permissions.js";
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
  done: Promise<{ sessionId?: string; failed: boolean; costUsd: number }>;
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

export function startAgent(params: {
  bot: BotProfile;
  prompt: Content;
  request: string; // plain-text version of what the user asked, for Auto Review
  resume?: string;
  readOnly?: boolean;
  abort: AbortController;
  onStep?: (step: string) => void;
  onPlan?: (todos: Todo[]) => void;
  onReply: (text: string, isError: boolean, costSoFarUsd: number) => Promise<void>;
}): AgentHandle {
  const inbox = new Inbox();
  const outstanding: string[] = [];
  let request = params.request;
  let runCost = 0;
  const ctx = { bot: params.bot, request, readOnly: !!params.readOnly, taskAllows: new Set<string>() };

  const send = (content: Content, priority?: "next") => {
    const uuid = randomUUID();
    outstanding.push(uuid);
    inbox.push({ type: "user", uuid, message: { role: "user", content }, parent_tool_use_id: null, ...(priority ? { priority } : {}) });
  };

  const done = (async () => {
    // With an API key, usage is billed per token and capped by the daily budget. Without one, the agent runs on
    // the Claude account signed in on this Mac (Claude plan limits apply; costs shown are estimates).
    const usingKey = !!config.anthropicKey;
    const remaining = config.dailyBudgetUsd - spentToday();
    if (usingKey && remaining <= 0) {
      await params.onReply(`Today's budget of $${config.dailyBudgetUsd} is used up. Raise DAILY_BUDGET_USD in .env or wait until tomorrow.`, true, 0);
      return { sessionId: params.resume, failed: true, costUsd: 0 };
    }

    // The agent's terminal never sees the Telegram token, and never inherits a parent Claude Code session's connection.
    const env: Record<string, string | undefined> = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== "TELEGRAM_BOT_TOKEN" && !/^CLAUDE|^ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)$/.test(key)),
    );
    if (usingKey) env.ANTHROPIC_API_KEY = config.anthropicKey;
    const options: Options = {
      model: params.bot.model ?? config.model,
      effort: config.effort,
      cwd: config.workspace,
      permissionMode: "default",
      settingSources: ["project"], // loads workspace/CLAUDE.md and skills; ignores this Mac's personal Claude Code settings
      systemPrompt: { type: "preset", preset: "claude_code", append: personaFor(params.bot, { readOnly: params.readOnly }) },
      agents: params.readOnly ? undefined : teamAgents(params.bot),
      resume: params.resume,
      abortController: params.abort,
      canUseTool: makeCanUseTool(ctx),
      maxBudgetUsd: usingKey ? remaining : undefined,
      env,
      mcpServers: {
        ...connectorServers(),
        blip: createBlipServer(params.bot),
        browser: {
          type: "stdio",
          command: process.execPath,
          args: [config.playwrightCli, "--browser", "chrome", "--user-data-dir", config.browserProfile, "--output-dir", `${config.workspace}/browser`],
        },
      },
      stderr: (data) => console.error(`[${params.bot.name}]`, data.trimEnd()),
    };

    let sessionId = params.resume;
    let failed = false;
    let lastText = "";
    send(params.prompt);
    try {
      for await (const message of query({ prompt: inbox.messages(), options })) {
        if (message.type === "system" && message.subtype === "init") {
          sessionId = message.session_id;
        } else if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type === "text" && block.text.trim()) lastText = block.text;
            if (block.type !== "tool_use") continue;
            const input = block.input as Record<string, unknown>;
            if (block.name === "TodoWrite" && Array.isArray(input.todos)) params.onPlan?.(input.todos as Todo[]);
            else params.onStep?.(stepLabel(block.name, input, message.parent_tool_use_id !== null));
          }
        } else if (message.type === "result") {
          sessionId = message.session_id;
          runCost += recordCost(message.session_id, message.total_cost_usd);
          const u = message.usage;
          params.bot.contextTokens = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens + u.output_tokens;
          // Mark the user messages this result answered; when none are left, the task is done.
          const covered = message.user_message_uuids ?? (message.user_message_uuid ? [message.user_message_uuid] : []);
          const before = outstanding.length;
          for (const uuid of covered) {
            const i = outstanding.indexOf(uuid);
            if (i >= 0) outstanding.splice(i, 1);
          }
          if (outstanding.length === before) outstanding.shift();
          if (message.subtype === "success") {
            failed = message.is_error;
            await params.onReply(message.result || lastText, message.is_error, runCost);
          } else {
            failed = true;
            const reason = message.subtype === "error_max_budget_usd" ? "it hit today's budget limit" : message.errors.join("; ") || message.subtype;
            await params.onReply(`${lastText}\n\n⚠️ Stopped early: ${reason}`.trim(), true, runCost);
          }
          lastText = "";
          if (!outstanding.length) inbox.close();
        }
      }
    } catch (error) {
      const answeredEverything = inbox.closed && !outstanding.length;
      inbox.close();
      if (params.abort.signal.aborted) {
        await params.onReply("⏹ Stopped.", true, runCost);
        return { sessionId, failed: true, costUsd: runCost };
      }
      // After an error result the CLI exits non-zero; the user already got that error as a reply.
      if (answeredEverything) {
        console.error(`[${params.bot.name}] agent exited after replying:`, (error as Error).message);
        return { sessionId, failed: true, costUsd: runCost };
      }
      throw error;
    }
    inbox.close();
    return { sessionId, failed, costUsd: runCost };
  })();

  return {
    steer(textMessage: string) {
      if (inbox.closed) return false;
      request = `${request}\n\nThen the user added: ${textMessage}`;
      ctx.request = request;
      send(`[Message from the user while you're working — take it into account now]\n${textMessage}`, "next");
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
