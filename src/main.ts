import fs from "node:fs";
import path from "node:path";
import { ensureDefaultBot } from "./bots.js";
import { config } from "./config.js";
import { stopCurrent, welcome } from "./core.js";
import { startRoutines } from "./routines.js";
import { save, state } from "./store.js";
import { startTelegram } from "./telegram-app.js";
import { bot as telegram } from "./telegram.js";
import { accessCode, startWeb } from "./web.js";

ensureDefaultBot();
const sharedNotes = path.join(config.workspace, "CLAUDE.md");
if (!fs.existsSync(sharedNotes)) fs.writeFileSync(sharedNotes, "# Shared notes about the user\n\n## About the user\n");

startRoutines();
startWeb();
await startTelegram().catch((error) => console.error("Telegram failed to start (the app still works):", error));

if (!state.onboarded) {
  welcome(); // first start: no blank chat
  state.onboarded = true;
  save();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stopCurrent();
    void (telegram?.stop() ?? Promise.resolve()).finally(() => process.exit(0));
  });
}
console.log(`Ready. Bots: ${state.bots.map((b) => b.name).join(", ")}. Model ${config.model}. Open http://localhost:${config.webPort}/login?code=${accessCode}`);
