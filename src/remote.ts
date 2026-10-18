import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { WebSocket, WebSocketServer } from "ws";
import { ROOT } from "./config.js";
import * as mac from "./mac.js";
import * as screen from "./screen.js";

// Remote desktop in the style of Chrome Remote Desktop: one WebSocket per viewer carries
//   • video out: the screen as hardware-encoded H.264 (VideoToolbox), one frame per message, decoded on the
//     phone with WebCodecs. A few hundred KB/s instead of megabytes of JPEGs, and only what changed is sent.
//   • input in: pointer, scroll, keys and text, handed to an always-running native helper (mac-app/input.swift)
//     instead of starting a program per click.
//   • clipboard both ways, and a ping so the app can show the real delay.

const run = promisify(execFile);
const dryRun = () => !!process.env.BLIP_INPUT_DRYRUN;
const UTF8 = { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" };

// ================================================================ input helper
const HELPER_SRC = path.join(ROOT, "mac-app", "input.swift");
const HELPER_BIN = path.join(ROOT, "bin", "blip-input");
let helper: ChildProcess | undefined;
let trusted: boolean | undefined; // macOS Accessibility permission, as the helper sees it
let building: Promise<void> | undefined;

/** Builds the helper when it's missing or older than its source (needs Apple's command line tools). */
function buildHelper() {
  building ??= (async () => {
    try {
      const fresh = fs.existsSync(HELPER_BIN) && fs.statSync(HELPER_BIN).mtimeMs >= fs.statSync(HELPER_SRC).mtimeMs;
      if (fresh) return;
      // Without the command line tools, /usr/bin/swiftc pops up an install dialog: check first, never surprise.
      await run("/usr/bin/xcode-select", ["-p"]);
      fs.mkdirSync(path.dirname(HELPER_BIN), { recursive: true });
      await run("/usr/bin/swiftc", ["-O", HELPER_SRC, "-o", HELPER_BIN], { timeout: 180_000 });
      console.log("Built the remote-control input helper.");
    } catch (error) {
      console.error("Remote input helper not built (falling back to cliclick):", (error as Error).message.split("\n")[0]);
    }
  })();
  return building;
}

function startHelper() {
  if (helper && helper.exitCode === null) return helper;
  if (!fs.existsSync(HELPER_BIN)) return undefined;
  const proc = spawn(HELPER_BIN, [], { stdio: ["pipe", "pipe", "ignore"] });
  proc.on("error", () => {});
  proc.stdin.on("error", () => {});
  proc.stdout.on("data", (d: Buffer) => {
    const ready = /ready (\d)/.exec(d.toString());
    if (ready) trusted = ready[1] === "1";
  });
  proc.on("exit", () => {
    if (helper === proc) helper = undefined;
  });
  helper = proc;
  return proc;
}

export type InputMsg =
  | { t: "pointer"; a: "move" | "down" | "drag" | "up" | "click" | "double" | "right"; x: number; y: number }
  | { t: "wheel"; dx: number; dy: number }
  | { t: "type"; text: string }
  | { t: "key"; keys: string };

const n = (v: unknown) => (Number.isFinite(Number(v)) ? Math.min(1, Math.max(0, Number(v))) : 0);
let fallbackChain: Promise<unknown> = Promise.resolve();

/** Performs one input event on the Mac, in order. */
export function input(m: InputMsg) {
  if (dryRun()) {
    const what = m.t === "pointer" ? `${m.a} ${n(m.x).toFixed(3)},${n(m.y).toFixed(3)}` : m.t === "wheel" ? `scroll ${Math.round(m.dx)},${Math.round(m.dy)}` : m.t === "type" ? `type ${JSON.stringify(m.text)}` : `key ${m.keys}`;
    return void console.log("[input]", what);
  }
  const h = startHelper();
  if (h?.stdin?.writable) {
    const line =
      m.t === "pointer"
        ? { move: `m ${n(m.x)} ${n(m.y)}`, drag: `m ${n(m.x)} ${n(m.y)}`, down: `d l ${n(m.x)} ${n(m.y)}`, up: `u l ${n(m.x)} ${n(m.y)}`, click: `c l 1 ${n(m.x)} ${n(m.y)}`, double: `c l 2 ${n(m.x)} ${n(m.y)}`, right: `c r 1 ${n(m.x)} ${n(m.y)}` }[m.a]
        : m.t === "wheel" ? `w ${Math.round(Number(m.dx) || 0)} ${Math.round(Number(m.dy) || 0)}`
        : m.t === "type" ? `t ${Buffer.from(String(m.text).slice(0, 5000)).toString("base64")}`
        : `k ${String(m.keys).replace(/\s+/g, "").slice(0, 60)}`;
    if (line) h.stdin?.write(`${line}\n`);
    return;
  }
  // No helper (no command line tools): the slower, one-program-per-event way.
  fallbackChain = fallbackChain
    .then(() => {
      if (m.t === "pointer") return screen.pointer(m.a, n(m.x), n(m.y));
      if (m.t === "wheel") return screen.scrollWheel(Number(m.dx) || 0, Number(m.dy) || 0);
      if (m.t === "type") return mac.typeText(String(m.text).slice(0, 5000));
      return mac.pressKeys(String(m.keys).slice(0, 60));
    })
    .catch((error) => console.error("Remote input failed:", (error as Error).message));
}

export const inputBlocked = () => trusted === false && !dryRun();

// ================================================================ clipboard
export async function getClipboard() {
  return (await run("/usr/bin/pbpaste", [], { env: UTF8 })).stdout.slice(0, 100_000);
}
export async function setClipboard(text: string) {
  await run("/bin/sh", ["-c", 'printf %s "$1" | pbcopy', "sh", text.slice(0, 100_000)], { env: UTF8 });
}

// ================================================================ video
export type VideoConfig = { codec: string; description: string; width: number; height: number };
// Frames sent but not yet confirmed by the phone. Delay can't pile up in the network: when the oldest one is
// unconfirmed for too long, the link is full, so frames are skipped until it drains (then a fresh keyframe).
type VideoViewer = { ws: WebSocket; needKey: boolean; drops: number[]; inFlight: { seq: number; at: number }[] };
const MAX_DELAY_MS = 350;
type Encoder = {
  key: string;
  proc?: ChildProcess;
  init?: VideoConfig;
  viewers: Set<VideoViewer>;
  error?: string;
  stopTimer?: NodeJS.Timeout;
};
const encoders = new Map<string, Encoder>();
let seq = 0;

function encoderArgs(device: string, w: number, fps: number, kbps: number, hardware: boolean) {
  const source = process.env.BLIP_SCREEN_TEST
    ? ["-re", "-f", "lavfi", "-i", `testsrc2=size=1440x900:rate=${fps}`]
    : ["-f", "avfoundation", "-capture_cursor", "1", "-framerate", fps > 30 ? "60" : "30", "-i", `${device}:none`];
  const rate = ["-b:v", `${kbps}k`, "-maxrate", `${Math.round(kbps * 1.5)}k`, "-bufsize", `${kbps}k`, "-bf", "0", "-g", String(fps)];
  const codec = hardware
    ? ["-c:v", "h264_videotoolbox", "-realtime", "1", "-allow_sw", "1", "-profile:v", "main", ...rate]
    : ["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "main", ...rate];
  return [
    "-hide_banner", "-loglevel", "error", ...source,
    "-vf", `fps=${fps},scale=${w}:-2:flags=fast_bilinear,format=nv12`, ...codec,
    // Fragmented MP4 with one frame per fragment: exact frame boundaries with no extra delay.
    "-f", "mp4", "-movflags", "frag_every_frame+empty_moov+default_base_moof", "-flush_packets", "1", "pipe:1",
  ];
}

function send(v: VideoViewer, data: Buffer | string) {
  if (v.ws.readyState === WebSocket.OPEN) v.ws.send(data);
}

/** Splits ffmpeg's fragmented MP4 into the decoder setup (avcC) and one message per frame. */
function startEncoder(enc: Encoder, device: string, w: number, fps: number, kbps: number, hardware = true) {
  console.log(`Remote view: ${w}px, ${fps} fps, ${kbps} kbps (${hardware ? "hardware" : "software"} H.264)`);
  const proc = spawn(screen.ffmpegPath()!, encoderArgs(device, w, fps, kbps, hardware));
  enc.proc = proc;
  let buf: Buffer = Buffer.alloc(0);
  let gotFrame = false;
  proc.stdout.on("data", (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 8) return;
      const size = buf.readUInt32BE(0);
      if (size < 8) return void proc.kill(); // not what we expect: give up rather than misparse
      if (buf.length < size) return;
      const box = buf.subarray(0, size);
      const type = box.toString("latin1", 4, 8);
      buf = buf.subarray(size);
      if (type === "moov") {
        const a = box.indexOf("avcC");
        const v = box.indexOf("avc1");
        if (a < 0 || v < 0) continue;
        const avcc = box.subarray(a + 4, a - 4 + box.readUInt32BE(a - 4));
        enc.init = {
          codec: `avc1.${avcc.subarray(1, 4).toString("hex")}`,
          description: avcc.toString("base64"),
          width: box.readUInt16BE(v + 4 + 24),
          height: box.readUInt16BE(v + 4 + 26),
        };
        const msg = JSON.stringify({ t: "config", ...enc.init });
        for (const viewer of enc.viewers) send(viewer, msg);
      } else if (type === "mdat") {
        gotFrame = true;
        const frame = box.subarray(8);
        let key = false;
        for (let o = 0; o + 4 < frame.length; ) {
          const len = frame.readUInt32BE(o);
          if ((frame[o + 4]! & 31) === 5) key = true;
          o += 4 + len;
        }
        const frameSeq = seq++ >>> 0;
        const head = Buffer.alloc(5);
        head[0] = key ? 1 : 0;
        head.writeUInt32BE(frameSeq, 1);
        const msg = Buffer.concat([head, frame]);
        const now = Date.now();
        for (const viewer of enc.viewers) {
          // A viewer that can't keep up skips ahead to the next keyframe instead of falling further behind.
          const oldest = viewer.inFlight[0];
          const congested = (oldest && now - oldest.at > MAX_DELAY_MS) || viewer.inFlight.length > 60 || viewer.ws.bufferedAmount > 1_000_000;
          if (congested) {
            if (!viewer.needKey) viewer.drops.push(now);
            viewer.needKey = true;
            continue;
          }
          if (viewer.needKey && !key) continue;
          viewer.needKey = false;
          viewer.inFlight.push({ seq: frameSeq, at: now });
          send(viewer, msg);
        }
      }
    }
  });
  proc.stderr.on("data", (d: Buffer) => (enc.error = d.toString().trim().split("\n").pop() || enc.error));
  proc.on("error", (e) => (enc.error = e.message));
  proc.on("exit", () => {
    if (enc.proc !== proc) return;
    enc.proc = undefined;
    // The hardware encoder can be unavailable (some Macs, some sessions): fall back to software once.
    if (hardware && !gotFrame && enc.viewers.size) {
      console.error("Hardware video encoder failed, using software:", enc.error);
      return startEncoder(enc, device, w, fps, kbps, false);
    }
    const msg = JSON.stringify({ t: "error", msg: screenError(enc.error) });
    for (const viewer of enc.viewers) send(viewer, msg);
    encoders.delete(enc.key);
  });
}

const screenError = (raw?: string) =>
  /not permitted|permission|denied|-12782|1007/i.test(raw ?? "")
    ? "macOS blocked screen capture. On the Blip Mac: System Settings → Privacy & Security → Screen & System Audio Recording → turn on node, then ./blip.sh restart"
    : raw || "The screen stream stopped.";

let deviceIndex: Promise<string> | undefined;

/** Subscribes a viewer to the video at this quality (one shared encoder per quality). Returns an unsubscribe. */
async function watchVideo(viewer: VideoViewer, q: { w: number; fps: number; kbps: number }) {
  if (!screen.ffmpegPath()) throw new Error("Live view needs ffmpeg on the Mac running Blip: brew install ffmpeg");
  const w = Math.max(640, Math.min(2560, Math.round((Number(q.w) || 1280) / 2) * 2));
  const fps = Math.max(5, Math.min(60, Math.round(Number(q.fps) || 30)));
  const kbps = Math.max(300, Math.min(12_000, Math.round(Number(q.kbps) || 2500)));
  const key = `${w}x${fps}@${kbps}`;
  let enc = encoders.get(key);
  if (!enc) {
    enc = { key, viewers: new Set() };
    encoders.set(key, enc);
    deviceIndex ??= screen.captureDevice().catch((error) => {
      deviceIndex = undefined;
      throw error;
    });
    const device = process.env.BLIP_SCREEN_TEST ? "" : await deviceIndex.catch((error) => {
      encoders.delete(key);
      throw error;
    });
    startEncoder(enc, device, w, fps, kbps);
  }
  clearTimeout(enc.stopTimer);
  enc.viewers.add(viewer);
  viewer.needKey = true;
  viewer.inFlight = [];
  if (enc.init) send(viewer, JSON.stringify({ t: "config", ...enc.init }));
  const e = enc;
  return () => {
    e.viewers.delete(viewer);
    if (e.viewers.size) return;
    e.stopTimer = setTimeout(() => {
      if (e.viewers.size) return;
      e.proc?.kill("SIGTERM");
      e.proc = undefined;
      encoders.delete(e.key);
    }, 3000);
  };
}

// ================================================================ the WebSocket
export function attachRemote(server: Server, signedIn: (req: IncomingMessage) => boolean) {
  void buildHelper().then(() => startHelper());
  const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/api/remote")) return socket.destroy();
    if (!signedIn(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => connection(ws));
  });
}

function connection(ws: WebSocket) {
  const viewer: VideoViewer = { ws, needKey: true, drops: [], inFlight: [] };
  let leave: (() => void) | undefined;
  let switching = Promise.resolve();
  let warnedBlocked = false;
  const reply = (m: Record<string, unknown>) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));

  // Tells the app when frames had to be skipped, so Auto quality can step down.
  const health = setInterval(() => {
    const now = Date.now();
    viewer.drops = viewer.drops.filter((t) => now - t < 5000);
    reply({ t: "health", drops: viewer.drops.length, buffered: ws.bufferedAmount });
  }, 2000);

  ws.on("message", (raw, isBinary) => {
    if (isBinary) return;
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (m.t) {
      case "quality":
        switching = switching.then(async () => {
          leave?.();
          leave = undefined;
          if (ws.readyState !== WebSocket.OPEN) return;
          try {
            leave = await watchVideo(viewer, m as { w: number; fps: number; kbps: number });
            if (ws.readyState !== WebSocket.OPEN) leave();
          } catch (error) {
            reply({ t: "error", msg: (error as Error).message });
          }
        });
        break;
      case "pointer":
      case "wheel":
      case "type":
      case "key":
        if (inputBlocked() && !warnedBlocked) {
          warnedBlocked = true;
          reply({ t: "error", msg: "macOS blocked control. On the Blip Mac: System Settings → Privacy & Security → Accessibility → turn on node, then ./blip.sh restart" });
        }
        input(m as InputMsg);
        break;
      case "clip-get":
        getClipboard().then((text) => reply({ t: "clip", text }), (e) => reply({ t: "error", msg: e.message }));
        break;
      case "clip-set":
        setClipboard(String(m.text ?? "")).then(() => reply({ t: "clip-set" }), (e) => reply({ t: "error", msg: e.message }));
        break;
      case "ack": {
        const upTo = Number(m.seq);
        viewer.inFlight = viewer.inFlight.filter((f) => f.seq > upTo);
        break;
      }
      case "ping":
        reply({ t: "pong", at: m.at });
        break;
    }
  });
  ws.on("close", () => {
    clearInterval(health);
    void switching.then(() => leave?.());
  });
  ws.on("error", () => {});
}
