import path from "node:path";
import { config } from "./config.js";
import { addMessage, type Msg } from "./hub.js";
import { push } from "./notify.js";
import { state } from "./store.js";

const botName = (botId: string) => state.bots.find((b) => b.id === botId)?.name ?? config.botName;

/** Posts a message into a bot's conversation. The app shows it live, Telegram mirrors it, and the phone gets a push. */
export function post(
  botId: string,
  text: string,
  opts: { role?: "bot" | "system"; files?: string[]; meta?: Msg["meta"]; push?: boolean; silent?: boolean } = {},
): Msg {
  const files = opts.files?.map((f) => (path.isAbsolute(f) ? path.relative(config.workspace, f) : f));
  const msg = addMessage({ botId, role: opts.role ?? "bot", kind: "text", text, files, meta: opts.meta });
  if (opts.push !== false) {
    const quiet = opts.silent || state.bots.find((b) => b.id === botId)?.quiet;
    void push({ title: opts.meta?.header ?? botName(botId), body: text || (files?.length ? `📎 ${files.join(", ")}` : ""), botId, tag: msg.id, silent: quiet });
  }
  return msg;
}
