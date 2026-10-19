import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { dist, tempHome } from "../helpers.mjs";

tempHome();
const { config } = await import(dist("config"));
const { placeholdersIn, saveSecret, scrub, deleteSecret, listSecrets } = await import(dist("secrets"));
const { recordCost, spentToday, state } = await import(dist("store"));
const { createBot } = await import(dist("bots"));
const { addMessage, getThread } = await import(dist("hub"));

test("placeholders are found anywhere in a tool's input", () => {
  assert.deepEqual(placeholdersIn({ a: ["x {{secret:GitHub-Token}} y"], b: { c: "{{ secret:pw }}" } }), ["github-token", "pw"]);
});

test("secret values are scrubbed from tool output; names only are stored", async () => {
  await saveSecret("pw", "hunter2-very-secret");
  assert.deepEqual(scrub({ out: "pass=hunter2-very-secret ok" }), { out: "pass={{secret:pw}} ok" });
  assert.equal(scrub({ out: "clean" }), undefined);
  assert.ok(!fs.readFileSync(path.join(config.dataDir, "state.json"), "utf8").includes("hunter2"));
  await deleteSecret("pw");
  assert.equal(listSecrets().length, 0);
});

test("cost: deltas only, a crashed run's zero never re-adds history", () => {
  const before = spentToday();
  assert.equal(recordCost("s1", 1.0), 1.0);
  assert.equal(recordCost("s1", 1.5), 0.5);
  assert.equal(recordCost("s1", 0), 0);
  assert.ok(Math.abs(recordCost("s1", 1.7) - 0.2) < 1e-9, "after a zero, only the new part counts");
  assert.equal(recordCost("s1", 1.2), 0, "a lower total never adds anything");
  assert.ok(Math.abs(spentToday() - before - 1.7) < 1e-9);
});

test("chat history is written atomically and never stores the streaming text", async () => {
  const b = createBot("Writer", "x");
  addMessage({ botId: b.id, role: "bot", kind: "run", run: { label: "x", status: "running", startedAt: 1, steps: [], plan: [], live: "half a sente" } });
  await new Promise((r) => setTimeout(r, 800));
  const file = path.join(config.dataDir, "threads", `${b.id}.json`);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].run.live, undefined);
  assert.ok(!fs.existsSync(`${file}.tmp`));
});

test("thread ids can't reach other files", () => {
  assert.throws(() => getThread("../state"), /Bad bot id/);
});

test("state keeps secrets out and has the expected settings", () => {
  assert.equal(state.settings.fullAccess, false);
  assert.ok(Array.isArray(state.secrets));
});
