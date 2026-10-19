import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";

export const ROOT = path.resolve(import.meta.dirname, "..");
// Settings, data, the workspace and logs live here. Normally the install folder; tests point it at a
// temporary folder (BLIP_DATA_ROOT) so they never touch real chats, memory or the browser profile.
export const DATA_ROOT = process.env.BLIP_DATA_ROOT ? path.resolve(process.env.BLIP_DATA_ROOT) : ROOT;
const ENV_FILE = path.join(DATA_ROOT, ".env");

if (!fs.existsSync(ENV_FILE)) {
  throw new Error(`Missing ${ENV_FILE}. Copy .env.example to .env and fill it in.`);
}
process.loadEnvFile(ENV_FILE);

/** Saves the Anthropic API key into .env and starts using it right away. */
export function setAnthropicKey(key: string) {
  const text = fs.readFileSync(ENV_FILE, "utf8");
  const line = `ANTHROPIC_API_KEY=${key}`;
  const next = /^ANTHROPIC_API_KEY=.*$/m.test(text) ? text.replace(/^ANTHROPIC_API_KEY=.*$/m, line) : `${text.trimEnd()}\n${line}\n`;
  fs.writeFileSync(ENV_FILE, next, { mode: 0o600 });
  config.anthropicKey = key;
  process.env.ANTHROPIC_API_KEY = key;
}

const workspace = path.join(DATA_ROOT, "workspace");

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && !value.startsWith("PASTE_") ? value : undefined;
}

export const config = {
  botName: process.env.BOT_NAME?.trim() || "Blip",
  // Telegram is an optional extra channel; the app works without it.
  telegramToken: optional("TELEGRAM_BOT_TOKEN"),
  ownerId: Number(optional("TELEGRAM_OWNER_ID") ?? 0),
  // Can be added later from the app (Settings → Connect Claude), so the app opens without it.
  anthropicKey: optional("ANTHROPIC_API_KEY") ?? "",
  webPort: Number(process.env.WEB_PORT || "8787"),
  webDir: path.join(ROOT, "web"),
  model: process.env.MODEL?.trim() || "claude-opus-5-5",
  reviewModel: process.env.REVIEW_MODEL?.trim() || process.env.MODEL?.trim() || "claude-opus-5-5",
  effort: (process.env.EFFORT?.trim() || "high") as EffortLevel,
  dailyBudgetUsd: Number(process.env.DAILY_BUDGET_USD || "10"),
  timezone: process.env.TIMEZONE?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone,
  // When proactive check-ins run (cron, local time). Default: 10:00, 14:00 and 18:00.
  proactiveSchedule: process.env.PROACTIVE_SCHEDULE?.trim() || "0 10,14,18 * * *",
  workspace,
  inbox: path.join(workspace, "inbox"),
  memoryDir: path.join(workspace, "memory"),
  skillsDir: path.join(workspace, ".claude", "skills"),
  dataDir: path.join(DATA_ROOT, "data"),
  logsDir: path.join(DATA_ROOT, "logs"),
  browserProfile: path.join(DATA_ROOT, "data", "browser-profile"),
  botBrowsersDir: path.join(DATA_ROOT, "data", "browser-profiles"),
  playwrightCli: path.join(ROOT, "node_modules", "@playwright", "mcp", "cli.js"),
  whisperModel: path.join(ROOT, "models", "ggml-small.bin"),
};

if (config.telegramToken && !config.ownerId) throw new Error("Set TELEGRAM_OWNER_ID too, or remove TELEGRAM_BOT_TOKEN to run app-only.");

// Blip's own code and the folders that give a bot powers: writing there always asks (reading is fine).
// .claude holds skills, agents and commands, which can carry their own tool permissions.
export const WRITE_PROTECTED_PATHS = [
  path.join(workspace, ".claude"),
  path.join(ROOT, "dist"),
  path.join(ROOT, "src"),
  path.join(ROOT, "node_modules"),
  path.join(ROOT, "blip.sh"),
  path.join(ROOT, "package.json"),
  path.join(os.homedir(), "Library", "LaunchAgents"),
];

// Paths the agent may never read or write without asking, even inside allowed areas.
// The workspace's .claude settings and .mcp.json are here so a bot can't grant itself permissions or tools.
export const SENSITIVE_PATHS = [
  ENV_FILE,
  config.dataDir,
  path.join(DATA_ROOT, "logs"), // the log can hold the app link
  path.join(workspace, ".claude", "settings.json"),
  path.join(workspace, ".claude", "settings.local.json"),
  path.join(workspace, ".mcp.json"),
  path.join(os.homedir(), ".ssh"),
  path.join(os.homedir(), ".aws"),
  path.join(os.homedir(), ".config"),
  path.join(os.homedir(), "Library", "Keychains"),
  path.join(os.homedir(), "Library", "Cookies"),
  path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome"),
];

for (const dir of [config.workspace, config.inbox, config.memoryDir, config.skillsDir, config.dataDir]) {
  fs.mkdirSync(dir, { recursive: true });
}
