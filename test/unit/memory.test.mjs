import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { dist, tempHome } from "../helpers.mjs";

tempHome();
const { createBot, memoryFile } = await import(dist("bots"));
const { addMessage } = await import(dist("hub"));
const { searchMemory, startMemoryIndex } = await import(dist("memory"));

const b = createBot("Rememberer", "x");
startMemoryIndex();

test("finds facts in a bot's memory file, with their date", () => {
  fs.appendFileSync(memoryFile(b), "- Landlord is Raj, rent due on the 5th (2026-08-02, from: chat)\n");
  const hits = searchMemory("who is my landlord");
  assert.equal(hits[0]?.kind, "memory");
  assert.match(hits[0].text, /Raj/);
  assert.equal(hits[0].at, "2026-08-02");
});

test("finds old chat messages, including words that only partly match", () => {
  addMessage({ botId: b.id, role: "user", kind: "text", text: "My car insurance renews in September with Geico" });
  addMessage({ botId: b.id, role: "bot", kind: "run", run: { label: "x", status: "done", startedAt: 1, steps: [], plan: [] } });
  const hits = searchMemory("insurance renewal");
  assert.ok(hits.some((h) => h.kind === "you said" && /Geico/.test(h.text)), JSON.stringify(hits));
});

test("system notes, progress and errors are not archived", () => {
  addMessage({ botId: b.id, role: "system", kind: "text", text: "Self-test 03:40 · 8/8 passed." });
  assert.equal(searchMemory("self-test passed").length, 0);
});
