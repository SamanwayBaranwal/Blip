// Golden tasks: starts a real Blip in a temporary folder on a cheap model (Haiku) and checks the flows people
// actually use, end to end. Mac input is only logged and the screen is a test pattern, so nothing on this Mac
// is touched. Needs Claude Code signed in on this Mac (or ANTHROPIC_API_KEY). Run: npm run test:golden
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { WebSocket } = createRequire(import.meta.url)("ws");
const only = process.argv.slice(2);

// ---------------------------------------------------------------- start a throwaway Blip
const home = fs.mkdtempSync(path.join(os.tmpdir(), "blip-golden-"));
const port = 8790 + Math.floor(Math.random() * 9);
fs.writeFileSync(path.join(home, ".env"), `WEB_PORT=${port}\nMODEL=claude-haiku-5-5\nFAST_MODEL=claude-haiku-5-5\nREVIEW_MODEL=claude-haiku-5-5\nEFFORT=low\nPROACTIVE_SCHEDULE=0 0 1 1 *\n`);
const env = {
  HOME: os.homedir(), USER: os.userInfo().username, LOGNAME: os.userInfo().username, PATH: process.env.PATH,
  BLIP_DATA_ROOT: home, BLIP_TEST_KEYCHAIN: "memory", BLIP_INPUT_DRYRUN: "1", BLIP_SCREEN_TEST: "1", BLIP_BROWSER_HEADLESS: "1", BLIP_FAKE_MAC_DATA: "1",
  ...(process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {}),
};
let log = "";
const server = spawn(process.execPath, [path.join(ROOT, "dist/main.js")], { env, cwd: ROOT });
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));
const stop = () => {
  server.kill();
  // Chrome may still be writing into the temporary folder for a moment after Blip stops.
  try {
    execFileSync("/usr/bin/pkill", ["-f", home]);
  } catch {}
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    console.log(`(left ${home} behind; it's in the system's temp folder)`);
  }
};
process.on("exit", stop);

const base = `http://localhost:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 60 && !log.includes("App running"); i++) await sleep(250);
if (!log.includes("App running")) throw new Error(`Blip didn't start:\n${log}`);
const code = fs.readFileSync(path.join(home, "data/app-access-code"), "utf8").trim();
const cookie = `blip=${code}`;

async function call(p, body, method) {
  const res = await fetch(`${base}/api${p}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { cookie, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 409) throw new Error(`${p} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}
const thread = async (bot) => (await call(`/thread/${bot}`)).messages;

/** Sends a message and waits for the task to end. `onCard(card) → value` answers cards; `during(run)` runs once while working. */
async function ask(bot, text, { onCard, during, timeout = 180_000 } = {}) {
  const before = new Set((await thread(bot)).map((m) => m.id));
  const started = Date.now();
  await call("/send", { botId: bot, text });
  const answered = new Set();
  let liveUpdates = 0, lastLive = "", fired = false;
  while (Date.now() - started < timeout) {
    const fresh = (await thread(bot)).filter((m) => !before.has(m.id));
    const run = fresh.find((m) => m.kind === "run");
    if (run?.run.live && run.run.live !== lastLive) {
      liveUpdates++;
      lastLive = run.run.live;
    }
    if (run && during && !fired && run.run.status === "running") {
      fired = true;
      await during(run);
    }
    for (const m of fresh) {
      if (m.kind === "card" && m.card.status === "pending" && !answered.has(m.id) && onCard) {
        answered.add(m.id);
        const answer = await onCard(m.card);
        if (answer) await call(`/card/${m.id}`, typeof answer === "string" ? { value: answer } : answer);
      }
    }
    if (run && !["running", "waiting"].includes(run.run.status)) {
      await sleep(300);
      const all = (await thread(bot)).filter((m) => !before.has(m.id));
      return {
        status: run.run.status,
        seconds: (Date.now() - started) / 1000,
        replies: all.filter((m) => m.kind === "text" && m.role === "bot").map((m) => m.text),
        cards: all.filter((m) => m.kind === "card").map((m) => m.card),
        liveUpdates,
      };
    }
    await sleep(150);
  }
  throw new Error(`timed out: ${text}`);
}

// ---------------------------------------------------------------- the golden tasks
const st = await call("/state");
const main = st.bots[0].id;
await call("/settings", { autoReview: false }, "PATCH"); // approvals come to us, no reviewer model
const second = (await call("/bots", { name: "Helper", job: "Second bot for tests" })).id;
for (const b of [main, second]) await call(`/bots/${b}`, { model: "haiku" }, "PATCH");

const tasks = {
  async "replies stream in, then the full reply lands"() {
    const r = await ask(main, "In about 80 words, explain what a stop-loss is. No tools.");
    expect(r.status === "done", `status ${r.status}`);
    expect(r.liveUpdates >= 2, `only ${r.liveUpdates} streaming updates`);
    expect(r.replies.join(" ").length > 200, "reply too short");
  },
  async "a warm chat remembers the last message"() {
    await ask(main, "Reply with just the word MARZIPAN.");
    const r = await ask(main, "Which word did you just say? One word.");
    expect(/marzipan/i.test(r.replies.join(" ")), r.replies.join(" | "));
  },
  async "a denied action doesn't run"() {
    const file = path.join(home, "workspace", "should-not-exist.txt");
    const r = await ask(main, `Run this exact shell command: echo hi > "${file}"`, { onCard: () => "deny" });
    expect(r.cards.length >= 1, "no approval card");
    expect(!fs.existsSync(file), "the denied command ran anyway");
  },
  async "Stop ends a long task quickly"() {
    const started = Date.now();
    const r = await ask(main, "Run the shell command `sleep 60` in the foreground (not in the background) and wait for it, then say done.", {
      onCard: () => "once",
      during: async () => {
        await sleep(4000);
        await call("/stop", { botId: main });
      },
    });
    expect(r.status === "stopped", `status ${r.status}: ${r.replies.join(" | ").slice(0, 200)}`);
    expect(Date.now() - started < 40_000, "took too long to stop");
  },
  async "secrets: saved by card, used by placeholder, never seen by the bot"() {
    const value = "golden-secret-7731";
    const r = await ask(second, "Ask me for a secret with request_secret (name: golden, why: testing). Then run exactly: echo {{secret:golden}} and tell me the output.", {
      onCard: (c) => (c.type === "secret" ? { value: "save", body: value } : "once"),
    });
    expect(r.cards.some((c) => c.type === "secret"), "no secret card");
    expect(r.cards.some((c) => /Use your secret/.test(c.title)), "using it didn't ask");
    expect(!r.replies.join(" ").includes(value), "the bot saw the secret");
    const files = fs.readdirSync(path.join(home, "data", "threads")).map((f) => fs.readFileSync(path.join(home, "data", "threads", f), "utf8"));
    expect(!files.some((t) => t.includes(value)), "the secret was saved in chat history");
  },
  async "memory search finds something from an old chat after New chat"() {
    await ask(main, "Remember this for later: my dentist is Dr. Okafor on Elm Street. Just say noted, don't save it to memory files.");
    await call(`/bots/${main}/fresh`, {});
    const r = await ask(main, "What's my dentist's name? Check your memory search.");
    expect(/okafor/i.test(r.replies.join(" ")), r.replies.join(" | "));
  },
  async "a webhook trigger starts a routine run with the data it was sent"() {
    const r = await ask(second, 'Use add_event_routine to create a routine named "Price ping" (when: webhook) whose prompt is: "Reply with the price from the event data, as: PRICE=<number>". Then tell me it is set.', { onCard: () => "once" });
    expect(r.status === "done", r.status);
    const routine = (await call("/routines")).find((x) => x.name === "Price ping");
    expect(routine?.hook, "no webhook link");
    const before = new Set((await thread(second)).map((m) => m.id));
    const res = await fetch(`${base}${routine.hook}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ price: 4170.5 }) });
    expect(res.status === 202, `webhook answered ${res.status}`);
    let text = "";
    for (let i = 0; i < 120 && !/PRICE=4170\.5/.test(text); i++) {
      await sleep(500);
      text = (await thread(second)).filter((m) => !before.has(m.id) && m.kind === "text").map((m) => m.text).join(" ");
    }
    expect(/PRICE=4170\.5/.test(text), text || "no reply after the webhook");
  },
  async "teach by demo: recording becomes key moments the bot works from"() {
    await call("/teach/start", { botId: second, title: "Check the colour bars" });
    expect((await call("/state")).teach.recording, "not recording");
    const ws = new WebSocket(`ws://localhost:${port}/api/remote`, { headers: { cookie } });
    await new Promise((r, j) => (ws.on("open", r), ws.on("error", j)));
    await sleep(2000);
    ws.send(JSON.stringify({ t: "pointer", a: "click", x: 0.3, y: 0.4 }));
    ws.send(JSON.stringify({ t: "type", text: "hunter2" }));
    ws.send(JSON.stringify({ t: "key", keys: "return" }));
    await sleep(6000);
    ws.close();
    const before = new Set((await thread(second)).map((m) => m.id));
    const stopped = await call("/teach/stop", { note: "Just testing" });
    expect(stopped.moments >= 3, `only ${stopped.moments} key moments`);
    let run;
    for (let i = 0; i < 240; i++) {
      await sleep(500);
      run = (await thread(second)).find((m) => !before.has(m.id) && m.kind === "run");
      if (run && !["running", "waiting"].includes(run.run.status)) break;
    }
    expect(run && /Learning/.test(run.run.label) && run.run.status === "done", run ? `${run.run.label}: ${run.run.status}` : "no run started");
    const text = (await thread(second)).filter((m) => !before.has(m.id) && m.kind === "text").map((m) => m.text).join(" ");
    expect(!text.includes("hunter2"), "typed text leaked to the bot");
    expect(text.length > 40, "the bot said nothing about the demo");
  },
  async "a proactive check-in runs read-only and stays quiet unless it finds something"() {
    const before = new Set((await thread(main)).map((m) => m.id));
    const { started } = await call("/proactive/run", {});
    expect(started, "check-in didn't start");
    let run;
    for (let i = 0; i < 240; i++) {
      await sleep(500);
      run = (await thread(main)).find((m) => !before.has(m.id) && m.kind === "run");
      if (run && !["running", "waiting"].includes(run.run.status)) break;
    }
    expect(run?.run.label === "Proactive check-in · read-only", run?.run.label ?? "no run");
    expect(run.run.status === "done", run.run.status);
    const fresh = (await thread(main)).filter((m) => !before.has(m.id));
    const cards = fresh.filter((m) => m.kind === "card");
    expect(cards.every((c) => c.card.type === "suggestion") && cards.length <= 2, JSON.stringify(cards.map((c) => c.card.title)));
  },
  async "the double-check confirms a file really got written"() {
    const r = await ask(main, 'Write a file called checks/banana.txt in the workspace containing exactly: BANANA-42. Use the Write tool. Then say done.', { onCard: () => "once" });
    expect(r.status === "done", r.status);
    let line = "";
    for (let i = 0; i < 180 && !line; i++) {
      await sleep(500);
      line = (await thread(main)).filter((m) => m.role === "system" && /^(Checked|Double-check failed):/.test(m.text ?? "")).at(-1)?.text ?? "";
    }
    expect(/^Checked:/.test(line), line || "no double-check line");
  },
  async "Mac apps: a bot reads the calendar directly, and the access check reports each app"() {
    const r = await ask(main, "What's on my calendar today? Use the calendar_events tool. One line.", { onCard: () => "once" });
    expect(/dentist/i.test(r.replies.join(" ")), r.replies.join(" | "));
    const check = await call("/check-mac", {});
    const failed = check.checks.filter((c) => !c.ok && !["Apple command line tools", "Voice messages", "Mouse and keyboard control"].includes(c.name));
    expect(!failed.length, failed.map((c) => `${c.name}: ${c.detail}`).join("; "));
  },
  async "work replay: a browser session becomes a clip linked from the task"() {
    const r = await ask(second, "Use the browser to open https://example.com, then open https://www.iana.org/help/example-domains, and tell me both page titles. Be brief.", { onCard: () => "once" });
    expect(r.status === "done", r.status);
    await call(`/bots/${second}/fresh`, {}); // ends the session, which finishes the recording
    let replay;
    for (let i = 0; i < 120 && !replay; i++) {
      await sleep(500);
      replay = (await thread(second)).filter((m) => m.kind === "run" && m.run.replay).at(-1)?.run.replay;
    }
    expect(replay, "no replay linked");
    const file = path.join(home, "workspace", replay);
    expect(fs.existsSync(file) && fs.statSync(file).size > 10_000, "replay file missing or empty");
  },
  async "two bots share the browser in turns"() {
    const q = "Use the browser to open https://example.com and tell me the page's main heading. Be brief.";
    const [a, b] = await Promise.all([ask(main, q, { onCard: () => "once" }), ask(second, q, { onCard: () => "once" })]);
    for (const r of [a, b]) expect(/example domain/i.test(r.replies.join(" ")), r.replies.join(" | ") || r.status);
  },
  async "a bot with its own browser browses at the same time, without waiting"() {
    await call(`/bots/${second}`, { ownBrowser: true }, "PATCH");
    const q = "Use the browser to open https://example.com and tell me the page's main heading. Be brief.";
    const waited = [];
    const watch = async (bot) => {
      const r = await ask(bot, q, { onCard: () => "once" });
      const run = (await thread(bot)).filter((m) => m.kind === "run").at(-1);
      if (run.run.steps.some((s) => /Waiting for the computer/.test(s.text))) waited.push(bot);
      return r;
    };
    const [a, b] = await Promise.all([watch(main), watch(second)]);
    await call(`/bots/${second}`, { ownBrowser: false }, "PATCH");
    for (const r of [a, b]) expect(/example domain/i.test(r.replies.join(" ")), r.replies.join(" | ") || r.status);
    expect(!waited.length, "a bot waited for the computer");
    expect(fs.existsSync(path.join(home, "data", "browser-profiles", second)), "no separate profile");
  },
  async "remote desktop: video frames out, input in"() {
    const ws = new WebSocket(`ws://localhost:${port}/api/remote`, { headers: { cookie } });
    let config = null, frames = 0;
    ws.on("message", (data, binary) => {
      if (binary) {
        frames++;
        ws.send(JSON.stringify({ t: "ack", seq: Buffer.from(data).readUInt32BE(1) }));
      } else if (JSON.parse(data.toString()).t === "config") config = JSON.parse(data.toString());
    });
    await new Promise((r, j) => (ws.on("open", r), ws.on("error", j)));
    ws.send(JSON.stringify({ t: "quality", w: 960, fps: 20, kbps: 700 }));
    await sleep(4000);
    ws.send(JSON.stringify({ t: "pointer", a: "click", x: 0.25, y: 0.75 }));
    await sleep(500);
    ws.close();
    expect(config?.codec?.startsWith("avc1."), "no video config");
    expect(frames >= 20, `only ${frames} frames in 4 s`);
    expect(log.includes("[input] click 0.250,0.750"), "input didn't arrive");
  },
  async "health check reports the parts"() {
    const h = await call("/health").catch(() => null);
    expect(h && typeof h.uptimeSeconds === "number", "no /api/health");
    const status = await (await fetch(`${base}/status`)).text();
    expect(/^Blip is running · up \d+m/.test(status), status);
  },
  async "Recover unsticks a busy bot, and it works again after"() {
    await call("/send", { botId: second, text: "Run the shell command `sleep 90` and then say done." });
    for (let i = 0; i < 40 && !(await call("/state")).bots.find((b) => b.id === second).running; i++) await sleep(250);
    const { steps } = await call("/recover", {});
    expect(steps.some((s) => /Stopped/.test(s)), steps.join("; "));
    const h = await call("/health");
    expect(h.tasks.running === 0 && h.engines.running === 0, JSON.stringify(h.engines));
    const r = await ask(second, "Reply with just the word PHOENIX.");
    expect(/phoenix/i.test(r.replies.join(" ")), r.replies.join(" | "));
  },
  async "nightly backup and self-test"() {
    const b = await call("/backup", {});
    expect(b.ok && fs.existsSync(b.file) && b.bytes > 0, JSON.stringify(b));
    const t = await call("/selftest", {});
    const failed = t.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
    expect(t.passed === t.total, failed.join("; "));
    const line = (await thread(main)).at(-1)?.text ?? "";
    expect(/^Self-test \d\d:\d\d · \d+\/\d+ passed\.$/.test(line), line);
  },
};

// ---------------------------------------------------------------- run them
let failed = 0;
function expect(ok, why) {
  if (!ok) throw new Error(why);
}
for (const [name, fn] of Object.entries(tasks)) {
  if (only.length && !only.some((o) => name.includes(o))) continue;
  const t0 = Date.now();
  try {
    await fn();
    console.log(`✔ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (error) {
    failed++;
    console.log(`✖ ${name}: ${error.message}`);
  }
}
console.log(failed ? `\n${failed} golden task(s) failed` : "\nAll golden tasks passed");
process.exit(failed ? 1 : 0);
