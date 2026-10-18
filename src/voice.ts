import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";

// Voice in (Whisper, fully on this Mac) and voice out (macOS "say"), both via ffmpeg.
const run = promisify(execFile);
// Homebrew lives in /opt/homebrew on Apple Silicon and /usr/local on Intel; also check PATH.
const bin = (name: string) =>
  ["/opt/homebrew/bin", "/usr/local/bin", ...(process.env.PATH ?? "").split(":")]
    .map((d) => path.join(d, name))
    .find((p) => fs.existsSync(p));

function need(name: string, pkg: string): string {
  const found = bin(name);
  if (!found) throw new Error(`Voice needs ${pkg}, which isn't installed on the Mac running Blip. In Terminal there, run: brew install ${pkg}`);
  return found;
}
const tmpDir = path.join(config.dataDir, "voice");

export async function transcribe(audioFile: string): Promise<string> {
  if (!fs.existsSync(config.whisperModel)) throw new Error("The speech model is missing. On the Mac running Blip, run: ./blip.sh setup");
  const ffmpeg = need("ffmpeg", "ffmpeg");
  const whisper = need("whisper-cli", "whisper.cpp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const base = path.join(tmpDir, `in-${Date.now()}`);
  try {
    await run(ffmpeg, ["-y", "-loglevel", "error", "-i", audioFile, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", `${base}.wav`]);
    await run(whisper, ["-m", config.whisperModel, "-f", `${base}.wav`, "-l", "auto", "-nt", "-otxt", "-of", base], { timeout: 300_000 });
    return fs.readFileSync(`${base}.txt`, "utf8").trim();
  } finally {
    for (const ext of [".wav", ".txt"]) fs.rmSync(base + ext, { force: true });
  }
}

/** Returns an .ogg (Opus) file Telegram plays as a voice message. */
export async function speak(text: string): Promise<string> {
  fs.mkdirSync(tmpDir, { recursive: true });
  const base = path.join(tmpDir, `out-${Date.now()}`);
  const clean = text.replace(/[•*_#`]/g, "").slice(0, 2500);
  await run("/usr/bin/say", ["-o", `${base}.aiff`, clean], { timeout: 120_000 });
  await run(need("ffmpeg", "ffmpeg"), ["-y", "-loglevel", "error", "-i", `${base}.aiff`, "-c:a", "libopus", "-b:a", "32k", `${base}.ogg`]);
  fs.rmSync(`${base}.aiff`, { force: true });
  return `${base}.ogg`;
}
