import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "./config.js";
import { updateMessage } from "./hub.js";
import * as screen from "./screen.js";

// Work replay (Grok Bot's "video previews of work done"): every browser session is recorded by the browser
// itself, and when it ends the recording becomes a short, compact clip linked from the tasks that used it.
// So a routine that ran at 3 a.m. can be watched in 30 seconds, without having watched it live.

const run = promisify(execFile);
export const REPLAY_DIR = () => path.join(config.workspace, "replays");

/** Where a browser session records, and the browser-tool config that tells it to. */
export function replaySetup(key: string) {
  const videoDir = path.join(config.workspace, "browser", "videos", key);
  const configFile = path.join(config.dataDir, "browser-config", `${key}.json`);
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ browser: { contextOptions: { recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } } } } }));
  return { videoDir, configFile };
}

/** Three stills from a clip (start, middle, end), saved as proof screenshots. */
async function stills(ff: string, clip: string): Promise<string[]> {
  const probe = await run(ff, ["-hide_banner", "-i", clip], { timeout: 20_000 }).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? "" }));
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(probe.stderr ?? "");
  const seconds = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
  if (seconds < 1) return [];
  const dir = path.join(config.workspace, "proof");
  fs.mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  for (const [i, at] of [0.08, 0.5, 0.97].entries()) {
    const file = path.join(dir, `${path.basename(clip, ".mp4")}-${i}.jpg`);
    await run(ff, ["-hide_banner", "-loglevel", "error", "-ss", (seconds * at).toFixed(2), "-i", clip, "-frames:v", "1", "-q:v", "4", "-y", file], { timeout: 30_000 });
    if (fs.existsSync(file)) files.push(path.relative(config.workspace, file));
  }
  return files;
}

/** After a browser session ends: turn its recordings into one clip (2× speed) and link it from those tasks. */
export async function finishReplay(videoDir: string, configFile: string, targets: { botId: string; msgId: string }[]) {
  try {
    await new Promise((r) => setTimeout(r, 1500)); // the browser finishes writing the video as it closes
    const ff = screen.ffmpegPath();
    const videos = fs.existsSync(videoDir)
      ? fs.readdirSync(videoDir).filter((f) => f.endsWith(".webm")).map((f) => path.join(videoDir, f)).filter((f) => fs.statSync(f).size > 20_000)
      : [];
    if (!ff || !videos.length || !targets.length) return;
    videos.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
    fs.mkdirSync(REPLAY_DIR(), { recursive: true });
    const out = path.join(REPLAY_DIR(), `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}-${path.basename(videoDir)}.mp4`);
    const inputs = videos.flatMap((v) => ["-i", v]);
    const join = videos.map((_, i) => `[${i}:v]setpts=0.5*PTS,scale=960:-2:flags=fast_bilinear,fps=15,format=yuv420p[v${i}]`).join(";");
    const concat = `${join};${videos.map((_, i) => `[v${i}]`).join("")}concat=n=${videos.length}:v=1:a=0[out]`;
    await run(ff, ["-hide_banner", "-loglevel", "error", ...inputs, "-filter_complex", concat, "-map", "[out]", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "31", "-movflags", "+faststart", "-y", out], { timeout: 10 * 60_000 });
    const rel = path.relative(config.workspace, out);
    const frames = await stills(ff, out).catch(() => [] as string[]);
    for (const t of targets)
      updateMessage(t.botId, t.msgId, (m) => {
        if (!m.run) return;
        m.run.replay = rel;
        if (!m.run.shots?.length && frames.length) m.run.shots = frames; // a few stills, so there's something to glance at
      });
  } catch (error) {
    console.error("Couldn't make the replay:", (error as Error).message.split("\n")[0]);
  } finally {
    fs.rmSync(videoDir, { recursive: true, force: true });
    fs.rmSync(configFile, { force: true });
  }
}
