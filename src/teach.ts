import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { getBot } from "./bots.js";
import { config } from "./config.js";
import { addMessage, stateChanged } from "./hub.js";
import { runTask } from "./core.js";
import * as screen from "./screen.js";

// Teach by demo: the user does a task once on the Mac (at the Mac, or through remote control from the phone)
// while Blip records the screen. Then the key moments, plus the clicks and typing sent from the phone, go to
// the bot, which writes them up as a reusable skill and asks about anything it couldn't see.

const run = promisify(execFile);
const MAX_SECONDS = 10 * 60;
const MAX_FRAMES = 30;

type Recording = { botId: string; title: string; startedAt: number; dir: string; proc: ChildProcess; inputs: string[]; timer: NodeJS.Timeout };
let current: Recording | undefined;

export const teachStatus = () =>
  current ? { recording: true, botId: current.botId, title: current.title, startedAt: current.startedAt, maxSeconds: MAX_SECONDS } : { recording: false };

/** Notes what the user did through the remote view while recording (clicks and keys, never typed text). */
export function noteInput(what: string) {
  if (!current) return;
  const t = Math.round((Date.now() - current.startedAt) / 1000);
  if (current.inputs.length < 2000) current.inputs.push(`${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")} ${what}`);
}

export async function startTeaching(botId: string, title: string) {
  if (current) throw new Error("Already recording. Stop that one first.");
  const ff = screen.ffmpegPath();
  if (!ff) throw new Error("Recording needs ffmpeg on the Blip Mac: brew install ffmpeg");
  const dir = path.join(config.dataDir, "teach", String(Date.now()));
  fs.mkdirSync(dir, { recursive: true });
  const source = process.env.BLIP_SCREEN_TEST
    ? ["-re", "-f", "lavfi", "-i", "testsrc2=size=1440x900:rate=5"]
    : ["-f", "avfoundation", "-capture_cursor", "1", "-capture_mouse_clicks", "1", "-framerate", "5", "-i", `${await screen.captureDevice()}:none`];
  // Small and light: 2 frames a second at 1280 wide is plenty to see every step.
  const proc = spawn(ff, ["-hide_banner", "-loglevel", "error", ...source, "-t", String(MAX_SECONDS), "-vf", "fps=2,scale=1280:-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p", "-y", path.join(dir, "demo.mp4")], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  proc.on("error", () => {});
  const rec: Recording = { botId, title, startedAt: Date.now(), dir, proc, inputs: [], timer: setTimeout(() => void stopTeaching(), (MAX_SECONDS + 2) * 1000) };
  current = rec;
  proc.on("exit", () => {
    if (current === rec && Date.now() - rec.startedAt < 3000) {
      current = undefined; // it never really started (e.g. no screen-recording permission)
      stateChanged();
    }
  });
  stateChanged();
  return teachStatus();
}

/** Stops recording, picks the key frames, and hands everything to the bot to turn into a skill. */
export async function stopTeaching(note = "") {
  const rec = current;
  if (!rec) throw new Error("Nothing is being recorded.");
  current = undefined;
  clearTimeout(rec.timer);
  stateChanged();
  rec.proc.stdin?.end("q"); // ffmpeg finishes the file properly when told to quit
  await new Promise((r) => (rec.proc.exitCode !== null ? r(null) : rec.proc.once("exit", r)));
  const video = path.join(rec.dir, "demo.mp4");
  if (!fs.existsSync(video) || fs.statSync(video).size < 1000) {
    throw new Error("Nothing was recorded. On the Blip Mac, check System Settings → Privacy & Security → Screen & System Audio Recording → node.");
  }
  const seconds = Math.round((Date.now() - rec.startedAt) / 1000);

  // Key moments: whenever the screen changes noticeably, plus one every 3 s, then thinned out evenly.
  const frames = path.join(rec.dir, "frames");
  fs.mkdirSync(frames);
  await run(screen.ffmpegPath()!, [
    "-hide_banner", "-loglevel", "error", "-i", video,
    "-vf", "select='eq(n\\,0)+gt(scene\\,0.05)+not(mod(n\\,6))',scale=1024:-2", "-fps_mode", "vfr", "-frame_pts", "1", "-q:v", "5",
    path.join(frames, "f-%06d.jpg"),
  ]);
  let picked = fs.readdirSync(frames).filter((f) => f.endsWith(".jpg")).sort();
  if (picked.length > MAX_FRAMES) picked = Array.from({ length: MAX_FRAMES }, (_, i) => picked[Math.round((i * (picked.length - 1)) / (MAX_FRAMES - 1))]!);
  const at = (f: string) => {
    const t = Math.round(Number(/f-(\d+)/.exec(f)?.[1] ?? 0) / 2); // frame number at 2 fps → seconds
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
  };

  const b = getBot(rec.botId);
  if (!b) throw new Error("That bot was deleted.");
  const text = `[Teach by demo] I just showed you how to do a task on this Mac: "${rec.title || "untitled"}" (${Math.floor(seconds / 60)}m ${seconds % 60}s). Below are ${picked.length} key moments from the screen recording, in order, each labelled with its time. Mouse clicks show as rings.${rec.inputs.length ? `\nWhat I did through remote control (time · action):\n${rec.inputs.slice(0, 400).join("\n")}` : ""}${note ? `\nMy notes: ${note}` : ""}

Turn this into a reusable skill:
1. Work out the steps, the apps and sites used, the inputs that change each time (names, dates, amounts), and any decisions I made.
2. Ask me, in one short message, about anything you couldn't see or that looked like a choice.
3. Then save it with save_skill: numbered steps, inputs to ask for, where things are on screen, how to check it worked, and edge cases.
Passwords and codes I typed are never shown to you; for those steps, use request_takeover or saved secrets.`;
  const content = [
    { type: "text" as const, text },
    ...picked.flatMap((f) => [
      { type: "text" as const, text: `Moment at ${at(f)}:` },
      { type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data: fs.readFileSync(path.join(frames, f)).toString("base64") } },
    ]),
  ];
  addMessage({ botId: b.id, role: "user", kind: "text", text: `Recorded a demo: "${rec.title || "untitled"}" (${Math.floor(seconds / 60)}m ${seconds % 60}s, ${picked.length} key moments). Turn it into a skill.` });
  runTask(b, content, `Teach by demo: ${rec.title}`, { label: `Learning "${rec.title || "demo"}"`, chat: true });
  // The recording itself isn't kept: once the bot has the key moments, it's deleted.
  setTimeout(() => fs.rmSync(rec.dir, { recursive: true, force: true }), 60_000).unref();
  return { seconds, moments: picked.length };
}
