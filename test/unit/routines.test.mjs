import { test } from "node:test";
import assert from "node:assert/strict";
import { dist, tempHome } from "../helpers.mjs";

tempHome();
const { addRoutine, nextRun } = await import(dist("routines"));
const { createBot, deleteBot } = await import(dist("bots"));
const { state } = await import(dist("store"));

test("routines can't run more often than every 10 minutes", () => {
  const b = createBot("Router", "x");
  assert.throws(() => addRoutine(b.id, "spam", "* * * * *", "hi"), /every 10 minutes/);
  assert.throws(() => addRoutine(b.id, "past", "2020-01-01T09:00:00", "hi"), /never runs/);
  const { routine } = addRoutine(b.id, "hourly", "0 * * * *", "hi");
  assert.ok(nextRun(routine.id));
});

test("deleting a bot removes its routines and stops their timers", () => {
  createBot("Keeper", "x"); // can't delete the only bot
  const b = createBot("Doomed", "x");
  const { routine } = addRoutine(b.id, "daily", "0 9 * * *", "hi");
  deleteBot(b);
  assert.ok(!state.routines.some((r) => r.id === routine.id));
  assert.equal(nextRun(routine.id), null);
});
