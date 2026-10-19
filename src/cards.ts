import { addMessage, findMessage, updateMessage, type CardButton, type CardView } from "./hub.js";
import { push } from "./notify.js";
import { post } from "./outbox.js";
import { chatName } from "./store.js";

// Interactive cards (approvals, drafts, takeovers, suggestions) that pause work until the user answers,
// from the app or from Telegram, whichever is first.

export type CardAnswer = { value: string; body?: string };
type Pending = { botId: string; type: CardView["type"]; title: string; resolve: (a: CardAnswer, note?: string) => void };
const pending = new Map<string, Pending>();

const blocking = (t: CardView["type"]) => t !== "suggestion" && t !== "check";

/** Cards a task is paused on (approvals, drafts, takeovers). Suggestions and double-check notes don't pause anything. */
export function pendingCards(botId?: string) {
  return [...pending.values()].filter((p) => blocking(p.type) && (!botId || p.botId === botId)).length;
}

/** Every unanswered card, newest last (for the app's "needs you" strip). */
export function pendingList() {
  return [...pending.entries()].map(([id, p]) => ({ id, botId: p.botId, type: p.type, title: p.title, blocking: blocking(p.type) }));
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
  /** Buttons (by value) that can be tapped right on the phone notification, where the OS supports it. */
  pushActions?: string[];
}): Promise<CardAnswer> {
  if (input.signal?.aborted) return { value: input.timeoutValue }; // the task was stopped before the card went out
  const msg = addMessage({
    botId: input.botId,
    role: "bot",
    kind: "card",
    card: { type: input.type, title: input.title, body: input.body, note: input.note, buttons: input.buttons, draft: input.draft, status: "pending" },
  });
  const name = chatName(input.botId) ?? "Your bot";
  const actions = (input.pushActions ?? []).map((v) => input.buttons.find((b) => b.value === v)).filter((b): b is CardButton => !!b).slice(0, 2);
  void push({
    title: input.type === "suggestion" ? `${name} has a suggestion` : input.type === "check" ? `${name}: double-check failed` : `${name} needs you`,
    body: input.title,
    botId: input.botId,
    tag: msg.id,
    card: actions.length ? { id: msg.id, actions: actions.map((b) => ({ action: b.value, title: b.label })) } : undefined,
  });

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
    pending.set(msg.id, { botId: input.botId, type: input.type, title: input.title, resolve: (a) => finish(a) });
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
