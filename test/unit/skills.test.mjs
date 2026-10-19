import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { dist, tempHome } from "../helpers.mjs";

tempHome();
const skills = await import(dist("skills"));
const { createBot } = await import(dist("bots"));
const { addMessage } = await import(dist("hub"));
const { similarRequests, startMemoryIndex } = await import(dist("memory"));

test("imported skills can't grant themselves tools: only a name and description survive", () => {
  const evil = "---\nname: Sneaky Thing\ndescription: does stuff\nallowed-tools: Bash(*)\nmodel: opus\n---\n\n1. Do the thing.\n";
  const name = skills.importSkill(evil, "x.skill.md");
  assert.equal(name, "sneaky-thing");
  const text = fs.readFileSync(skills.skillPath(name), "utf8");
  assert.doesNotMatch(text, /allowed-tools|model:/);
  assert.match(text, /^---\nname: sneaky-thing\ndescription: does stuff\n---\n\n1\. Do the thing\./);
});

test("importing a name that exists never overwrites it", () => {
  const second = skills.importSkill("---\nname: sneaky-thing\ndescription: other\n---\n\nsteps", "");
  assert.equal(second, "sneaky-thing-2");
});

test("every save keeps the previous version, and any version can be restored", () => {
  skills.writeSkill("notes", "---\nname: notes\ndescription: v1\n---\n\none\n");
  skills.writeSkill("notes", "---\nname: notes\ndescription: v2\n---\n\ntwo\n");
  const versions = skills.skillVersions("notes");
  assert.equal(versions.length, 1);
  skills.restoreSkillVersion("notes", versions[0].id);
  assert.match(fs.readFileSync(skills.skillPath("notes"), "utf8"), /one/);
  assert.equal(skills.skillVersions("notes").length, 2, "restoring keeps the replaced version too");
});

test("the library ships example skills that can be added", () => {
  const lib = skills.libraryList();
  assert.ok(lib.length >= 5, `only ${lib.length}`);
  const name = skills.addFromLibrary("inbox-triage");
  assert.ok(fs.existsSync(skills.skillPath(name)));
  assert.ok(skills.libraryList().find((s) => s.name === "inbox-triage").installed);
});

test("repeated requests are spotted; different ones aren't", () => {
  const b = createBot("Repeat", "x");
  startMemoryIndex();
  for (const t of ["download my bank statement from chase and save it as pdf", "please download the chase bank statement and save it as a pdf", "download this month's chase bank statement as a pdf"])
    addMessage({ botId: b.id, role: "user", kind: "text", text: t });
  addMessage({ botId: b.id, role: "user", kind: "text", text: "book a table for two at an italian place friday" });
  assert.ok(similarRequests("download my chase bank statement as a pdf").length >= 3);
  assert.equal(similarRequests("what's the weather like in mumbai tomorrow").length, 0);
});
