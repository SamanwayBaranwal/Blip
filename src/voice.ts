import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";

// Voice in (Whisper, fully on this Mac) and voice out (macOS "say"), both via ffmpeg.
const run = promisify(execFile);
const bin = (name: string) => ["/opt/homebrew/bin", "/usr/local/bin"].map((d) => path.join(d, name)).find((p) => fs.existsSync(p)) ?? name;
const tmpDir = path.join(config.dataDir, "voice");

export async function transcribe(audioFile: string): Promise<string> {
  if (!fs.existsSync(config.whisperModel)) throw new Error("Speech model missing (models/ggml-small.bin).");
  fs.mkdirSync(tmpDir, { recursive: true });
  const base = path.join(tmpDir, `in-${Date.now()}`);
  try {
    await run(bin("ffmpeg"), ["-y", "-loglevel", "error", "-i", audioFile, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", `${base}.wav`]);
    await run(bin("whisper-cli"), ["-m", config.whisperModel, "-f", `${base}.wav`, "-l", "auto", "-nt", "-otxt", "-of", base], { timeout: 300_000 });
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
  await run(bin("ffmpeg"), ["-y", "-loglevel", "error", "-i", `${base}.aiff`, "-c:a", "libopus", "-b:a", "32k", `${base}.ogg`]);
  fs.rmSync(`${base}.aiff`, { force: true });
  return `${base}.ogg`;
}
