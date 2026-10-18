import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

// Remote control for the app's Computer view, built to feel like Chrome Remote Desktop:
// a live video stream of the screen (ffmpeg screen capture → JPEG frames) and fast mouse/keyboard input.
// Coordinates from the app are normalized (0..1 across the screen), so they work at any stream size.

const run = promisify(execFile);
const findBin = (name: string) =>
  ["/opt/homebrew/bin", "/usr/local/bin", ...(process.env.PATH ?? "").split(":")].map((d) => path.join(d, name)).find((p) => fs.existsSync(p));
const CLICLICK = findBin("cliclick") ?? "cliclick";

// ---------------------------------------------------------------- screen size (in points, what clicks use)
let points: { width: number; height: number; at: number } | undefined;

export async function screenPoints() {
  if (points && Date.now() - points.at < 60_000) return points;
  const { stdout } = await run("/usr/bin/osascript", [
    "-l", "JavaScript", "-e", 'ObjC.import("AppKit"); var f = $.NSScreen.mainScreen.frame; f.size.width + "x" + f.size.height',
  ]);
  const [width, height] = stdout.trim().split("x").map(Number);
  points = { width: width!, height: height!, at: Date.now() };
  return points;
}

const clamp = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
async function toPoint(nx: number, ny: number) {
  const p = await screenPoints();
  return `${Math.round(clamp(nx) * (p.width - 1))},${Math.round(clamp(ny) * (p.height - 1))}`;
}

// ---------------------------------------------------------------- input
export type PointerAction = "move" | "click" | "double" | "right" | "down" | "drag" | "up";

/** Mouse input at normalized coordinates. "down"/"drag"/"up" press, move and release for dragging. */
/** BLIP_INPUT_DRYRUN=1 logs input instead of performing it (for testing the remote view safely). */
const dryRun = (what: string) => (process.env.BLIP_INPUT_DRYRUN ? (console.log("[input]", what), true) : false);

export async function pointer(action: PointerAction, nx: number, ny: number) {
  if (dryRun(`${action} ${clamp(nx).toFixed(3)},${clamp(ny).toFixed(3)}`)) return;
  const at = await toPoint(nx, ny);
  const verb = { move: "m", click: "c", double: "dc", right: "rc", down: "dd", drag: "dm", up: "du" }[action];
  await run(CLICLICK, [`${verb}:${at}`]);
}

/** Real scroll-wheel events (pixels; positive dy scrolls up) via the CoreGraphics bridge in JavaScript for Automation. */
export async function scrollWheel(dx: number, dy: number) {
  if (dryRun(`scroll ${Math.round(dx)},${Math.round(dy)}`)) return;
  const vertical = Math.max(-2000, Math.min(2000, Math.round(dy)));
  const horizontal = Math.max(-2000, Math.min(2000, Math.round(dx)));
  await run("/usr/bin/osascript", [
    "-l", "JavaScript", "-e",
    `ObjC.import("CoreGraphics"); var e = $.CGEventCreateScrollWheelEvent2(null, 0, 2, ${vertical}, ${horizontal}, 0); $.CGEventPost(0, e);`,
  ]);
}

// ---------------------------------------------------------------- video stream
type Viewer = { write: (frame: Buffer) => boolean; busy: boolean };
const viewers = new Set<Viewer>();
let ffmpeg: ChildProcess | undefined;
let streamKey = "";
let lastError = "";
let stopTimer: NodeJS.Timeout | undefined;

async function screenDevice(ff: string): Promise<string> {
  // ffmpeg lists devices on stderr and exits non-zero; we only need the "Capture screen 0" index.
  const out = await run(ff, ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""]).catch((e) => e as { stderr?: string });
  const idx = /\[(\d+)\] Capture screen 0/.exec(String((out as { stderr?: string }).stderr ?? ""))?.[1];
  if (!idx) throw new Error("No screen found to stream.");
  return idx;
}

function startFfmpeg(ff: string, device: string, width: number, fps: number) {
  const source = process.env.BLIP_SCREEN_TEST
    ? ["-re", "-f", "lavfi", "-i", `testsrc2=size=1440x900:rate=${fps}`] // for testing without screen permission
    : ["-f", "avfoundation", "-capture_cursor", "1", "-capture_mouse_clicks", "1", "-framerate", "30", "-i", `${device}:none`];
  const proc = spawn(ff, [
    "-hide_banner", "-loglevel", "error", ...source,
    "-vf", `fps=${fps},scale=${width}:-2:flags=fast_bilinear`, "-q:v", "7", "-f", "mjpeg", "pipe:1",
  ]);
  let pending: Buffer = Buffer.alloc(0);
  proc.stdout.on("data", (chunk: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    // Split concatenated JPEGs on their end marker (FFD9) followed by the next start marker (FFD8).
    for (;;) {
      const start = pending.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) return void (pending = Buffer.alloc(0));
      const end = pending.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) return void (pending = pending.subarray(start));
      const frame = pending.subarray(start, end + 2);
      pending = pending.subarray(end + 2);
      for (const v of viewers) if (!v.busy) v.busy = !v.write(frame); // a slow phone skips frames instead of lagging behind
    }
  });
  proc.stderr.on("data", (d: Buffer) => (lastError = d.toString().trim().split("\n").pop() ?? lastError));
  proc.on("error", (error) => (lastError = error.message)); // without a listener a failed spawn would crash Blip
  proc.on("exit", () => {
    if (ffmpeg === proc) ffmpeg = undefined;
  });
  return proc;
}

function stopFfmpeg() {
  ffmpeg?.kill("SIGTERM");
  ffmpeg = undefined; // a new viewer starts a fresh one instead of joining one that's shutting down
  streamKey = "";
}

let device: Promise<string> | undefined; // the screen's capture index, looked up once
let starting: Promise<void> = Promise.resolve(); // one start at a time, so two viewers never spawn two ffmpegs

/** Adds a viewer to the shared screen stream (one ffmpeg for everyone). Returns an unsubscribe function. */
export async function watchScreen(opts: { width: number; fps: number }, viewer: Viewer): Promise<() => void> {
  const ff = findBin("ffmpeg");
  if (!ff) throw new Error("Live view needs ffmpeg on the Mac running Blip: brew install ffmpeg");
  const width = Math.max(640, Math.min(1920, Math.round(opts.width / 2) * 2));
  const fps = Math.max(2, Math.min(20, Math.round(opts.fps)));
  const key = `${width}x${fps}`;
  clearTimeout(stopTimer);
  const start = starting.then(async () => {
    if (ffmpeg && streamKey === key) return;
    stopFfmpeg();
    lastError = "";
    device ??= screenDevice(ff).catch((error) => {
      device = undefined;
      throw error;
    });
    const index = process.env.BLIP_SCREEN_TEST ? "" : await device;
    ffmpeg = startFfmpeg(ff, index, width, fps);
    streamKey = key;
  });
  starting = start.catch(() => {});
  await start;
  clearTimeout(stopTimer);
  viewers.add(viewer);
  let left = false;
  return () => {
    if (left) return;
    left = true;
    viewers.delete(viewer);
    clearTimeout(stopTimer);
    if (!viewers.size) stopTimer = setTimeout(stopFfmpeg, 3000);
  };
}

export const streamError = () => lastError;
