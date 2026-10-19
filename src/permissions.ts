import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { config, SENSITIVE_PATHS, WRITE_PROTECTED_PATHS } from "./config.js";
import { askCard } from "./cards.js";
import { acquireComputer } from "./computer.js";
import type { CardButton } from "./hub.js";
import { autoReview } from "./review.js";
import { fillSecrets, hasSecret, placeholdersIn, saveSecret } from "./secrets.js";
import { agentAddress } from "./email.js";
import { audit, save, state, type BotProfile, type Rule } from "./store.js";

// Tools that only look at things. They run without asking, and are all that read-only runs may use.
const READ_ONLY_SAFE = new Set([
  "WebSearch", "WebFetch", "TodoWrite", "ToolSearch", "Skill",
  "mcp__browser__browser_navigate", "mcp__browser__browser_navigate_back", "mcp__browser__browser_snapshot",
  "mcp__browser__browser_take_screenshot", "mcp__browser__browser_tabs", "mcp__browser__browser_wait_for",
  "mcp__browser__browser_console_messages", "mcp__browser__browser_resize", "mcp__browser__browser_hover",
  "mcp__browser__browser_find", "mcp__browser__browser_close",
  "mcp__blip__mac_screenshot", "mcp__blip__mac_scroll", "mcp__blip__list_routines", "mcp__blip__suggest", "mcp__blip__search_memory",
  "mcp__blip__calendar_events", "mcp__blip__reminders_list", "mcp__blip__contacts_find", "mcp__blip__mail_inbox", "mcp__blip__find_files",
]);
// Also safe outside read-only runs: delegating to teammates and the bot's own bookkeeping tools.
const SAFE = new Set([
  ...READ_ONLY_SAFE, "Task", "Agent", "mcp__browser__browser_install",
  "mcp__blip__send_to_phone", "mcp__blip__create_page", "mcp__blip__hand_off", "mcp__blip__create_helper", "mcp__blip__add_routine", "mcp__blip__add_event_routine", "mcp__blip__remove_routine", "mcp__blip__save_skill",
]);
// Tools that act on screens and pages as the user. These never get a permanent "Always allow": what they do
// depends on *what* is clicked or typed, not the tool (Muse users had standing approvals share a home address).
const INTERACTIVE = new Set([
  "mcp__browser__browser_click", "mcp__browser__browser_type", "mcp__browser__browser_fill_form",
  "mcp__browser__browser_press_key", "mcp__browser__browser_select_option", "mcp__browser__browser_file_upload",
  "mcp__browser__browser_drag", "mcp__browser__browser_drop", "mcp__browser__browser_handle_dialog",
  "mcp__browser__browser_evaluate", "mcp__browser__browser_run_code_unsafe",
  "mcp__blip__mac_click", "mcp__blip__mac_type", "mcp__blip__mac_key",
]);
// Built-in guard, enforced in code rather than by prompt: actions that look like sending, paying, deleting or
// committing always come to the user, whatever the bot was told and whatever rules say.
const COMMIT_WORDS = /\b(send|post|publish|submit|reply|forward|pay|payment|purchase|buy|order|checkout|check out|place order|confirm|delete|remove|cancel|unsubscribe|accept|agree|transfer|withdraw|book|reserve|sign up|subscribe|share)\b/i;
// Social actions taken by a click (on X and elsewhere): they speak for the user in public, so they always ask.
const SOCIAL_CLICK = /\b(like|unlike|repost|retweet|follow|unfollow|quote|reply|bookmark|subscribe|join)\b/i;
const PAYMENT_WORDS = /\b(pay|payment|purchase|buy|order|checkout|check out|place order|transfer|withdraw|subscribe|card number|cvv)\b/i;
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
// Whole words only: "checkout_cart" or "get_or_create_order" are not reads.
const READ_VERBS = new Set(["get", "list", "search", "read", "fetch", "find", "query", "describe", "view", "show", "lookup", "retrieve", "count"]);
const WRITE_VERBS = new Set(["create", "update", "delete", "remove", "send", "post", "write", "set", "add", "cancel", "pay", "order", "checkout", "book", "submit", "move", "archive", "modify", "edit", "insert", "upsert", "reply", "forward", "share", "invite", "publish", "transfer"]);
/** A connector tool only counts as reading when its name starts with a read verb and has no write verb in it
 *  (whole words: "get_orders" reads, "get_or_create_order" and "checkout_cart" don't). */
function isReadTool(name: string) {
  const words = name.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().split(/[_\-.\s]+/).filter(Boolean);
  return READ_VERBS.has(words[0] ?? "") && !words.some((w) => WRITE_VERBS.has(w));
}
const APPROVAL_TIMEOUT_MS = 3 * 60 * 60_000;
const REMINDERS_MS = [10 * 60_000, 60 * 60_000];

export type RunContext = {
  bot: BotProfile;
  request: string;
  readOnly: boolean;
  /** Approvals granted with "Allow for this task": they end with the task. */
  taskAllows: Set<string>;
  /** Identifies the running task, for taking turns on the browser and screen. */
  runId: string;
  /** Tells the task's progress line that it's waiting for another bot to finish with the computer (null: got it). */
  onWait?: (holderName: string | null) => void;
  /** Set once this engine has used the browser or screen (its Chrome may still be open). */
  usedComputer?: boolean;
  /** The chat this task runs in: the bot's own, or a group. Cards go there. */
  threadId?: string;
  /** Working for another bot (hand_off): its own browser, and the screen and mouse stay with the lead. */
  handoff?: boolean;
};
const chatOf = (ctx: { bot: BotProfile; threadId?: string }) => ctx.threadId ?? ctx.bot.id;

/** Tools that drive the shared browser or the Mac's screen, so only one task at a time may use them. */
/** A bot with its own browser only takes turns for the real screen and mouse, never for browsing. */
const usesComputer = (toolName: string, bot?: BotProfile) =>
  ((toolName.startsWith("mcp__browser__") && !bot?.ownBrowser) || toolName.startsWith("mcp__blip__mac_") || toolName === "mcp__blip__request_takeover") &&
  toolName !== "mcp__blip__mac_screenshot";

function resolvePath(p: unknown): string | undefined {
  if (typeof p !== "string" || !p) return undefined;
  const expanded = p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
  return path.resolve(config.workspace, expanded);
}

export function inside(child: string, parent: string) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Real, lower-cased path: macOS disks ignore case (~/.SSH is ~/.ssh) and symlinks can point anywhere. */
function canonical(p: string) {
  // A file that doesn't exist yet (maybe in folders that don't either): resolve the nearest folder that does,
  // so symlinks (including macOS's own /var → /private/var) can't hide where it really lands.
  let dir = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(dir), ...rest).toLowerCase();
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return path.resolve(p).toLowerCase();
      rest.unshift(path.basename(dir));
      dir = parent;
    }
  }
}
// Secrets live outside the workspace; searching a folder that contains one (like ~) counts as touching it.
const SECRET_PATHS = SENSITIVE_PATHS.filter((s) => !inside(s, config.workspace));

export const isSensitive = (p: string, opts: { searchesFolder?: boolean } = {}) => {
  const c = canonical(p);
  if (SENSITIVE_PATHS.some((s) => inside(c, canonical(s)))) return true;
  return !!opts.searchesFolder && SECRET_PATHS.some((s) => inside(canonical(s), c));
};
const isWriteProtected = (p: string) => {
  const c = canonical(p);
  return WRITE_PROTECTED_PATHS.some((s) => inside(c, canonical(s)));
};

/** The argument an "allow" rule matches against: the command, file path, URL, or nothing. */
function mainArg(toolName: string, input: Record<string, unknown>): string {
  return String(input.command ?? input.file_path ?? input.notebook_path ?? input.url ?? input.app ?? "");
}

const SIMPLE_COMMAND = (cmd: string) => !/[;&|`<>$\n]/.test(cmd);
// Commands that can run anything (interpreters, shells, wrappers) or destroy things never get a standing rule:
// "always allow python3" would also allow `python3 -c "<anything>"`.
const NEVER_ALWAYS = [
  "sudo", "rm", "su", "curl", "wget", "osascript", "security", "dd", "diskutil", "launchctl", "chmod", "chown",
  "bash", "sh", "zsh", "fish", "python", "python3", "node", "perl", "ruby", "php", "deno", "bun", "env", "xargs",
  "find", "git", "npm", "npx", "pnpm", "yarn", "pip", "pip3", "brew", "open", "command", "exec", "eval", "nice", "time",
  "nohup", "timeout", "watch", "ssh", "scp", "rsync", "mv", "cp", "ln", "kill", "killall", "pkill", "defaults", "crontab", "tee",
];

/** The rule an "Always allow" tap would save, or undefined if this action is too risky to auto-approve forever. */
function proposedAllowRule(toolName: string, input: Record<string, unknown>): Omit<Rule, "id"> | undefined {
  if (toolName === "Bash") {
    const cmd = String(input.command ?? "").trim();
    const word = cmd.split(/\s+/)[0];
    if (!word || !SIMPLE_COMMAND(cmd) || NEVER_ALWAYS.includes(word) || word.includes("/")) return undefined;
    return { effect: "allow", tool: "Bash", match: `${word} ` };
  }
  if (WRITE_TOOLS.has(toolName) || INTERACTIVE.has(toolName) || toolName === "mcp__blip__add_connector") return undefined;
  if (toolName.startsWith("mcp__") && !toolName.startsWith("mcp__blip__")) return undefined; // connector writes
  return { effect: "allow", tool: toolName };
}

// Keystrokes and page scripts can do anything (Ctrl+Enter sends an email), so each one is reviewed on its own.
const NO_TASK_ALLOW = new Set([
  "mcp__browser__browser_press_key", "mcp__browser__browser_evaluate", "mcp__browser__browser_run_code_unsafe", "mcp__blip__mac_key",
]);

/** Key for "Allow for this task": per tool, and per command name for Bash. */
function taskKey(toolName: string, input: Record<string, unknown>) {
  if (NO_TASK_ALLOW.has(toolName)) return undefined;
  if (toolName !== "Bash") return toolName;
  const cmd = String(input.command ?? "").trim();
  return SIMPLE_COMMAND(cmd) ? `Bash:${cmd.split(/\s+/)[0]}` : undefined;
}

const toolMatches = (pattern: string, toolName: string) =>
  pattern === "*" || pattern === toolName || (pattern.endsWith("*") && toolName.startsWith(pattern.slice(0, -1)));

function matchingRule(effect: Rule["effect"], toolName: string, input: Record<string, unknown>, summary: string) {
  return state.rules.find((r) => {
    if (r.effect !== effect || !toolMatches(r.tool, toolName)) return false;
    if (!r.match) return true;
    if (effect === "ask") return `${summary}\n${JSON.stringify(input)}`.toLowerCase().includes(r.match.toLowerCase());
    const arg = mainArg(toolName, input);
    if (toolName === "Bash" && !SIMPLE_COMMAND(arg)) return false; // "ls && rm -rf x" can't ride on "ls"
    return (arg + " ").startsWith(r.match);
  });
}

export function describeRule(r: Rule) {
  const tool = r.tool.replace(/^mcp__browser__browser_/, "browser ").replace(/^mcp__/, "");
  return r.effect === "ask" ? `Ask first: ${r.tool === "*" ? "anything" : tool}${r.match ? ` containing "${r.match}"` : ""}` : `Allow automatically: ${tool}${r.match ? ` "${r.match.trim()}…"` : ""}`;
}

export function addRule(rule: Omit<Rule, "id">) {
  const exists = state.rules.some((r) => r.effect === rule.effect && r.tool === rule.tool && r.match === rule.match);
  if (!exists) {
    state.rules.push({ id: randomUUID().slice(0, 6), ...rule });
    save();
  }
}

export function describeAction(toolName: string, input: Record<string, unknown>): string {
  const name = toolName.replace(/^mcp__browser__browser_/, "browser ").replace(/^mcp__blip__/, "").replace(/^mcp__/, "");
  if (toolName === "Bash") return `Run in terminal:\n${String(input.command)}`;
  if (WRITE_TOOLS.has(toolName)) return `${name} file:\n${String(input.file_path ?? input.notebook_path)}`;
  if (READ_TOOLS.has(toolName)) return `${name}:\n${String(input.file_path ?? input.path ?? input.pattern)}`;
  if (toolName === "mcp__blip__mac_type") return `Type on the Mac:\n${String(input.text)}`;
  if (toolName === "mcp__blip__mac_click") return `Click on the Mac:\n${input.why ? String(input.why) : `at (${input.x}, ${input.y})`}`;
  if (toolName === "mcp__blip__mac_key") return `Press keys on the Mac:\n${String(input.keys)}`;
  if (toolName === "mcp__blip__mac_open_app") return `Open an app:\n${String(input.app)}`;
  // Browser actions in plain words: what is clicked, what is typed, where.
  const el = input.element ? `“${String(input.element)}”` : "";
  if (toolName === "mcp__browser__browser_click") return `Click in the browser:\n${el || "an element"}${input.doubleClick ? " (double-click)" : ""}`;
  if (toolName === "mcp__browser__browser_type") return `Type in the browser:\n${el ? `${el} ← ` : ""}“${String(input.text)}”${input.submit ? "\nthen press Enter to submit" : ""}`;
  if (toolName === "mcp__browser__browser_press_key") return `Press a key in the browser:\n${String(input.key)}`;
  if (toolName === "mcp__browser__browser_select_option") return `Choose in the browser:\n${el} → ${JSON.stringify(input.values)}`;
  if (toolName === "mcp__browser__browser_fill_form" && Array.isArray(input.fields)) {
    return `Fill a form in the browser:\n${(input.fields as { name?: string; value?: unknown }[]).map((f) => `${f.name ?? "field"}: ${String(f.value)}`).join("\n")}`;
  }
  if (toolName === "mcp__browser__browser_file_upload") return `Upload files in the browser:\n${JSON.stringify(input.paths)}`;
  const details = Object.entries(input)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("\n");
  return `${name.charAt(0).toUpperCase()}${name.slice(1).replace(/_/g, " ")}:\n${details.length > 700 ? details.slice(0, 700) + "…" : details}`;
}

async function draftCard(input: Record<string, unknown>, ctx: RunContext, signal: AbortSignal): Promise<PermissionResult> {
  const bot = ctx.bot;
  const draft = { channel: String(input.channel ?? "message"), to: String(input.to ?? "?"), subject: input.subject ? String(input.subject) : undefined, body: String(input.body ?? "") };
  const answer = await askCard({
    botId: chatOf(ctx),
    type: "draft",
    title: `Draft ${draft.channel} to ${draft.to}`,
    body: draft.body,
    draft,
    buttons: [{ label: "Send", value: "send", style: "primary" }, { label: "Discard", value: "discard", style: "danger" }],
    timeoutMs: APPROVAL_TIMEOUT_MS,
    timeoutValue: "discard",
    signal,
    remindAfterMs: REMINDERS_MS,
  });
  const header = `${draft.channel} to ${draft.to}`;
  if (answer.value === "send") {
    audit({ bot: bot.name, tool: "draft", input: header, decision: "sent" });
    return { behavior: "allow", updatedInput: { ...input, body: answer.body ?? draft.body } };
  }
  audit({ bot: bot.name, tool: "draft", input: header, decision: "denied" });
  return { behavior: "deny", message: "The user discarded this draft. Don't send it." };
}

async function takeoverCard(input: Record<string, unknown>, ctx: RunContext, signal: AbortSignal): Promise<PermissionResult> {
  const bot = ctx.bot;
  const answer = await askCard({
    botId: chatOf(ctx),
    type: "takeover",
    title: "Your turn — take over the computer",
    body: String(input.reason),
    note: "Open the Computer panel, do this step yourself, then tap Done.",
    buttons: [{ label: "Done", value: "done", style: "primary" }, { label: "Can't now", value: "cant" }],
    timeoutMs: APPROVAL_TIMEOUT_MS,
    timeoutValue: "cant",
    signal,
    remindAfterMs: REMINDERS_MS,
  });
  audit({ bot: bot.name, tool: "takeover", input: String(input.reason), decision: answer.value });
  return answer.value === "done"
    ? { behavior: "allow", updatedInput: input }
    : { behavior: "deny", message: "The user couldn't do that step now. Stop and tell them what's left to do." };
}

/** The masked card where the user types a password or key; it goes straight into the Keychain. */
async function secretCard(input: Record<string, unknown>, ctx: RunContext, signal: AbortSignal): Promise<PermissionResult> {
  const bot = ctx.bot;
  const name = String(input.name ?? "").trim();
  if (!name) return { behavior: "deny", message: "Give the secret a short name, like github-token." };
  if (hasSecret(name)) return { behavior: "allow", updatedInput: { ...input, status: "already saved" } };
  const answer = await askCard({
    botId: chatOf(ctx),
    type: "secret",
    title: `${bot.name} needs a secret: ${name}`,
    body: String(input.why ?? ""),
    note: "It's saved in this Mac's Keychain. The bot never sees it, and it never appears in chats or logs.",
    buttons: [{ label: "Save", value: "save", style: "primary" }, { label: "Cancel", value: "cancel" }],
    timeoutMs: APPROVAL_TIMEOUT_MS,
    timeoutValue: "cancel",
    signal,
    remindAfterMs: REMINDERS_MS,
  });
  if (answer.value !== "save" || !answer.body) {
    audit({ bot: bot.name, tool: "secret", input: name, decision: "cancelled" });
    return { behavior: "deny", message: "The user didn't provide that secret. Ask them how they'd like to continue." };
  }
  try {
    await saveSecret(name, answer.body, String(input.why ?? ""));
  } catch (error) {
    return { behavior: "deny", message: `Couldn't save it: ${(error as Error).message}` };
  }
  audit({ bot: bot.name, tool: "secret", input: name, decision: "saved" });
  return { behavior: "allow", updatedInput: { ...input, status: "saved" } };
}

/** An action that uses {{secret:name}}: the user approves it (seeing only the placeholder), then the real value
 *  is filled in for that one run. */
async function withSecrets(
  ctx: RunContext,
  toolName: string,
  input: Record<string, unknown>,
  names: string[],
  options: Parameters<CanUseTool>[2],
  decide: Decide,
): Promise<PermissionResult> {
  const deny = (message: string): PermissionResult => {
    audit({ bot: ctx.bot.name, tool: toolName, input: `uses secret ${names.join(", ")}`, decision: "denied", reason: message });
    return { behavior: "deny", message };
  };
  if (ctx.readOnly) return deny("Secrets can't be used in a read-only check-in.");
  const missing = names.filter((n) => !hasSecret(n));
  if (missing.length) return deny(`There's no saved secret called ${missing.join(", ")}. Ask the user for it with request_secret.`);
  const key = `secret:${toolName}:${names.join(",")}`;
  let decision: PermissionResult;
  if (ctx.taskAllows.has(key)) {
    decision = await decide(toolName, input, options); // the usual checks still apply to what it does
  } else {
    const [title, ...detail] = describeAction(toolName, input).split("\n");
    const { value } = await askCard({
      botId: chatOf(ctx),
      type: "approval",
      title: `Use your secret “${names.join("”, “")}”: ${title!.replace(/:$/, "")}`,
      body: detail.join("\n"),
      note: "Blip fills in the real value for this action. The bot never sees it.",
      buttons: [{ label: "Allow once", value: "once", style: "primary" }, { label: "Allow for this task", value: "task" }, { label: "Deny", value: "deny", style: "danger" }],
      timeoutMs: APPROVAL_TIMEOUT_MS,
      timeoutValue: "deny",
      signal: options.signal,
      remindAfterMs: REMINDERS_MS,
      pushActions: ["deny"],
    });
    if (value === "deny") return deny("The user didn't allow using that secret here. Ask them what to do instead.");
    if (value === "task") ctx.taskAllows.add(key);
    decision = { behavior: "allow", updatedInput: input };
  }
  if (decision.behavior !== "allow") return decision;
  try {
    const filled = await fillSecrets(decision.updatedInput ?? input);
    audit({ bot: ctx.bot.name, tool: toolName, input: `uses secret ${names.join(", ")}`, decision: "allowed" });
    return { ...decision, updatedInput: filled };
  } catch (error) {
    return deny((error as Error).message);
  }
}

/** Take turns on the browser and screen with other bots working in parallel. Only once the action is
 *  allowed: a bot waiting hours on an approval card mustn't hold the computer meanwhile. */
async function takeComputer(ctx: RunContext, toolName: string, decision: PermissionResult, signal: AbortSignal): Promise<PermissionResult> {
  if (decision.behavior !== "allow" || !usesComputer(toolName, ctx.handoff ? { ...ctx.bot, ownBrowser: true } : ctx.bot)) return decision;
  let waited = false;
  try {
    await acquireComputer({ runId: ctx.runId, botId: ctx.bot.id, botName: ctx.bot.name }, signal, (who) => {
      waited = true;
      ctx.onWait?.(who);
    });
  } catch {
    return { behavior: "deny", message: "Stopped while waiting for the computer." };
  }
  if (waited) ctx.onWait?.(null);
  ctx.usedComputer = true;
  return decision;
}

export function makeCanUseTool(ctx: RunContext): CanUseTool {
  const decide = decider(ctx);
  return async (toolName, input, options): Promise<PermissionResult> => {
    const names = toolName === "mcp__blip__request_secret" ? [] : placeholdersIn(input);
    const decision = names.length ? await withSecrets(ctx, toolName, input, names, options, decide) : await decide(toolName, input, options);
    return takeComputer(ctx, toolName, decision, options.signal);
  };
}

/** Runs before every tool call, including ones the engine would allow without asking (like `echo`): any
 *  {{secret:name}} goes through the approval card and is filled in here. Undefined: nothing to do. */
export function makeSecretGate(ctx: RunContext) {
  const decide = decider(ctx);
  return async (toolName: string, input: Record<string, unknown>, signal: AbortSignal, toolUseID?: string): Promise<PermissionResult | undefined> => {
    if (toolName === "mcp__blip__request_secret") return undefined;
    const names = placeholdersIn(input);
    if (!names.length) return undefined;
    const options = { signal, toolUseID: toolUseID ?? "" } as Parameters<CanUseTool>[2];
    return takeComputer(ctx, toolName, await withSecrets(ctx, toolName, input, names, options, decide), signal);
  };
}

type Decide = (...args: Parameters<CanUseTool>) => Promise<PermissionResult>;

function decider(ctx: RunContext): Decide {
  return async (toolName, input, { signal, agentID }): Promise<PermissionResult> => {
    const summary = describeAction(toolName, input);
    const who = agentID ? `${ctx.bot.name} (via teammate)` : ctx.bot.name;
    const record = (decision: string, extra: Record<string, unknown> = {}) =>
      audit({ bot: who, tool: toolName, input: summary.slice(0, 500), decision, ...extra });
    const allow = (how: string, extra?: Record<string, unknown>): PermissionResult => {
      record(how, extra);
      return { behavior: "allow", updatedInput: input };
    };
    const deny = (message: string): PermissionResult => {
      record("denied", { reason: message });
      return { behavior: "deny", message };
    };

    const searchesFolder = toolName === "Grep" || toolName === "Glob" || toolName === "LS";
    const target = READ_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName)
      ? resolvePath(input.file_path ?? input.notebook_path ?? input.path) ?? config.workspace
      : undefined;
    const [prefix, server, ...rest] = toolName.split("__");
    const connectorName = prefix === "mcp" && server && !["blip", "browser"].includes(server) ? server : undefined;
    const connectorTool = rest.join("__");
    const connectorReadOnly = connectorName ? isReadTool(connectorTool) : false;

    // A teammate doing a handed-off part can't take the screen: the lead may be using it (and waiting on this).
    if (ctx.handoff && ((toolName.startsWith("mcp__blip__mac_") && toolName !== "mcp__blip__mac_screenshot") || toolName === "mcp__blip__request_takeover")) {
      return deny("You're doing a part handed to you by another bot, so the Mac's screen isn't yours to use. Do what you can with the browser and other tools, and say in your reply which screen steps the lead should do.");
    }

    // 1. Read-only runs (proactive check-ins) can look but never touch.
    if (ctx.readOnly) {
      if (READ_ONLY_SAFE.has(toolName) || connectorReadOnly) return allow("auto (read-only run)");
      if (target && READ_TOOLS.has(toolName) && !isSensitive(target, { searchesFolder })) return allow("auto (read-only run)");
      return deny("This run is read-only: look, but don't change anything. Shell commands aren't available; use Read, Glob and Grep for files. In a check-in, offer changes with the suggest tool.");
    }

    // 2. Cards that always involve the user.
    if (toolName === "mcp__blip__propose_draft") return draftCard(input, ctx, signal);
    if (toolName === "mcp__blip__request_takeover") return takeoverCard(input, ctx, signal);
    if (toolName === "mcp__blip__request_secret") return secretCard(input, ctx, signal);
    // Email from the agent's own address: always a draft the user approves (and can edit) first.
    if (toolName === "mcp__blip__email_send") {
      if (!agentAddress()) return deny("No agent email is set up. Ask the user to add one in Settings → Agent email.");
      const r = await draftCard({ ...input, channel: `Email from ${agentAddress()}` }, ctx, signal);
      if (r.behavior !== "allow") return r;
      const { channel: _channel, ...edited } = r.updatedInput as Record<string, unknown>;
      return { behavior: "allow", updatedInput: edited };
    }

    // 3. Connector access level (Muse-style read-only / full access per app).
    if (connectorName) {
      // A connector that was removed (but is still loaded in a running engine) gets no access at all.
      const access = Object.hasOwn(state.connectors, connectorName) ? state.connectors[connectorName]!.access : "off";
      if (access === "off") return deny(`The ${connectorName} connector is turned off.`);
      if (access === "read" && !connectorReadOnly) return deny(`The ${connectorName} connector is read-only. Ask the user to give it full access with /connectors.`);
    }

    // Reading the Keychain from the terminal would reveal secrets: always the user's call.
    const keychain = toolName === "Bash" && /\bsecurity\b|keychain/i.test(String(input.command ?? ""));
    const sensitive = keychain || (target ? isSensitive(target, { searchesFolder }) || (WRITE_TOOLS.has(toolName) && isWriteProtected(target)) : false);
    const askFirst = matchingRule("ask", toolName, input, summary);
    // Commit-like clicks, keystrokes and connector writes ("Send", "Pay", "Delete", "Accept offer") always ask.
    const actsAsUser = INTERACTIVE.has(toolName) || (connectorName !== undefined && !connectorReadOnly);
    // A key combo with Enter plus a modifier (Ctrl/Cmd+Enter) sends in most mail and chat apps.
    const sendKey = /(ctrl|control|cmd|command|meta)\s*\+\s*(enter|return)/i.test(String(input.key ?? input.keys ?? ""));
    const socialClick = toolName === "mcp__browser__browser_click" && SOCIAL_CLICK.test(String(input.element ?? ""));
    const committing = actsAsUser && (COMMIT_WORDS.test(summary) || sendKey || socialClick);
    const key = taskKey(toolName, input);

    // Full access (the user's choice in Settings): everything runs without asking except payments,
    // protected files and the user's own Ask-first rules.
    if (state.settings.fullAccess && !askFirst && !sensitive && !(actsAsUser && PAYMENT_WORDS.test(summary)) && !PAYMENT_WORDS.test(toolName)) {
      return allow("full access");
    }

    // 4. Things that are safe by nature run automatically, unless an "Ask first" rule says otherwise.
    if (!askFirst && !sensitive && !committing) {
      if (SAFE.has(toolName) || (connectorName && connectorReadOnly)) return allow("auto");
      if (target && READ_TOOLS.has(toolName)) return allow("auto");
      if (target && WRITE_TOOLS.has(toolName) && inside(target, config.workspace)) return allow("auto");
      if (key && ctx.taskAllows.has(key)) return allow("allowed for this task");
      if (matchingRule("allow", toolName, input, summary)) return allow("your rule");
    }

    // 5. Auto Review decides between running it, asking you, or flagging it as dangerous.
    let reviewNote = "";
    let risky = sensitive || committing;
    if (!askFirst && !sensitive && !committing && state.settings.autoReview && toolName !== "mcp__blip__add_connector") {
      const review = await autoReview(ctx.request, ctx.bot.name, summary, signal);
      if (signal.aborted) return deny("The task was stopped.");
      if (review.verdict === "allow") return allow("auto-review", { reason: review.reason });
      reviewNote = `\n\n${review.verdict === "deny" ? "Auto Review: high risk" : "Auto Review"} — ${review.reason}`;
      risky = review.verdict === "deny";
    }
    if (committing) reviewNote = "\n\nThis looks like sending, paying, deleting or committing to something — always checked with you.";
    if (askFirst) reviewNote = `\n\nYour rule: ${describeRule(askFirst)}`;
    if (sensitive) reviewNote = "\n\nProtected file";

    const rule = risky || askFirst ? undefined : proposedAllowRule(toolName, input);
    const buttons: CardButton[] = [{ label: "Allow once", value: "once", style: "primary" }];
    if (!risky && !askFirst && key) buttons.push({ label: "Allow for this task", value: "task" });
    if (rule) buttons.push({ label: "Always allow", value: "always" });
    buttons.push({ label: "Deny", value: "deny", style: "danger" });
    const [title, ...detail] = summary.split("\n");
    const { value: choice } = await askCard({
      botId: chatOf(ctx),
      type: "approval",
      title: `${title!.replace(/:$/, "").replace(/^browser /, "Browser: ")}`,
      body: detail.join("\n"),
      note: reviewNote.trim() || undefined,
      buttons,
      timeoutMs: APPROVAL_TIMEOUT_MS,
      timeoutValue: "deny",
      signal,
      remindAfterMs: REMINDERS_MS,
      // Allow straight from the notification only for ordinary actions; sending, paying, deleting and your
      // own Ask-first rules are always looked at in the app.
      pushActions: risky || askFirst ? ["deny"] : ["once", "deny"],
    });
    if (choice === "deny") return deny("The user denied this action from their phone. Don't retry it; ask them what to do instead.");
    if (choice === "task" && key) ctx.taskAllows.add(key);
    if (choice === "always" && rule) addRule(rule);
    return allow({ always: "always (rule saved)", task: "allowed for this task" }[choice] ?? "allowed once");
  };
}
