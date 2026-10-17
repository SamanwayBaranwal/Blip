import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { config, SENSITIVE_PATHS } from "./config.js";
import { askCard } from "./cards.js";
import type { CardButton } from "./hub.js";
import { autoReview } from "./review.js";
import { audit, save, state, type BotProfile, type Rule } from "./store.js";

// Tools that only look at things. They run without asking, and are all that read-only runs may use.
const READ_ONLY_SAFE = new Set([
  "WebSearch", "WebFetch", "TodoWrite", "ToolSearch", "Skill",
  "mcp__browser__browser_navigate", "mcp__browser__browser_navigate_back", "mcp__browser__browser_snapshot",
  "mcp__browser__browser_take_screenshot", "mcp__browser__browser_tabs", "mcp__browser__browser_wait_for",
  "mcp__browser__browser_console_messages", "mcp__browser__browser_resize", "mcp__browser__browser_hover",
  "mcp__browser__browser_find", "mcp__browser__browser_close",
  "mcp__blip__mac_screenshot", "mcp__blip__mac_scroll", "mcp__blip__list_routines", "mcp__blip__suggest",
]);
// Also safe outside read-only runs: delegating to teammates and the bot's own bookkeeping tools.
const SAFE = new Set([
  ...READ_ONLY_SAFE, "Task", "Agent", "mcp__browser__browser_install",
  "mcp__blip__send_to_phone", "mcp__blip__add_routine", "mcp__blip__remove_routine", "mcp__blip__save_skill",
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
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const READ_VERB = /^(get|list|search|read|fetch|find|query|describe|view|show|lookup|retrieve|count|check)/i;
const APPROVAL_TIMEOUT_MS = 3 * 60 * 60_000;
const REMINDERS_MS = [10 * 60_000, 60 * 60_000];

export type RunContext = {
  bot: BotProfile;
  request: string;
  readOnly: boolean;
  /** Approvals granted with "Allow for this task": they end with the task. */
  taskAllows: Set<string>;
};

function resolvePath(p: unknown): string | undefined {
  if (typeof p !== "string" || !p) return undefined;
  const expanded = p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
  return path.resolve(config.workspace, expanded);
}

export function inside(child: string, parent: string) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export const isSensitive = (p: string) => SENSITIVE_PATHS.some((s) => inside(p, s));

/** The argument an "allow" rule matches against: the command, file path, URL, or nothing. */
function mainArg(toolName: string, input: Record<string, unknown>): string {
  return String(input.command ?? input.file_path ?? input.notebook_path ?? input.url ?? input.app ?? "");
}

const SIMPLE_COMMAND = (cmd: string) => !/[;&|`<>$\n]/.test(cmd);
const NEVER_ALWAYS = ["sudo", "rm", "su", "curl", "wget", "osascript", "security", "dd", "diskutil", "launchctl", "chmod", "chown"];

/** The rule an "Always allow" tap would save, or undefined if this action is too risky to auto-approve forever. */
function proposedAllowRule(toolName: string, input: Record<string, unknown>): Omit<Rule, "id"> | undefined {
  if (toolName === "Bash") {
    const cmd = String(input.command ?? "").trim();
    const word = cmd.split(/\s+/)[0];
    if (!word || !SIMPLE_COMMAND(cmd) || NEVER_ALWAYS.includes(word)) return undefined;
    return { effect: "allow", tool: "Bash", match: `${word} ` };
  }
  if (WRITE_TOOLS.has(toolName) || INTERACTIVE.has(toolName) || toolName === "mcp__blip__add_connector") return undefined;
  if (toolName.startsWith("mcp__") && !toolName.startsWith("mcp__blip__")) return undefined; // connector writes
  return { effect: "allow", tool: toolName };
}

/** Key for "Allow for this task": per tool, and per command name for Bash. */
function taskKey(toolName: string, input: Record<string, unknown>) {
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
    if (effect === "ask") return summary.toLowerCase().includes(r.match.toLowerCase());
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

async function draftCard(input: Record<string, unknown>, bot: BotProfile, signal: AbortSignal): Promise<PermissionResult> {
  const draft = { channel: String(input.channel ?? "message"), to: String(input.to ?? "?"), subject: input.subject ? String(input.subject) : undefined, body: String(input.body ?? "") };
  const answer = await askCard({
    botId: bot.id,
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

async function takeoverCard(input: Record<string, unknown>, bot: BotProfile, signal: AbortSignal): Promise<PermissionResult> {
  const answer = await askCard({
    botId: bot.id,
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

export function makeCanUseTool(ctx: RunContext): CanUseTool {
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

    const target = READ_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName)
      ? resolvePath(input.file_path ?? input.notebook_path ?? input.path) ?? config.workspace
      : undefined;
    const [prefix, server, ...rest] = toolName.split("__");
    const connectorName = prefix === "mcp" && server && !["blip", "browser"].includes(server) ? server : undefined;
    const connectorReadOnly = connectorName ? READ_VERB.test(rest.join("__")) : false;

    // 1. Read-only runs (proactive check-ins) can look but never touch.
    if (ctx.readOnly) {
      if (READ_ONLY_SAFE.has(toolName) || connectorReadOnly) return allow("auto (read-only run)");
      if (target && READ_TOOLS.has(toolName) && !isSensitive(target)) return allow("auto (read-only run)");
      return deny("This is a read-only check-in. Don't change anything; suggest it with the suggest tool instead.");
    }

    // 2. Cards that always involve the user.
    if (toolName === "mcp__blip__propose_draft") return draftCard(input, ctx.bot, signal);
    if (toolName === "mcp__blip__request_takeover") return takeoverCard(input, ctx.bot, signal);

    // 3. Connector access level (Muse-style read-only / full access per app).
    if (connectorName) {
      const access = state.connectors[connectorName]?.access ?? "full";
      if (access === "off") return deny(`The ${connectorName} connector is turned off.`);
      if (access === "read" && !connectorReadOnly) return deny(`The ${connectorName} connector is read-only. Ask the user to give it full access with /connectors.`);
    }

    const sensitive = target ? isSensitive(target) : false;
    const askFirst = matchingRule("ask", toolName, input, summary);
    // Commit-like clicks, keystrokes and connector writes ("Send", "Pay", "Delete", "Accept offer") always ask.
    const actsAsUser = INTERACTIVE.has(toolName) || (connectorName !== undefined && !connectorReadOnly);
    const committing = actsAsUser && COMMIT_WORDS.test(summary);
    const key = taskKey(toolName, input);

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
      const review = await autoReview(ctx.request, ctx.bot.name, summary);
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
      botId: ctx.bot.id,
      type: "approval",
      title: `${title!.replace(/:$/, "").replace(/^browser /, "Browser: ")}`,
      body: detail.join("\n"),
      note: reviewNote.trim() || undefined,
      buttons,
      timeoutMs: APPROVAL_TIMEOUT_MS,
      timeoutValue: "deny",
      signal,
      remindAfterMs: REMINDERS_MS,
    });
    if (choice === "deny") return deny("The user denied this action from their phone. Don't retry it; ask them what to do instead.");
    if (choice === "task" && key) ctx.taskAllows.add(key);
    if (choice === "always" && rule) addRule(rule);
    return allow({ always: "always (rule saved)", task: "allowed for this task" }[choice] ?? "allowed once");
  };
}
