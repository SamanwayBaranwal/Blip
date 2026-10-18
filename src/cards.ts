import { addMessage, findMessage, updateMessage, type CardButton, type CardView } from "./hub.js";
import { push } from "./notify.js";
import { post } from "./outbox.js";
import { state } from "./store.js";

// Interactive cards (approvals, drafts, takeovers, suggestions) that pause work until the user answers,
// from the app or from Telegram, whichever is first.

export type CardAnswer = { value: string; body?: string };
type Pending = { botId: string; type: CardView["type"]; resolve: (a: CardAnswer, note?: string) => void };
const pending = new Map<string, Pending>();

/** Cards a task is paused on (approvals, drafts, takeovers). Suggestions don't pause anything. */
export function pendingCards(botId?: string) {
  return [...pending.values()].filter((p) => p.type !== "suggestion" && (!botId || p.botId === botId)).length;
}

export async function askCard(input: {
  botId: string;
  type: CardView["type"];
  title: string;
  body: string;
  note?: string;
  buttons: CardButton[];
  draft?: CardView["draft"];
  timeoutMs: number;
  timeoutValue: string;
  signal?: AbortSignal;
  remindAfterMs?: number[];
}): Promise<CardAnswer> {
  if (input.signal?.aborted) return { value: input.timeoutValue }; // the task was stopped before the card went out
  const msg = addMessage({
    botId: input.botId,
    role: "bot",
    kind: "card",
    card: { type: input.type, title: input.title, body: input.body, note: input.note, buttons: input.buttons, draft: input.draft, status: "pending" },
  });
  const name = state.bots.find((b) => b.id === input.botId)?.name ?? "Your bot";
  void push({ title: input.type === "suggestion" ? `${name} has a suggestion` : `${name} needs you`, body: input.title, botId: input.botId, tag: msg.id });

  return new Promise<CardAnswer>((resolve) => {
    const reminders = (input.remindAfterMs ?? []).map((ms) =>
      setTimeout(() => post(input.botId, `Still waiting for you: "${input.title}". The task is paused until you answer.`, { role: "system" }), ms),
    );
    const finish = (answer: CardAnswer, expired = false) => {
      if (!pending.delete(msg.id)) return;
      clearTimeout(timer);
      reminders.forEach(clearTimeout);
      const label = input.buttons.find((b) => b.value === answer.value)?.label ?? answer.value;
      updateMessage(input.botId, msg.id, (m) => {
        m.card!.status = expired ? "expired" : "answered";
        m.card!.answer = expired ? (input.signal?.aborted ? "Cancelled" : "Timed out") : label;
        if (answer.body !== undefined && m.card!.draft) m.card!.draft.body = answer.body;
      });
      resolve(answer);
    };
    const timer = setTimeout(() => finish({ value: input.timeoutValue }, true), input.timeoutMs);
    input.signal?.addEventListener("abort", () => finish({ value: input.timeoutValue }, true), { once: true });
    pending.set(msg.id, { botId: input.botId, type: input.type, resolve: (a) => finish(a) });
  });
}

/** Answers a pending card. For drafts, `body` is the (possibly edited) final text. Returns false if expired. */
export function answerCard(id: string, value: string, body?: string): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  const card = findMessage(entry.botId, id)?.card;
  if (!card?.buttons.some((b) => b.value === value)) return false;
  entry.resolve({ value, body: body ?? card.draft?.body });
  return true;
}

/** Edits a pending draft's text without answering it (Telegram's ✏️ Edit flow). */
export function editDraft(id: string, body: string): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  return !!updateMessage(entry.botId, id, (m) => {
    if (m.card?.draft) m.card.draft.body = body;
  });
}

export function isPending(id: string) {
  return pending.has(id);
}
