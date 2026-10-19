import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { ROOT } from "./config.js";

// Blip's small native Mac helpers (mac-app/*.swift) are compiled on the Mac that runs Blip, at startup, when
// Apple's command line tools are installed. A helper is rebuilt only when its source is newer than the build.

const run = promisify(execFile);
const builds = new Map<string, Promise<string | undefined>>();

export const helperPath = (name: string) => path.join(ROOT, "bin", name);

/** Builds mac-app/<source>.swift into bin/<name>. Resolves to the binary's path, or undefined if it can't. */
export function buildHelper(source: string, name: string): Promise<string | undefined> {
  let pending = builds.get(name);
  if (pending) return pending;
  pending = (async () => {
    const src = path.join(ROOT, "mac-app", `${source}.swift`);
    const bin = helperPath(name);
    try {
      if (fs.existsSync(bin) && fs.statSync(bin).mtimeMs >= fs.statSync(src).mtimeMs) return bin;
      // Without the command line tools, /usr/bin/swiftc pops up an install dialog: check first, never surprise.
      await run("/usr/bin/xcode-select", ["-p"]);
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      await run("/usr/bin/swiftc", ["-O", src, "-o", bin], { timeout: 300_000 });
      console.log(`Built ${name}.`);
      return bin;
    } catch (error) {
      console.error(`${name} not built (install Apple's command line tools: xcode-select --install):`, (error as Error).message.split("\n")[0]);
      return undefined;
    }
  })();
  builds.set(name, pending);
  return pending;
}
