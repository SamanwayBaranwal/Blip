import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

// The single source of truth for conversations. The app streams from here; Telegram mirrors it.

export type Todo = { content: string; status: string; activeForm?: string };
export type Step = { at: number; text: string };

export type RunView = {
  label: string;
  status: "running" | "waiting" | "done" | "failed" | "stopped" | "nothing new";
  startedAt: number;
  endedAt?: number;
  steps: Step[];
  plan: Todo[];
  costUsd?: number;
  stalled?: boolean;
};

export type CardButton = { label: string; value: string; style?: "primary" | "danger" | "default" };
export type CardView = {
  type: "approval" | "draft" | "takeover" | "suggestion";
  title: string;
  body: string;
  note?: string;
  buttons: CardButton[];
  draft?: { channel: string; to: string; subject?: string; body: string };
  status: "pending" | "answered" | "expired";
  answer?: string;
};

export type Msg = {
  id: string;
  botId: string;
  at: number;
  role: "user" | "bot" | "system";
  kind: "text" | "run" | "card";
  text?: string;
  files?: string[]; // paths relative to the workspace
  meta?: { costUsd?: number; seconds?: number; voice?: boolean; header?: string; feedback?: "up" | "down"; error?: boolean };
  run?: RunView;
  card?: CardView;
};

const THREAD_DIR = path.join(config.dataDir, "threads");
const KEEP = 400;
fs.mkdirSync(THREAD_DIR, { recursive: true });

export const events = new EventEmitter();
events.setMaxListeners(50);

const threads = new Map<string, Msg[]>();
const dirty = new Set<string>();

function thread(botId: string): Msg[] {
  let t = threads.get(botId);
  if (!t) {
    try {
      t = JSON.parse(fs.readFileSync(path.join(THREAD_DIR, `${botId}.json`), "utf8")) as Msg[];
    } catch {
      t = [];
    }
    // Anything left running or pending from before a restart can't finish now.
    for (const m of t!) {
      if (m.run && (m.run.status === "running" || m.run.status === "waiting")) m.run.status = "stopped";
      if (m.card?.status === "pending") m.card.status = "expired";
    }
    threads.set(botId, t!);
  }
  return t!;
}

function persistSoon(botId: string) {
  dirty.add(botId);
  setTimeout(flush, 500);
}

function flush() {
  for (const botId of dirty) {
    const t = thread(botId).slice(-KEEP);
    threads.set(botId, t);
    fs.writeFileSync(path.join(THREAD_DIR, `${botId}.json`), JSON.stringify(t), { mode: 0o600 });
  }
  dirty.clear();
}
process.on("exit", flush);

export function addMessage(m: Omit<Msg, "id" | "at"> & { id?: string }): Msg {
  const msg: Msg = { ...m, id: m.id ?? randomUUID(), at: Date.now() };
  thread(m.botId).push(msg);
  persistSoon(m.botId);
  events.emit("msg", msg);
  return msg;
}

export function updateMessage(botId: string, id: string, patch: (m: Msg) => void): Msg | undefined {
  const msg = thread(botId).find((m) => m.id === id);
  if (!msg) return undefined;
  patch(msg);
  persistSoon(botId);
  events.emit("msg", msg);
  return msg;
}

export function findMessage(botId: string, id: string) {
  return thread(botId).find((m) => m.id === id);
}

export function getThread(botId: string, limit = 120): Msg[] {
  return thread(botId).slice(-limit);
}

export function deleteThread(botId: string) {
  threads.delete(botId);
  fs.rmSync(path.join(THREAD_DIR, `${botId}.json`), { force: true });
}

/** Tells connected apps that bots, settings, budget or the running task changed. */
export function stateChanged() {
  events.emit("state");
}
