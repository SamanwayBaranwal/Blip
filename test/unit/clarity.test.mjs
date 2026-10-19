import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { dist, tempHome } from "../helpers.mjs";

// The "clarity" layer: what a task made (chips + toasts), "/skill" commands, skill stats, cards in the tray
// and on notifications.
tempHome();
const { config } = await import(dist("config"));
const { resultOf } = await import(dist("agent"));
const { skillCommand } = await import(dist("core"));
const skills = await import(dist("skills"));
const cards = await import(dist("cards"));

test("files a task writes show as chips; its own memory and screenshots don't", () => {
  const made = resultOf("Write", { file_path: path.join(config.workspace, "reports", "march.pdf") }, {});
  assert.deepEqual(made, { kind: "file", title: "march.pdf", sub: "reports", path: "reports/march.pdf" });
  assert.equal(resultOf("Write", { file_path: path.join(config.workspace, "memory", "ada.md") }, {}), undefined);
  assert.equal(resultOf("Write", { file_path: path.join(config.workspace, "CLAUDE.md") }, {}), undefined);
  assert.equal(resultOf("Write", { file_path: path.join(config.workspace, ".claude", "skills", "x", "SKILL.md") }, {}), undefined);
  const outside = resultOf("Write", { file_path: "/tmp/elsewhere/notes.txt" }, {});
  assert.equal(outside.path, undefined, "files outside the workspace can't be opened from the app");
});

test("events, reminders, skills and routines become chips; failed tool calls don't", () => {
  const ev = resultOf("mcp__blip__calendar_add", { title: "Dentist", start: "2026-10-21T10:00" }, {});
  assert.equal(ev.kind, "event");
  assert.match(ev.sub, /Oct 21/);
  assert.equal(resultOf("mcp__blip__calendar_add", { title: "X", start: "2026-10-21T10:00" }, { isError: true }), undefined);
  assert.equal(resultOf("mcp__blip__reminders_add", { title: "Call mum" }, {}).kind, "reminder");
  assert.deepEqual(resultOf("mcp__blip__save_skill", { name: "expense-report" }, {}), { kind: "skill", title: "expense-report" });
  assert.equal(resultOf("mcp__blip__add_event_routine", { name: "Invoices", when: "new_email" }, {}).sub, "When a matching email arrives");
  assert.equal(resultOf("Read", { file_path: "/x" }, {}), undefined);
});

test('"/skill details" runs a saved skill; anything else is left alone', () => {
  skills.writeSkill("expense-report", "---\nname: expense-report\ndescription: Monthly expenses\n---\n\n1. Collect receipts\n");
  assert.match(skillCommand("/expense-report March, the Uber ones"), /Use the "expense-report" skill now: read .*expense-report\/SKILL\.md and follow its steps\. Details: March, the Uber ones/);
  assert.match(skillCommand("/expense-report"), /follow its steps\. Ask me/);
  assert.equal(skillCommand("/nope do it"), undefined);
  assert.equal(skillCommand("check /expense-report please"), undefined);
});

test("skills show their version and when they were last used (one count per minute)", () => {
  skills.writeSkill("expense-report", "---\nname: expense-report\ndescription: Monthly expenses v2\n---\n\n1. Collect receipts\n2. Total\n");
  skills.noteSkillUse("expense-report");
  skills.noteSkillUse("expense-report");
  skills.noteSkillUse("not-a-skill");
  const [row] = skills.skillsOverview([{ name: "expense-report", description: "" }]);
  assert.equal(row.version, 2);
  assert.equal(row.uses, 1);
  assert.ok(Date.now() - Date.parse(row.lastUsed) < 5000);
});

test("notification buttons: only the ones asked for, that exist, at most two", () => {
  const buttons = [
    { label: "Allow once", value: "once", style: "primary" },
    { label: "Allow for this task", value: "task" },
    { label: "Deny", value: "deny", style: "danger" },
  ];
  assert.deepEqual(cards.notificationActions(buttons, ["once", "deny"]).map((b) => b.value), ["once", "deny"]);
  assert.deepEqual(cards.notificationActions(buttons, ["missing", "deny"]).map((b) => b.value), ["deny"]);
  assert.deepEqual(cards.notificationActions(buttons).length, 0);
  assert.equal(cards.notificationActions(buttons, ["once", "task", "deny"]).length, 2);
});

test("a failed double-check waits in the tray but never pauses a task", async () => {
  const { createBot } = await import(dist("bots"));
  const b = createBot("Checky", "test");
  const answer = cards.askCard({ botId: b.id, type: "check", title: "Double-check failed: no file", body: "", buttons: [{ label: "Fix", value: "fix" }, { label: "Dismiss", value: "dismiss" }], timeoutMs: 60_000, timeoutValue: "dismiss" });
  assert.equal(cards.pendingCards(b.id), 0, "doesn't count as something a task waits on");
  const item = cards.pendingList().find((p) => p.botId === b.id);
  assert.equal(item.type, "check");
  assert.equal(item.blocking, false);
  assert.ok(cards.answerCard(item.id, "fix"));
  assert.equal((await answer).value, "fix");
  assert.equal(cards.pendingList().some((p) => p.botId === b.id), false);
});

test("Auto Review's answer format is a schema the engine accepts (no draft-2020 stamp)", async () => {
  const { verdictSchema } = await import(dist("review"));
  const schema = verdictSchema();
  assert.equal(schema.$schema, undefined);
  assert.deepEqual(schema.properties.verdict.enum, ["allow", "ask", "deny"]);
});

test("routine schedules read as words", async () => {
  const { describeSchedule } = await import(dist("routines"));
  assert.equal(describeSchedule("0 8 * * *"), "Every day at 8:00 AM");
  assert.equal(describeSchedule("30 17 * * 1-5"), "Weekdays at 5:30 PM");
  assert.equal(describeSchedule("0 9 * * 1"), "Every Monday at 9:00 AM");
  assert.equal(describeSchedule("0 9 1 * *"), "Monthly on the 1st at 9:00 AM");
  assert.equal(describeSchedule("*/15 * * * *"), "Every 15 minutes");
  assert.match(describeSchedule("2026-10-21T09:00:00"), /^Once, Oct 21/);
  assert.equal(describeSchedule("5 4 * 2 *"), "5 4 * 2 *", "unusual ones stay as written");
});

test("screenshots in a tool's result are kept as proof of work; text-only results aren't", async () => {
  const { saveProof } = await import(dist("agent"));
  const fs = await import("node:fs");
  const big = Buffer.alloc(4000, 7).toString("base64");
  const rel = saveProof({ content: [{ type: "text", text: "clicked" }, { type: "image", data: big, mimeType: "image/jpeg" }] }, "run12345");
  assert.match(rel, /^proof\/run12345-\d+\.jpg$/);
  assert.ok(fs.existsSync(path.join(config.workspace, rel)));
  assert.equal(saveProof([{ type: "text", text: "no picture" }], "r"), undefined);
});

test("a task keeps at most 8 screenshots: the first, the newest and a spread between", async () => {
  const { keepShots } = await import(dist("core"));
  let list = [];
  for (let i = 0; i < 12; i++) list = keepShots([...list, `proof/s${i}.png`]);
  assert.equal(list.length, 8);
  assert.equal(list[0], "proof/s0.png");
  assert.equal(list.at(-1), "proof/s11.png");
});

test("duplicating a bot copies its job, look and memory, with its own color", async () => {
  const { createBot, memoryFile } = await import(dist("bots"));
  const { duplicateBot } = await import(dist("core"));
  const fs = await import("node:fs");
  const src = createBot("Scout", "Research");
  src.look = { hat: "tophat", color: "gold" };
  fs.appendFileSync(memoryFile(src), "- likes short reports\n");
  const copy = duplicateBot(src);
  assert.equal(copy.name, "Scout 2");
  assert.equal(copy.job, "Research");
  assert.equal(copy.look.hat, "tophat");
  assert.ok(copy.look.color, "gets a color");
  assert.match(fs.readFileSync(memoryFile(copy), "utf8"), /^# Scout 2's memory[\s\S]*likes short reports/);
});

test("a bot saved as a template makes new bots like it; the template can be removed", async () => {
  const { createBot } = await import(dist("bots"));
  const { saveAsTemplate, customTemplates, createBotFromTemplate, deleteTemplate } = await import(dist("core"));
  const b = createBot("Writer", "Writes scripts");
  b.spice = "high";
  b.model = "claude-haiku-5-5";
  const key = saveAsTemplate(b);
  assert.ok(customTemplates().some((t) => t.key === key));
  const nb = createBotFromTemplate(key);
  assert.equal(nb.name, "Writer 2");
  assert.equal(nb.spice, "high");
  assert.equal(nb.model, "claude-haiku-5-5");
  deleteTemplate(key);
  assert.ok(!customTemplates().some((t) => t.key === key));
});

test("a deleted routine can be put back (Undo)", async () => {
  const { addRoutine, removeRoutine, restoreRoutine, nextRun } = await import(dist("routines"));
  const { state } = await import(dist("store"));
  const { createBot } = await import(dist("bots"));
  const b = createBot("Clock", "routines");
  const { routine } = addRoutine(b.id, "Morning", "0 8 * * *", "say hi");
  const copy = { ...routine };
  removeRoutine(routine.id);
  assert.equal(nextRun(routine.id), null);
  restoreRoutine(copy);
  assert.ok(state.routines.some((r) => r.id === routine.id));
  assert.ok(nextRun(routine.id), "it's scheduled again");
});

test('"@Name" finds bots whose names have spaces, and the longest name wins', async () => {
  const { mentionOf } = await import(dist("core"));
  const bots = [{ id: "a", name: "Blip" }, { id: "b", name: "Blip 2" }, { id: "c", name: "Deal Hunter" }];
  assert.deepEqual(mentionOf("@Blip 2 reply with hi", bots), { bot: bots[1], rest: "reply with hi" });
  assert.deepEqual(mentionOf("@blip, what's up", bots), { bot: bots[0], rest: "what's up" });
  assert.equal(mentionOf("@Deal Hunter: find a TV", bots).bot.id, "c");
  assert.equal(mentionOf("@deal-hunter find a TV", bots).bot.id, "c");
  assert.equal(mentionOf("@Blip2 hi", bots).bot.id, "b");
  assert.equal(mentionOf("@Nobody hi", bots), undefined);
  assert.equal(mentionOf("@Blip", bots), undefined, "a name alone isn't a message");
  assert.equal(mentionOf("hello @Blip 2", bots), undefined);
});

test("anywhere: the tunnel link is found in cloudflared's output", async () => {
  const { tunnelUrlIn } = await import(dist("reach"));
  const out = "2026-10-19T10:00:00Z INF |  https://quiet-river-bold-moon.trycloudflare.com                            |";
  assert.equal(tunnelUrlIn(out), "https://quiet-river-bold-moon.trycloudflare.com");
  assert.equal(tunnelUrlIn("INF Requesting new quick Tunnel on trycloudflare.com..."), undefined);
});

test("one-time sign-in links work once, and expire", async () => {
  const { newLoginLink, useLoginLink } = await import(dist("reach"));
  const link = newLoginLink("https://blip.example/", 60_000);
  assert.match(link, /^https:\/\/blip\.example\/login\?t=[\w-]{30,}$/);
  const token = new URL(link).searchParams.get("t");
  assert.equal(useLoginLink(token), true);
  assert.equal(useLoginLink(token), false, "single use");
  const old = new URL(newLoginLink("https://blip.example", -1)).searchParams.get("t");
  assert.equal(useLoginLink(old), false, "expired");
  assert.equal(useLoginLink("short"), false);
});

test("the setup QR code is a real SVG", async () => {
  const { qrSvg } = await import(dist("reach"));
  const svg = qrSvg("https://quiet-river.trycloudflare.com/login?t=abcdefghijklmnopqrstuvwxyz012345");
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 \d+ \d+"/);
  assert.ok((svg.match(/h1v1h-1z/g) || []).length > 200, "has modules");
});

test("forgiving tags: typos, no @, and an unknown name", async () => {
  const { guessMention } = await import(dist("core"));
  const bots = [{ id: "a", name: "Scout" }, { id: "b", name: "Inbox" }, { id: "c", name: "Deal Hunter" }];
  assert.equal(guessMention("@Scout find flights", bots).bot.id, "a");
  const typo = guessMention("@scot find flights", bots);
  assert.equal(typo.bot.id, "a");
  assert.equal(typo.fuzzy, true);
  assert.equal(typo.rest, "find flights");
  assert.equal(guessMention("@deal-huntr any TV deals?", bots).bot.id, "c");
  assert.equal(guessMention("Inbox, anything from Sam?", bots).bot.id, "b");
  assert.equal(guessMention("Inbox zero is my goal", bots), undefined, "a name at the start without , or : isn't a tag");
  const unknown = guessMention("@Zeta please help", bots);
  assert.equal(unknown.bot, undefined);
  assert.equal(unknown.typed, "Zeta");
  assert.equal(guessMention("just a message", bots), undefined);
});
