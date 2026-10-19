import { test } from "node:test";
import assert from "node:assert/strict";
import { dist, tempHome } from "../helpers.mjs";

tempHome();
const c = await import(dist("computer"));
const busy = new Set();
const closed = [];
c.setEngines({ close: async (id) => { closed.push(id); await new Promise((r) => setTimeout(r, 200)); }, busy: (id) => busy.has(id) });
const run = (id, n = 1) => ({ runId: `${id}-${n}`, botId: id, botName: id });
const signal = () => new AbortController();
const within = (p, ms = 2000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("deadlock")), ms))]);

test("bots take turns; the previous bot's browser is closed first", async () => {
  await c.acquireComputer(run("A"), signal().signal, () => {});
  let waitedFor;
  const b = c.acquireComputer(run("B"), signal().signal, (w) => (waitedFor = w));
  await c.releaseComputer("A-1");
  await within(b);
  assert.equal(waitedFor, "A");
  assert.deepEqual(closed, ["A"]);
  assert.equal(c.computerHolder().botId, "B");
});

test("stopping a task mid-handover never strands the next one", async () => {
  const stopC = signal();
  const pc = c.acquireComputer(run("C"), stopC.signal, () => {}).catch(() => "stopped");
  const pd = c.acquireComputer(run("D"), signal().signal, () => {});
  const released = c.releaseComputer("B-1");
  setTimeout(() => stopC.abort(), 50); // stop C while B's browser is closing
  await released;
  assert.equal(await pc, "stopped");
  await within(pd);
  assert.equal(c.computerHolder().botId, "D");
});

test("a busy bot keeps its browser; others wait; it can take it straight back", async () => {
  await c.releaseComputer("D-1");
  busy.add("D");
  let eWaited = false;
  const pe = c.acquireComputer(run("E"), signal().signal, () => (eWaited = true));
  await within(c.acquireComputer(run("D", 2), signal().signal, () => assert.fail("D shouldn't wait")));
  assert.ok(eWaited);
  busy.delete("D");
  await c.releaseComputer("D-2");
  await within(pe);
  assert.equal(c.computerHolder().botId, "E");
});
