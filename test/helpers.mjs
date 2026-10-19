// Shared test setup: every test file gets its own temporary Blip home (settings, data, workspace), a pretend
// Keychain and logged-only Mac input, so tests never touch real chats, secrets or the screen.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function tempHome(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blip-test-"));
  const lines = { WEB_PORT: "0", MODEL: "claude-haiku-5-5", FAST_MODEL: "claude-haiku-5-5", REVIEW_MODEL: "claude-haiku-5-5", EFFORT: "low", ...env };
  fs.writeFileSync(path.join(dir, ".env"), Object.entries(lines).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  Object.assign(process.env, { BLIP_DATA_ROOT: dir, BLIP_TEST_KEYCHAIN: "memory", BLIP_INPUT_DRYRUN: "1", BLIP_SCREEN_TEST: "1", BLIP_FAKE_MAC_DATA: "1" });
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  return dir;
}

export const dist = (name) => new URL(`../dist/${name}.js`, import.meta.url).href;
