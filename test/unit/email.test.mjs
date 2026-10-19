import { test } from "node:test";
import assert from "node:assert/strict";
import { dist, tempHome } from "../helpers.mjs";

tempHome();
const { presetFor } = await import(dist("email"));

test("known providers fill in their own servers", () => {
  assert.equal(presetFor("blip.me@gmail.com").imapHost, "imap.gmail.com");
  assert.equal(presetFor("me@icloud.com").smtpHost, "smtp.mail.me.com");
  assert.equal(presetFor("me@outlook.com").imapPort, 993);
  assert.equal(presetFor("me@company.io"), undefined);
});
