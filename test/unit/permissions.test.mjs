import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dist, tempHome } from "../helpers.mjs";

const home = tempHome();
const { config } = await import(dist("config"));
const { state } = await import(dist("store"));
const { createBot } = await import(dist("bots"));
const { events } = await import(dist("hub"));
const { answerCard } = await import(dist("cards"));
const { makeCanUseTool, makeSecretGate, isSensitive } = await import(dist("permissions"));
const { saveSecret } = await import(dist("secrets"));

state.settings.autoReview = false; // no model calls in unit tests
const bot = createBot("Tester", "test bot");
const ctx = (extra = {}) => ({ bot, request: "test", readOnly: false, taskAllows: new Set(), runId: "r1", ...extra });

// Answers the next card with `pick(card)` and records it.
let lastCard;
let pick = () => "deny";
events.on("msg", (m) => {
  if (m.kind !== "card" || m.card.status !== "pending") return;
  lastCard = m.card;
  setImmediate(() => answerCard(m.id, pick(m.card), m.card.type === "approval" ? undefined : "x"));
});
async function decide(tool, input, opts = {}) {
  lastCard = undefined;
  const signal = new AbortController().signal;
  const fn = opts.gate ? makeSecretGate(ctx(opts.ctx)) : makeCanUseTool(ctx(opts.ctx));
  const result = opts.gate ? await fn(tool, input, signal) : await fn(tool, input, { signal, toolUseID: "t" });
  return { result, card: lastCard };
}

test("reading a workspace file runs without asking", async () => {
  const { result, card } = await decide("Read", { file_path: path.join(config.workspace, "notes.txt") });
  assert.equal(result.behavior, "allow");
  assert.equal(card, undefined);
});

test("protected files ask, whatever the letter case", async () => {
  const { result, card } = await decide("Read", { file_path: path.join(home, ".ENV") });
  assert.equal(result.behavior, "deny");
  assert.ok(card, "expected an approval card");
  assert.match(card.note ?? "", /Protected/);
});

test("searching a folder that contains secrets asks", async () => {
  assert.equal(isSensitive(os.homedir(), { searchesFolder: true }), true);
  assert.equal(isSensitive(config.workspace, { searchesFolder: true }), false);
  const { card } = await decide("Glob", { pattern: "**/*", path: os.homedir() });
  assert.ok(card);
});

test("a symlink into the data folder is still protected", () => {
  const link = path.join(config.workspace, "sneaky");
  fs.symlinkSync(config.dataDir, link);
  assert.equal(isSensitive(path.join(link, "app-access-code")), true);
});

test("'Always allow' is offered for simple commands but never for interpreters", async () => {
  pick = () => "deny";
  const ls = await decide("Bash", { command: "ls -la" });
  assert.ok(ls.card.buttons.some((b) => b.value === "always"));
  const py = await decide("Bash", { command: "python3 -c 'print(1)'" });
  assert.ok(!py.card.buttons.some((b) => b.value === "always"));
});

test("terminal access to the Keychain always asks", async () => {
  const { card } = await decide("Bash", { command: "security find-generic-password -s Blip -w" });
  assert.ok(card);
  assert.ok(!card.buttons.some((b) => b.value === "always" || b.value === "task"));
});

test("Ctrl+Enter counts as sending", async () => {
  const { card } = await decide("mcp__browser__browser_press_key", { key: "Control+Enter" });
  assert.match(card.note ?? "", /sending/);
});

test("read-only runs can look but not touch", async () => {
  const write = await decide("Write", { file_path: path.join(config.workspace, "x.txt"), content: "x" }, { ctx: { readOnly: true } });
  assert.equal(write.result.behavior, "deny");
  assert.equal(write.card, undefined);
  const fetch = await decide("WebFetch", { url: "https://example.com" }, { ctx: { readOnly: true } });
  assert.equal(fetch.result.behavior, "allow");
});

test("connector access: read-only connectors refuse writes; removed connectors get nothing", async () => {
  state.connectors.shop = { type: "http", url: "https://x", access: "read" };
  assert.equal((await decide("mcp__shop__get_orders", {})).result.behavior, "allow");
  assert.equal((await decide("mcp__shop__checkout_cart", {})).result.behavior, "deny");
  delete state.connectors.shop;
  const gone = await decide("mcp__shop__get_orders", {});
  assert.equal(gone.result.behavior, "deny");
  assert.match(gone.result.message, /turned off/);
});

test("writing into .claude (skills, agents) asks", async () => {
  const { card } = await decide("Write", { file_path: path.join(config.workspace, ".claude", "skills", "x", "SKILL.md"), content: "x" });
  assert.ok(card);
});

test("full access still asks before payments", async () => {
  state.settings.fullAccess = true;
  try {
    assert.equal((await decide("Bash", { command: "rm -rf /tmp/blip-nothing" })).result.behavior, "allow");
    const pay = await decide("mcp__browser__browser_click", { element: "Pay now", ref: "e1" });
    assert.ok(pay.card, "payment must still ask");
  } finally {
    state.settings.fullAccess = false;
  }
});

test("secrets: unknown names are refused; known ones ask, then get filled in", async () => {
  const unknown = await decide("Bash", { command: "echo {{secret:nope}}" }, { gate: true });
  assert.equal(unknown.result.behavior, "deny");
  await saveSecret("api-key", "sk-test-1234567");
  pick = () => "once";
  const used = await decide("Bash", { command: "curl -H 'X: {{secret:api-key}}' https://x" }, { gate: true });
  assert.match(used.card.title, /Use your secret/);
  assert.doesNotMatch(JSON.stringify(used.card), /sk-test-1234567/, "the card must never show the value");
  assert.equal(used.result.behavior, "allow");
  assert.match(used.result.updatedInput.command, /sk-test-1234567/);
  pick = () => "deny";
});
