import fs from "node:fs";
import path from "node:path";
import { InlineKeyboard } from "grammy";
import { closeWarmSession } from "./agent.js";
import { activeBot, getBot } from "./bots.js";
import { answerCard, editDraft, isPending } from "./cards.js";
import { config } from "./config.js";
import { duration, freshChat, giveFeedback, handleUserMessage, runtime, stopCurrent } from "./core.js";
import { events, findMessage, stateChanged, type Msg } from "./hub.js";
import { screenshotForPhone } from "./mac.js";
import { save, spentToday, state } from "./store.js";
import { bot, downloadToInbox, sendFile, sendText, sendVoice } from "./telegram.js";
import { speak, transcribe } from "./voice.js";

// Optional Telegram channel: mirrors the app's conversations, progress and cards, and accepts messages.

const mirrored = new Map<string, number>(); // hub message id → Telegram message id
const lastEdit = new Map<string, number>();
/** Keeps the two maps from growing forever on an always-on Mac: only recent messages can still change. */
function forgetOld() {
  for (const map of [mirrored, lastEdit] as Map<string, number>[]) {
    if (map.size <= 1500) continue;
    for (const key of [...map.keys()].slice(0, map.size - 1000)) map.delete(key);
  }
}
const stopButton = (botId: string) => new InlineKeyboard().text("Stop", `stop:${botId}`);
let textCapture: ((text: string) => void) | undefined;

const nameTag = (botId: string) => {
  const b = getBot(botId);
  return b && state.bots.length > 1 ? `${b.emoji} ${b.name}: ` : "";
};

function renderRun(m: Msg) {
  const r = m.run!;
  const icons: Record<string, string> = { completed: "✅", in_progress: "▶️", pending: "◻️" };
  const plan = r.plan.map((t) => `${icons[t.status] ?? "◻️"} ${t.status === "in_progress" ? t.activeForm ?? t.content : t.content}`).join("\n");
  const step = r.status === "waiting" ? "⏸ Waiting for you — answer the card below." : r.steps.at(-1)?.text ?? "Starting…";
  return [`⏳ ${nameTag(m.botId)}${r.label}`, plan, step, `⏱ ${duration(Date.now() - r.startedAt)}`].filter(Boolean).join("\n\n").slice(0, 4000);
}

function renderCard(m: Msg) {
  const c = m.card!;
  const icon = { approval: "🔐", draft: "📝", takeover: "🖐", suggestion: "💡", secret: "🔑" }[c.type];
  const body = c.draft ? `To: ${c.draft.to}${c.draft.subject ? `\nSubject: ${c.draft.subject}` : ""}\n\n${c.draft.body}` : c.body;
  return `${icon} ${nameTag(m.botId)}${c.title}\n${body}${c.note ? `\n\n${c.note}` : ""}${c.answer ? `\n\n→ ${c.answer}` : ""}`.slice(0, 4096);
}

async function mirror(m: Msg) {
  if (!bot) return;
  const tgId = mirrored.get(m.id);
  if (m.kind === "text" && m.role !== "user" && tgId === undefined) {
    mirrored.set(m.id, 0);
    const b = getBot(m.botId);
    const foot = m.meta?.seconds !== undefined && m.meta.costUsd !== undefined ? `\n\n— ${duration(m.meta.seconds * 1000)} · $${m.meta.costUsd.toFixed(2)}` : "";
    const head = m.meta?.header ? `${m.meta.header}\n\n` : nameTag(m.botId);
    const keyboard = m.role === "bot" && !m.meta?.error && m.meta?.costUsd !== undefined ? new InlineKeyboard().text("👍", `fb:up:${m.botId}:${m.id}`).text("👎", `fb:down:${m.botId}:${m.id}`) : undefined;
    if (m.text?.trim()) mirrored.set(m.id, (await sendText(`${head}${m.text}${foot}`, { silent: b?.quiet, keyboard })) ?? 0);
    for (const f of m.files ?? []) await sendFile(path.join(config.workspace, f)).catch((e) => console.error("Telegram file failed:", e));
    if (m.meta?.voice && m.text?.trim() && !m.meta.error) {
      const ogg = await speak(m.text).catch(() => undefined);
      if (ogg) await sendVoice(ogg).catch(() => {});
      if (ogg) fs.rmSync(ogg, { force: true });
    }
    forgetOld();
  } else if (m.kind === "run") {
    const done = !["running", "waiting"].includes(m.run!.status);
    if (tgId === undefined) {
      if (done) return;
      mirrored.set(m.id, 0);
      const sent = await bot.api.sendMessage(config.ownerId, renderRun(m), { disable_notification: true, reply_markup: stopButton(m.botId) });
      mirrored.set(m.id, sent.message_id);
      // A quick task can finish while this was sending: don't leave its progress message behind.
      const now = findMessage(m.botId, m.id)?.run?.status;
      if (now && !["running", "waiting"].includes(now)) {
        mirrored.set(m.id, -1);
        await bot.api.deleteMessage(config.ownerId, sent.message_id).catch(() => {});
      }
    } else if (tgId && done) {
      mirrored.set(m.id, -1);
      await bot.api.deleteMessage(config.ownerId, tgId).catch(() => {});
    } else if (tgId > 0 && Date.now() - (lastEdit.get(m.id) ?? 0) > 2500) {
      lastEdit.set(m.id, Date.now());
      await bot.api.editMessageText(config.ownerId, tgId, renderRun(m), { reply_markup: stopButton(m.botId) }).catch(() => {});
    }
  } else if (m.kind === "card") {
    const c = m.card!;
    if (tgId === undefined) {
      mirrored.set(m.id, 0);
      const keyboard = new InlineKeyboard();
      // Secrets are only ever typed into the app's masked field, never into a Telegram chat.
      if (c.type === "secret") {
        const sent = await bot.api.sendMessage(config.ownerId, `${renderCard(m)}\n\nOpen the Blip app to enter it. Never type passwords into Telegram.`);
        return void mirrored.set(m.id, sent.message_id);
      }
      c.buttons.forEach((b, i) => {
        keyboard.text(b.label, `c:${m.id}:${b.value}`);
        if (i % 2 === 1) keyboard.row();
      });
      if (c.type === "draft") keyboard.text("✏️ Edit", `edit:${m.id}`);
      const sent = await bot.api.sendMessage(config.ownerId, renderCard(m), { reply_markup: keyboard });
      mirrored.set(m.id, sent.message_id);
      const latest = findMessage(m.botId, m.id);
      if (latest?.card && latest.card.status !== "pending") {
        mirrored.set(m.id, -1);
        await bot.api.editMessageText(config.ownerId, sent.message_id, renderCard(latest)).catch(() => {});
      }
    } else if (tgId > 0 && c.status !== "pending") {
      mirrored.set(m.id, -1);
      await bot.api.editMessageText(config.ownerId, tgId, renderCard(m)).catch(() => {});
    } else if (tgId > 0 && c.type === "draft") {
      await bot.api.editMessageText(config.ownerId, tgId, renderCard(m), { reply_markup: new InlineKeyboard().text("Send", `c:${m.id}:send`).text("Discard", `c:${m.id}:discard`).text("✏️ Edit", `edit:${m.id}`) }).catch(() => {});
    }
  }
}

export async function startTelegram() {
  if (!bot) return;
  events.on("msg", (m: Msg) => void mirror(m).catch((e) => console.error("Telegram mirror failed:", e)));

  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== config.ownerId) return console.warn(`Ignored Telegram user ${ctx.from?.id}`);
    await next();
  });

  bot.command(["start", "help"], (ctx) =>
    ctx.reply(`👋 ${activeBot().name} here. Message me anything — text, voice, photos, files.\n"@Name …" talks to a specific bot.\n\n/bots switch bot · /new fresh chat · /stop · /status · /screen\n\nEverything else (routines, skills, rules, files, live computer) is in your app.`),
  );
  bot.command("bots", async (ctx) => {
    const keyboard = new InlineKeyboard();
    state.bots.forEach((b) => keyboard.text(`${b.id === state.activeBotId ? "💬 " : ""}${b.emoji} ${b.name}`, `use:${b.id}`).row());
    await ctx.reply("Who do you want to talk to?", { reply_markup: keyboard });
  });
  bot.command("new", async (ctx) => {
    stopCurrent(activeBot().id);
    freshChat(activeBot());
    closeWarmSession(activeBot().id);
    save();
    await ctx.reply(`🆕 Fresh conversation with ${activeBot().name}. Memory is kept.`);
  });
  bot.command("stop", async (ctx) => void (await ctx.reply(stopCurrent() ? "⏹ Stopping…" : "Nothing is running.")));
  bot.command("status", async (ctx) => {
    const r = runtime();
    const cur = r.running.length ? r.running.map((x) => `${getBot(x.botId)?.name}: ${x.label}\n   ${x.step}`).join("\n") : "Idle";
    await ctx.reply(`${cur}${r.queued.length ? `\n📥 ${r.queued.length} queued` : ""}\n💵 Today $${spentToday().toFixed(2)} of $${config.dailyBudgetUsd}`);
  });
  bot.command("screen", async (ctx) => {
    try {
      await sendFile(await screenshotForPhone(), "🖥 Mac screen right now");
    } catch (error) {
      await ctx.reply(`❌ ${(error as Error).message}`);
    }
  });

  bot.on("callback_query:data", async (ctx) => {
    const [kind, a, b, c] = ctx.callbackQuery.data.split(":");
    let note: string | undefined;
    if (kind === "c") note = answerCard(a!, b!) ? undefined : "This already expired.";
    else if (kind === "stop") note = stopCurrent(a || undefined) ? "Stopping…" : "Nothing is running.";
    else if (kind === "use" && getBot(a)) {
      state.activeBotId = a;
      save();
      stateChanged();
      note = `Now talking to ${getBot(a)!.name}`;
    } else if (kind === "edit" && isPending(a!)) {
      await ctx.reply("✏️ Send me the new text for this draft:");
      textCapture = (text) => editDraft(a!, text);
    } else if (kind === "fb") {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      if (a === "up") giveFeedback(b!, c!, true);
      else {
        await ctx.reply(`👎 What should ${getBot(b)?.name ?? "it"} do differently next time?`);
        textCapture = (text) => {
          giveFeedback(b!, c!, false, text);
          void sendText("📝 Noted — it'll remember that.");
        };
      }
    }
    await ctx.answerCallbackQuery(note ? { text: note } : undefined).catch(() => {});
  });

  bot.on("message:text", (ctx) => {
    if (textCapture) {
      const capture = textCapture;
      textCapture = undefined;
      return capture(ctx.message.text);
    }
    if (ctx.message.text.startsWith("/")) return void ctx.reply("Unknown command. /help");
    handleUserMessage(ctx.message.text, { source: "telegram" });
  });

  bot.on(["message:voice", "message:audio"], async (ctx) => {
    const media = ctx.message.voice ?? ctx.message.audio!;
    let saved: string | undefined;
    try {
      saved = await downloadToInbox(media.file_id, ctx.message.voice ? "voice.ogg" : ctx.message.audio?.file_name);
      const text = await transcribe(saved);
      if (ctx.message.voice) fs.rmSync(saved, { force: true }); // a voice note isn't needed once it's text
      if (!text) return void (await ctx.reply("🎙 I couldn't hear anything in that."));
      await ctx.reply(`🎙 "${text}"`);
      handleUserMessage(text, { voice: true, source: "telegram" });
    } catch (error) {
      await ctx.reply(`❌ Couldn't process the voice message: ${(error as Error).message}`);
    }
  });

  bot.on(["message:photo", "message:document", "message:video"], async (ctx) => {
    const m = ctx.message;
    const photo = m.photo?.at(-1);
    const media = photo ?? m.document ?? m.video;
    if (!media) return;
    try {
      const saved = await downloadToInbox(media.file_id, m.document?.file_name ?? (photo ? "photo.jpg" : "video.mp4"));
      const ext = path.extname(saved).toLowerCase();
      const mediaType = ext === ".png" ? "image/png" : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : undefined;
      handleUserMessage(m.caption ?? "", { attachments: [{ path: saved, mediaType }], source: "telegram" });
    } catch (error) {
      await ctx.reply(`❌ Couldn't download that (bots can fetch files up to 20 MB): ${(error as Error).message}`);
    }
  });

  bot.catch((error) => console.error("Telegram error:", error.error));
  // The network may not be up yet when the Mac logs in: none of this may stop Blip from listening.
  void bot.api.setMyCommands([
    { command: "bots", description: "Switch bot" },
    { command: "new", description: "Fresh conversation" },
    { command: "stop", description: "Stop the current task" },
    { command: "status", description: "What's running" },
    { command: "screen", description: "Screenshot of the Mac" },
    { command: "help", description: "Help" },
  ]).catch((e) => console.error("Telegram commands not set:", e.message));
  const listen = () =>
    void bot!.start({ drop_pending_updates: false }).catch((e) => {
      console.error("Telegram stopped; trying again in a minute:", e?.message ?? e);
      setTimeout(listen, 60_000);
    });
  listen();
}
