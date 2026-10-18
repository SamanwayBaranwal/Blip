import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import { screenPoints as cachedScreenPoints } from "./screen.js";

// Native Mac control ("computer use") with screencapture + cliclick. Coordinates the model sees are
// pixels in the downscaled screenshot; we convert them to screen points before clicking.
const run = promisify(execFile);
const CLICLICK = ["/opt/homebrew/bin/cliclick", "/usr/local/bin/cliclick"].find((p) => fs.existsSync(p)) ?? "cliclick";
const SHOT_MAX = 1280;
let scale = 1;

// Screen size in points, cached for a minute (asking macOS on every frame made the live view slow).
const screenPoints = cachedScreenPoints;

async function capture(file: string, args: string[]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    await run("/usr/sbin/screencapture", ["-x", ...args, file]);
  } catch {
    // fall through to the check below
  }
  if (!fs.existsSync(file)) {
    throw new Error("macOS blocked the screenshot. Turn on 'node' under System Settings → Privacy & Security → Screen & System Audio Recording, then run: ~/Blip/blip.sh restart");
  }
}

/** Full-resolution PNG for sending to the phone. */
export async function screenshotForPhone(): Promise<string> {
  const target = path.join(config.workspace, "screenshots", `mac-${Date.now()}.png`);
  await capture(target, []);
  return target;
}

/** Downscaled JPEG for the model, plus the coordinate system it should use. */
export async function screenshotForModel(): Promise<{ file: string; width: number; height: number }> {
  const file = path.join(config.workspace, "screenshots", `view-${Date.now()}.jpg`);
  await capture(file, ["-t", "jpg"]);
  await run("/usr/bin/sips", ["-Z", String(SHOT_MAX), file]);
  const { stdout } = await run("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", file]);
  const width = Number(/pixelWidth: (\d+)/.exec(stdout)?.[1]);
  const height = Number(/pixelHeight: (\d+)/.exec(stdout)?.[1]);
  scale = (await screenPoints()).width / width;
  return { file, width, height };
}

// Live view for the app's Computer panel: an in-memory JPEG, cached briefly so several viewers share a capture.
let lastView: { at: number; data: Buffer; width: number; height: number } | undefined;
let capturing: Promise<{ data: Buffer; width: number; height: number }> | undefined;

export async function liveView(): Promise<{ data: Buffer; width: number; height: number }> {
  if (lastView && Date.now() - lastView.at < 700) return lastView;
  capturing ??= (async () => {
    const file = path.join(config.dataDir, "live-view.jpg");
    try {
      await capture(file, ["-t", "jpg"]);
      await run("/usr/bin/sips", ["-Z", String(SHOT_MAX), "-s", "formatOptions", "70", file]);
      const { stdout } = await run("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", file]);
      const width = Number(/pixelWidth: (\d+)/.exec(stdout)?.[1]);
      const height = Number(/pixelHeight: (\d+)/.exec(stdout)?.[1]);
      scale = (await screenPoints()).width / width;
      lastView = { at: Date.now(), data: fs.readFileSync(file), width, height };
      return lastView;
    } finally {
      fs.rmSync(file, { force: true });
      capturing = undefined;
    }
  })();
  return capturing;
}

const point = (x: number, y: number) => `${Math.round(x * scale)},${Math.round(y * scale)}`;

export async function click(x: number, y: number, kind: "left" | "right" | "double") {
  const verb = kind === "double" ? "dc" : kind === "right" ? "rc" : "c";
  await run(CLICLICK, ["-e", "40", `${verb}:${point(x, y)}`]);
}

export async function typeText(text: string) {
  if (process.env.BLIP_INPUT_DRYRUN) return void console.log("[input] type", JSON.stringify(text));
  // cliclick types ASCII reliably; for anything else paste via the clipboard.
  if (/^[\x20-\x7E]*$/.test(text)) {
    await run(CLICLICK, ["-e", "10", `t:${text}`]);
  } else {
    // pbcopy needs a UTF-8 locale or "é", "’" and emoji come out garbled. The old clipboard is put back after,
    // so typed text (which may be private) isn't left on it.
    const env = { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" };
    const previous = await run("/usr/bin/pbpaste", [], { env }).then((r) => r.stdout, () => undefined);
    await run("/bin/sh", ["-c", 'printf %s "$1" | pbcopy', "sh", text], { env });
    await pressKeys("cmd+v");
    setTimeout(() => {
      void run("/bin/sh", ["-c", 'printf %s "$1" | pbcopy', "sh", previous ?? ""], { env }).catch(() => {});
    }, 600);
  }
}

const MODIFIERS = new Set(["cmd", "ctrl", "alt", "shift", "fn"]);
const ALIASES: Record<string, string> = { command: "cmd", control: "ctrl", option: "alt", opt: "alt", enter: "return", escape: "esc", backspace: "delete" };

/** "cmd+space", "return", "cmd+shift+4", "arrow-down" */
export async function pressKeys(combo: string) {
  if (process.env.BLIP_INPUT_DRYRUN) return void console.log("[input] key", combo);
  const parts = combo.toLowerCase().split("+").map((p) => ALIASES[p.trim()] ?? p.trim()).filter(Boolean);
  const mods = parts.filter((p) => MODIFIERS.has(p));
  const key = parts.find((p) => !MODIFIERS.has(p));
  const args: string[] = [];
  if (mods.length) args.push(`kd:${mods.join(",")}`);
  if (key) args.push(key.length === 1 ? `t:${key}` : `kp:${key}`);
  if (mods.length) args.push(`ku:${mods.join(",")}`);
  await run(CLICLICK, ["-e", "40", ...args]);
}

export async function scroll(direction: "up" | "down", pages: number) {
  const key = direction === "down" ? "kp:page-down" : "kp:page-up";
  await run(CLICLICK, ["-e", "120", ...Array(Math.min(Math.max(pages, 1), 10)).fill(key)]);
}

export async function openApp(app: string) {
  await run("/usr/bin/open", ["-a", app]);
}
