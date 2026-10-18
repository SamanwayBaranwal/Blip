// Bots work in parallel, but they share one screen, one mouse and one Chrome profile. Whichever task first
// touches the browser or the Mac's screen holds "the computer" until it finishes; others wait their turn
// (chat, terminal commands, web search and files never wait). When the computer passes to a different bot,
// the previous bot's engine is closed first so its Chrome window (and the profile lock) is released.
//
// A bot that used the browser earlier keeps Chrome open in its engine even after its task ends. If that bot is
// busy with a new task, its engine can't be closed without killing that task, so others wait until it's done
// (and the bot itself may pick the browser straight back up, since it already has it).

type Run = { runId: string; botId: string; botName: string };
type Waiter = Run & { resolve: () => void; reject: (e: Error) => void; onWait: (holderName: string) => void };
type Engines = { close: (botId: string) => Promise<void>; busy: (botId: string) => boolean };

let holder: Run | undefined;
let lastUser: { botId: string; botName: string } | undefined; // bot whose engine may still have Chrome open
let granting = false;
const waiters: Waiter[] = [];
let engines: Engines = { close: async () => {}, busy: () => false };

export function setEngines(e: Engines) {
  engines = e;
}

export const computerHolder = () => holder;

/** Who is in the way of this run using the computer right now, if anyone. */
function blocker(run: Run): string | undefined {
  if (holder) return holder.runId === run.runId ? undefined : holder.botName;
  if (granting) return lastUser?.botName ?? "another bot";
  if (lastUser && lastUser.botId !== run.botId && engines.busy(lastUser.botId)) return lastUser.botName;
  return undefined;
}

async function grant(run: Run) {
  holder = run;
  if (lastUser && lastUser.botId !== run.botId) {
    granting = true;
    try {
      await engines.close(lastUser.botId);
    } catch (error) {
      console.error("Couldn't close the previous browser:", error);
    } finally {
      granting = false;
    }
  }
  lastUser = { botId: run.botId, botName: run.botName };
  // The task may have ended while the old browser was closing; then let the next one in.
  if (!holder) void drain();
}

/** Waits until this task may use the browser/screen. `onWait` is told who is using it meanwhile. */
export async function acquireComputer(run: Run, signal: AbortSignal, onWait: (holderName: string) => void) {
  if (holder?.runId === run.runId) return;
  if (signal.aborted) throw new Error("stopped");
  const inTheWay = blocker(run);
  if (!inTheWay) return grant(run);
  onWait(inTheWay);
  await new Promise<void>((resolve, reject) => {
    const waiter: Waiter = { ...run, resolve, reject, onWait };
    waiters.push(waiter);
    signal.addEventListener(
      "abort",
      () => {
        const i = waiters.indexOf(waiter);
        if (i >= 0) waiters.splice(i, 1);
        else if (holder?.runId === run.runId) {
          holder = undefined; // stopped just as it was handed the computer: pass it on
          void drain();
        }
        reject(new Error("stopped"));
      },
      { once: true },
    );
  });
}

/** Hands the computer to the first waiting task that can have it now. */
async function drain() {
  if (holder || granting) return;
  const next = waiters.find((w) => !blocker(w));
  if (!next) return;
  waiters.splice(waiters.indexOf(next), 1);
  await grant(next);
  if ((holder as Run | undefined)?.runId === next.runId) next.resolve(); // unless it was stopped meanwhile
}

/** Called whenever a task ends: frees the computer if it held it, and lets the next waiting task in. */
export async function releaseComputer(runId: string) {
  if (holder?.runId === runId) holder = undefined;
  await drain();
}
