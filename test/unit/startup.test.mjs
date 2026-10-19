// What happens when Blip starts with damaged or stale data.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { dist, tempHome } from "../helpers.mjs";

const home = tempHome();
const data = path.join(home, "data");
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, "state.json"), '{"bots": [ {"id": "x", "na'); // cut off mid-write

const { state } = await import(dist("store"));

test("a damaged state file is kept as a copy instead of being silently replaced", () => {
  assert.equal(state.bots.length, 0);
  assert.ok(fs.readdirSync(data).some((f) => f.startsWith("state.json.broken-")));
});

test("a one-time routine missed while Blip was off runs late (under a day old)", async () => {
  const { createBot } = await import(dist("bots"));
  const { setRoutineRunner, startRoutines } = await import(dist("routines"));
  const b = createBot("Late", "x");
  const due = new Date(Date.now() - 30 * 60_000);
  const local = new Date(due.getTime() - due.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
  state.routines.push({ id: "late1", botId: b.id, name: "Reminder", schedule: local, prompt: "x", createdAt: local });
  const ran = [];
  setRoutineRunner((r) => ran.push(r.id));
  startRoutines();
  assert.deepEqual(ran, ["late1"]);
  assert.ok(!state.routines.some((r) => r.id === "late1"));
});
