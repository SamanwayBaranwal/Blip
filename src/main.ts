import fs from "node:fs";
import path from "node:path";
import { ensureDefaultBot } from "./bots.js";
import { config } from "./config.js";
import { stopCurrent, welcome } from "./core.js";
import { startRoutines } from "./routines.js";
import { loadSecrets } from "./secrets.js";
import { startMemoryIndex } from "./memory.js";
import { buildHelper } from "./native.js";
import { save, state } from "./store.js";
import { startTelegram } from "./telegram-app.js";
import { bot as telegram } from "./telegram.js";
import { startWeb } from "./web.js";

ensureDefaultBot();
const sharedNotes = path.join(config.workspace, "CLAUDE.md");
if (!fs.existsSync(sharedNotes)) fs.writeFileSync(sharedNotes, "# Shared notes about the user\n\n## About the user\n");

startRoutines();
startMemoryIndex();
void buildHelper("macdata", "blip-macdata"); // Calendar, Reminders and Contacts (built once, in the background)
void loadSecrets().catch((error) => console.error("Couldn't load secrets from the Keychain:", error));
startWeb();
await startTelegram().catch((error) => console.error("Telegram failed to start (the app still works):", error));

if (!state.onboarded) {
  welcome(); // first start: no blank chat
  state.onboarded = true;
  save();
}

// Blip runs for weeks at a time: a stray error in one task must not take the whole app down.
process.on("unhandledRejection", (reason) => console.error("Unhandled error (Blip keeps running):", reason));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stopCurrent();
    void (telegram?.stop() ?? Promise.resolve()).finally(() => process.exit(0));
  });
}
// Screenshots and browser output only matter for a while; clear anything older than a week, daily.
function pruneOldFiles() {
  const cutoff = Date.now() - 7 * 86_400_000;
  for (const dir of [path.join(config.workspace, "browser"), path.join(config.workspace, "screenshots"), path.join(config.workspace, "replays"), path.join(config.dataDir, "voice")]) {
    try {
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name);
        const st = fs.statSync(file);
        if (st.isFile() && st.mtimeMs < cutoff) fs.rmSync(file, { force: true });
      }
    } catch {
      // folder doesn't exist yet
    }
  }
}
pruneOldFiles();
setInterval(pruneOldFiles, 24 * 3_600_000).unref();

// The access code stays out of the log (bots can read files); ./blip.sh link shows it.
console.log(`Ready. Bots: ${state.bots.map((b) => b.name).join(", ")}. Model ${config.model}. App: http://localhost:${config.webPort} (sign-in link: ./blip.sh link)`);

// The service log grows forever otherwise. launchd appends to it, so trimming it in place is safe.
const LOG_FILE = path.join(config.logsDir, "blip.log");
setInterval(() => {
  try {
    const size = fs.statSync(LOG_FILE).size;
    if (size < 20_000_000) return;
    const fd = fs.openSync(LOG_FILE, "r");
    const tail = Buffer.alloc(2_000_000);
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    fs.closeSync(fd);
    fs.writeFileSync(path.join(path.dirname(LOG_FILE), "blip.old.log"), tail);
    fs.truncateSync(LOG_FILE, 0);
  } catch {
    // no log file (running in a terminal)
  }
}, 60 * 60_000).unref();
