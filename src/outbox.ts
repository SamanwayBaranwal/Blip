import path from "node:path";
import { config } from "./config.js";
import { addMessage, type Msg } from "./hub.js";
import { push } from "./notify.js";
import { state } from "./store.js";

import { chatName } from "./store.js";

const botName = (chatId: string, from?: string) => {
  const where = chatName(chatId) ?? config.botName;
  const who = from && from !== chatId ? state.bots.find((b) => b.id === from)?.name : undefined;
  return who ? `${who} · ${where}` : where;
};

/** Posts a message into a bot's conversation. The app shows it live, Telegram mirrors it, and the phone gets a push. */
export function post(
  botId: string,
  text: string,
  opts: { role?: "bot" | "system"; files?: string[]; meta?: Msg["meta"]; push?: boolean; silent?: boolean } = {},
): Msg {
  const files = opts.files?.map((f) => (path.isAbsolute(f) ? path.relative(config.workspace, f) : f));
  const msg = addMessage({ botId, role: opts.role ?? "bot", kind: "text", text, files, meta: opts.meta });
  if (opts.push !== false) {
    const quiet = opts.silent || state.bots.find((b) => b.id === (opts.meta?.from ?? botId))?.quiet;
    void push({ title: opts.meta?.header ?? botName(botId, opts.meta?.from), body: text || (files?.length ? `Sent ${files.length === 1 ? "a file" : `${files.length} files`}: ${files.map((f) => path.basename(f)).join(", ")}` : ""), botId, tag: msg.id, silent: quiet });
  }
  return msg;
}
