import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { dist, tempHome } from "../helpers.mjs";

tempHome();
const { config } = await import(dist("config"));
const { createBot } = await import(dist("bots"));
const { addEventRoutine, fireWebhook, newWebhookToken, setRoutineRunner, removeRoutine } = await import(dist("routines"));

const b = createBot("Watcher", "x");
const fired = [];
setRoutineRunner((r, event) => fired.push({ id: r.id, ...event }));

test("a webhook link starts its routine and passes the body along as data", () => {
  const token = newWebhookToken();
  const r = addEventRoutine(b.id, "Hook", { kind: "webhook", token }, "do it");
  assert.equal(fireWebhook("wrong-token", "x"), false);
  assert.equal(fireWebhook(token, '{"price": 4170}'), true);
  assert.deepEqual(fired.at(-1), { id: r.id, summary: "Its webhook was called", data: '{"price": 4170}' });
});

test("a new file in a watched folder starts its routine once, after it has arrived", async () => {
  const folder = path.join(config.workspace, "drop");
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, "old.pdf"), "already here");
  const r = addEventRoutine(b.id, "Drop", { kind: "folder", path: folder }, "file it");
  fs.writeFileSync(path.join(folder, "invoice.pdf"), "new");
  fs.writeFileSync(path.join(folder, ".hidden"), "ignored");
  // File events can arrive late on a busy machine: wait up to 10 s, then make sure it fired exactly once.
  for (let i = 0; i < 100 && !fired.some((f) => f.id === r.id); i++) await new Promise((res) => setTimeout(res, 100));
  await new Promise((res) => setTimeout(res, 1500));
  const mine = fired.filter((f) => f.id === r.id);
  assert.equal(mine.length, 1, JSON.stringify(mine));
  assert.equal(mine[0].data, path.join(folder, "invoice.pdf"));
  removeRoutine(r.id);
});

test("protected or missing folders are refused with a plain reason", () => {
  assert.throws(() => addEventRoutine(b.id, "Bad", { kind: "folder", path: config.dataDir }, "x"), /protected/);
  assert.throws(() => addEventRoutine(b.id, "Bad", { kind: "folder", path: "/nope/nowhere" }, "x"), /no folder/);
  assert.throws(() => addEventRoutine(b.id, "Bad", { kind: "mail" }, "x"), /which emails/);
});
