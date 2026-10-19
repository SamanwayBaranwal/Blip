import fs from "node:fs";
import os from "node:os";
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

/** For the Mac access check: what voice messages still need, if anything. */
export function voiceMissing(): string | undefined {
  if (!bin("ffmpeg")) return "brew install ffmpeg";
  if (!bin("whisper-cli")) return "HOMEBREW_NO_AUTO_UPDATE=1 brew install whisper.cpp";
  if (!fs.existsSync(config.whisperModel)) return "./blip.sh setup (downloads the speech model)";
  return undefined;
}

export async function transcribe(audioFile: string): Promise<string> {
  if (!fs.existsSync(config.whisperModel)) throw new Error("The speech model is missing. On the Mac running Blip, run: ./blip.sh setup");
  const ffmpeg = need("ffmpeg", "ffmpeg");
  const whisper = need("whisper-cli", "whisper.cpp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const base = path.join(tmpDir, `in-${Date.now()}`);
  try {
    // Long pauses are trimmed first (less audio to listen to), then Whisper decodes greedily on more threads:
    // the same words, noticeably faster, most of all on Intel Macs without GPU acceleration.
    await run(ffmpeg, [
      "-y", "-loglevel", "error", "-i", audioFile,
      "-af", "silenceremove=start_periods=1:start_threshold=-50dB:stop_periods=-1:stop_duration=1:stop_threshold=-50dB",
      "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", `${base}.wav`,
    ]);
    const threads = String(Math.max(2, Math.min(8, os.cpus().length)));
    await run(whisper, ["-m", config.whisperModel, "-f", `${base}.wav`, "-l", "auto", "-nt", "-t", threads, "-bs", "1", "-bo", "1", "-otxt", "-of", base], { timeout: 300_000 });
    return fs.readFileSync(`${base}.txt`, "utf8").trim();
  } finally {
    for (const ext of [".wav", ".txt"]) fs.rmSync(base + ext, { force: true });
  }
}

/** The most natural English voice installed on this Mac (Premium or Enhanced ones sound far less robotic). */
let voicePick: Promise<string | undefined> | undefined;
function bestVoice() {
  voicePick ??= run("/usr/bin/say", ["-v", "?"])
    .then(({ stdout }) => {
      const voices = stdout.split("\n").map((l) => /^(.+?)\s{2,}(\w\w_\w\w)/.exec(l)).filter((m): m is RegExpExecArray => !!m).map((m) => ({ name: m[1]!.trim(), lang: m[2]! }));
      const english = voices.filter((v) => v.lang.startsWith("en_"));
      return (english.find((v) => /premium/i.test(v.name)) ?? english.find((v) => /enhanced/i.test(v.name)))?.name;
    })
    .catch(() => undefined);
  return voicePick;
}

/** Returns an .ogg (Opus) file Telegram plays as a voice message. */
export async function speak(text: string): Promise<string> {
  fs.mkdirSync(tmpDir, { recursive: true });
  const base = path.join(tmpDir, `out-${Date.now()}`);
  const clean = text.replace(/[•*_#`]/g, "").slice(0, 2500);
  const voice = await bestVoice();
  await run("/usr/bin/say", [...(voice ? ["-v", voice] : []), "-o", `${base}.aiff`, clean], { timeout: 120_000 });
  await run(need("ffmpeg", "ffmpeg"), ["-y", "-loglevel", "error", "-i", `${base}.aiff`, "-c:a", "libopus", "-b:a", "32k", `${base}.ogg`]);
  fs.rmSync(`${base}.aiff`, { force: true });
  return `${base}.ogg`;
}
