import fs from "node:fs";
import path from "node:path";
import { Bot, InlineKeyboard, InputFile } from "grammy";
import { config } from "./config.js";

/** Optional Telegram channel. Undefined when TELEGRAM_BOT_TOKEN isn't set. */
export const bot = config.telegramToken ? new Bot(config.telegramToken) : undefined;

const LIMIT = 4000; // Telegram caps a message at 4096 characters
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** Sends long text in chunks. Returns the last message id. */
export async function sendText(text: string, opts: { silent?: boolean; keyboard?: InlineKeyboard } = {}): Promise<number | undefined> {
  if (!bot) return undefined;
  const body = text.trim() || "(no reply)";
  let last: number | undefined;
  for (let i = 0; i < body.length; i += LIMIT) {
    const isLast = i + LIMIT >= body.length;
    const m = await bot.api.sendMessage(config.ownerId, body.slice(i, i + LIMIT), {
      disable_notification: opts.silent,
      reply_markup: isLast ? opts.keyboard : undefined,
    });
    last = m.message_id;
  }
  return last;
}

export async function sendFile(filePath: string, caption?: string) {
  if (!bot) return;
  const file = new InputFile(filePath);
  const options = caption ? { caption: caption.slice(0, 1000) } : {};
  const isSmallImage = IMAGE_EXT.has(path.extname(filePath).toLowerCase()) && fs.statSync(filePath).size < 10_000_000;
  if (isSmallImage) await bot.api.sendPhoto(config.ownerId, file, options);
  else await bot.api.sendDocument(config.ownerId, file, options);
}

export async function sendVoice(oggPath: string) {
  if (!bot) return;
  await bot.api.sendVoice(config.ownerId, new InputFile(oggPath));
}

export async function downloadToInbox(fileId: string, preferredName?: string): Promise<string> {
  if (!bot) throw new Error("Telegram is not configured");
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram did not return a file path");
  const response = await fetch(`https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  return saveToInbox(preferredName || file.file_path, Buffer.from(await response.arrayBuffer()));
}

export function saveToInbox(name: string, data: Buffer): string {
  const target = path.join(config.inbox, `${Date.now()}-${path.basename(name).replace(/[^\w.-]/g, "_")}`);
  fs.writeFileSync(target, data);
  return target;
}
