import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { dist, tempHome } from "../helpers.mjs";

tempHome();
const { config } = await import(dist("config"));
const { state } = await import(dist("store"));
const { proactiveFacts } = await import(dist("core"));

test("check-ins gather facts in code: failed routines and new files", async () => {
  state.runs.push({ at: new Date().toISOString(), bot: "Blip", label: "Morning news", status: "failed", costUsd: 0, seconds: 3, summary: "Couldn't open the site" });
  state.runs.push({ at: new Date(Date.now() - 3 * 86_400_000).toISOString(), bot: "Blip", label: "Old one", status: "failed", costUsd: 0, seconds: 3, summary: "x" });
  fs.writeFileSync(path.join(config.inbox, "receipt.pdf"), "x");
  const facts = await proactiveFacts();
  assert.ok(facts.some((f) => /Morning news/.test(f) && !/Old one/.test(f)), facts.join("\n"));
  assert.ok(facts.some((f) => /receipt\.pdf/.test(f)), facts.join("\n"));
});

test("check-ins never touch Calendar or Mail until the user allowed them", async () => {
  state.macAccess = undefined;
  const facts = await proactiveFacts();
  assert.ok(!facts.some((f) => /Calendar|Unread mail/.test(f)), facts.join("\n"));
});
