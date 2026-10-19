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
