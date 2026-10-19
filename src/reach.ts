import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { Resolver } from "node:dns/promises";
import https from "node:https";
import fs from "node:fs";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { config } from "./config.js";
import { stateChanged } from "./hub.js";
import { push } from "./notify.js";
import { save, state } from "./store.js";

// Blip from anywhere: the phone reaches this Mac from any network (another country, mobile data), not only the
// home Wi-Fi, with nothing to set up on the phone.
//  • "cloudflare": a Cloudflare quick tunnel. No account. The link changes when the Mac or Blip restarts, so
//    Blip emails the owner the new link (and pings the phone) every time it changes.
//  • "tailscale": Tailscale Funnel. A permanent https link, after a one-time Tailscale sign-in on the Mac.
// Either way the app is on the internet behind the access code (a 144-bit secret in a cookie) and one-time
// sign-in links; nothing else is open.

const run = promisify(execFile);
export type ReachMode = "off" | "cloudflare" | "tailscale";
export type Reach = {
  mode: ReachMode;
  status: "off" | "starting" | "on" | "needs-you" | "error";
  url?: string;
  permanent: boolean;
  since?: string;
  error?: string;
  /** Tailscale: the page where the owner allows Funnel (one time). */
  enableUrl?: string;
};

let reach: Reach = { mode: "off", status: "off", permanent: false };
let child: ChildProcess | undefined;
let restartTimer: NodeJS.Timeout | undefined;
let failures = 0;
const listeners: ((url: string, previous?: string) => void)[] = [];

export const reachStatus = () => ({ ...reach, owner: state.owner?.email ?? null, lastEmailAt: state.owner?.lastEmailAt ?? null });
/** Called when the anywhere-link changes (the app emails and notifies the owner). */
export const onLinkChange = (fn: (url: string, previous?: string) => void) => void listeners.push(fn);

const which = (names: string[]) => names.find((p) => fs.existsSync(p));
export const cloudflaredPath = () => which(["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared"]);
export const tailscalePath = () => which(["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"]);

function set(next: Partial<Reach>) {
  const before = reach.url;
  reach = { ...reach, ...next };
  if (reach.url && reach.url !== before && reach.status === "on") {
    const previous = state.reachUrl;
    state.reachUrl = reach.url;
    save();
    if (previous !== reach.url) for (const fn of listeners) fn(reach.url, previous);
  }
  stateChanged();
}

/** Finds the public link in cloudflared's output. */
export const tunnelUrlIn = (text: string) => /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(text)?.[0];

function stopChild() {
  clearTimeout(restartTimer);
  pendingUrl = undefined;
  if (child && child.exitCode === null) child.kill();
  child = undefined;
}

// A brand-new quick-tunnel name takes up to a minute or two to appear in DNS. Announcing it before then
// would send a link that fails (and a phone that looked too early may remember "not found" for a while).
// So it's checked through public DNS first, and only then shown, emailed and pushed.
const publicDns = new Resolver();
publicDns.setServers(["1.1.1.1", "8.8.8.8"]);
let pendingUrl: string | undefined;

/** True if the link answers, looked up through public DNS (not this Mac's cache). */
export async function publicLinkWorks(url: string) {
  const host = new URL(url).hostname;
  const ip = await publicDns.resolve4(host).then((a) => a[0], () => undefined);
  if (!ip) return false;
  return new Promise<boolean>((resolve) => {
    const req = https.get(`${url}/status`, { lookup: (_h, _o, cb) => cb(null, [{ address: ip, family: 4 }] as never), timeout: 15_000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

async function announceWhenLive(url: string, owner: ChildProcess) {
  set({ status: "starting", error: undefined });
  for (let i = 0; i < 60; i++) {
    if (child !== owner || pendingUrl !== url) return; // replaced or turned off meanwhile
    if (await publicLinkWorks(url)) {
      failures = 0;
      return set({ status: "on", url, since: new Date().toISOString(), error: undefined });
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (child === owner) set({ status: "error", error: "The link didn't come up. Blip will try a new one." }), owner.kill();
}

function startCloudflare() {
  const bin = cloudflaredPath();
  if (!bin) return set({ status: "error", error: "cloudflared isn't installed. On the Mac run: brew install cloudflared (or ./blip.sh setup)." });
  set({ status: "starting", error: undefined, permanent: false });
  const p = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://localhost:${config.webPort}`], { stdio: ["ignore", "pipe", "pipe"] });
  child = p;
  let seen = "";
  const onData = (d: Buffer) => {
    seen = (seen + d.toString()).slice(-20_000);
    const url = tunnelUrlIn(seen);
    if (url && url !== pendingUrl && reach.url !== url) {
      pendingUrl = url;
      void announceWhenLive(url, p);
    }
  };
  p.stdout.on("data", onData);
  p.stderr.on("data", onData);
  p.on("exit", () => {
    if (child !== p) return; // replaced or turned off on purpose
    child = undefined;
    // It dropped: start again, waiting a little longer each time (the link will be new; the owner hears about it).
    failures++;
    set({ status: "starting", error: failures > 2 ? "The tunnel keeps dropping. Is the Mac online?" : undefined });
    restartTimer = setTimeout(startCloudflare, Math.min(5 * 60_000, 3000 * 2 ** Math.min(failures, 6)));
  });
}

async function startTailscale() {
  const bin = tailscalePath();
  if (!bin) return set({ status: "error", error: "Tailscale isn't installed on this Mac. Get it free from tailscale.com/download, sign in, then try again." });
  set({ status: "starting", error: undefined, permanent: true });
  try {
    const { stdout } = await run(bin, ["status", "--json"], { timeout: 8000 });
    const s = JSON.parse(stdout) as { BackendState?: string; Self?: { DNSName?: string } };
    if (s.BackendState !== "Running" || !s.Self?.DNSName) return set({ status: "needs-you", error: "Open the Tailscale app on this Mac and sign in (Google, Apple or Microsoft account), then try again." });
    const url = `https://${s.Self.DNSName.replace(/\.$/, "")}`;
    // The first time, Tailscale asks the owner to allow Funnel in their browser and waits; we show that link.
    const p = spawn(bin, ["funnel", "--bg", String(config.webPort)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const done = new Promise<number | null>((resolve) => p.on("exit", resolve));
    const grab = (d: Buffer) => {
      out += d.toString();
      const enable = /https:\/\/login\.tailscale\.com\/\S+/.exec(out)?.[0];
      if (enable && !reach.enableUrl) set({ status: "needs-you", enableUrl: enable, error: "Allow Funnel once: open the link, tap Enable, then come back." });
    };
    p.stdout.on("data", grab);
    p.stderr.on("data", grab);
    const timer = setTimeout(() => p.kill(), 10 * 60_000);
    const code = await done;
    clearTimeout(timer);
    if (code === 0) return set({ status: "on", url, since: new Date().toISOString(), enableUrl: undefined, error: undefined });
    set({ status: "error", error: out.split("\n").find((l) => l.trim())?.slice(0, 200) || "Tailscale Funnel didn't start." });
  } catch (error) {
    set({ status: "error", error: (error as Error).message.split("\n")[0] });
  }
}

/** Turns anywhere access on (in the chosen way) or off, and remembers the choice. */
export async function setReach(mode: ReachMode) {
  stopChild();
  if (reach.mode === "tailscale" && mode !== "tailscale") {
    const bin = tailscalePath();
    if (bin) await run(bin, ["funnel", "--bg", "off"], { timeout: 8000 }).catch(() => run(bin, ["funnel", "reset"], { timeout: 8000 }).catch(() => {}));
  }
  state.settings.anywhere = mode;
  save();
  reach = { mode, status: mode === "off" ? "off" : "starting", permanent: mode === "tailscale" };
  stateChanged();
  if (mode === "cloudflare") startCloudflare();
  if (mode === "tailscale") void startTailscale();
  return reachStatus();
}

export async function startReach() {
  // A tunnel left over from a Blip that was force-quit would keep an old link open: end it first.
  await run("/usr/bin/pkill", ["-f", `cloudflared tunnel --no-autoupdate --url http://localhost:${config.webPort}`]).catch(() => {});
  const mode = state.settings.anywhere ?? "off";
  if (mode !== "off") void setReach(mode);
}

// A quick tunnel can go quiet without exiting; check every 5 minutes that the link still reaches us.
setInterval(async () => {
  if (reach.mode !== "cloudflare" || reach.status !== "on" || !reach.url) return;
  const ok = await publicLinkWorks(reach.url);
  if (ok) return void (failures = 0);
  if (++failures >= 3) {
    console.error("The anywhere link stopped answering; starting a new tunnel.");
    stopChild();
    startCloudflare();
  }
}, 5 * 60_000).unref();
process.on("exit", stopChild);

// ---------------------------------------------------------------- one-time sign-in links
// Opening one signs that browser in (no code to type). Single use; they expire. Only a hash is stored.
const hash = (t: string) => createHash("sha256").update(t).digest("hex");
export function newLoginLink(base: string, ttlMs: number) {
  const token = randomBytes(24).toString("base64url");
  const now = Date.now();
  state.loginLinks = [...(state.loginLinks ?? []).filter((l) => l.expires > now), { hash: hash(token), expires: now + ttlMs }].slice(-20);
  save();
  return `${base.replace(/\/$/, "")}/login?t=${token}`;
}
export function useLoginLink(token: unknown) {
  if (typeof token !== "string" || token.length < 20) return false;
  const h = hash(token);
  const link = (state.loginLinks ?? []).find((l) => l.hash === h && l.expires > Date.now());
  if (!link) return false;
  state.loginLinks = state.loginLinks!.filter((l) => l !== link); // single use
  save();
  return true;
}

// ---------------------------------------------------------------- QR code (scan from the Mac's screen)
const require = createRequire(import.meta.url);
/** An SVG QR code for `text` (uses the generator inside qrcode-terminal). */
export function qrSvg(text: string) {
  const QRCode = require("qrcode-terminal/vendor/QRCode");
  const levels = require("qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel");
  const qr = new QRCode(-1, levels.M);
  qr.addData(text);
  qr.make();
  const n: number = qr.getModuleCount();
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 8} ${n + 8}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

// ---------------------------------------------------------------- the link, by email
/**
 * Emails the owner how to open Blip on their phone: a one-tap sign-in link, the plain link, and the Home Screen
 * steps. It's sent from Blip's own mailbox (Settings → Agent email), so no Blip server is involved.
 */
export async function sendLinkEmail(reason: "setup" | "changed") {
  const to = state.owner?.email;
  if (!to) throw new Error("Add your email first.");
  if (!reach.url || reach.status !== "on") throw new Error("Turn on “Use Blip anywhere” first, so there's a link to send.");
  const { sendEmail } = await import("./email.js");
  const signIn = newLoginLink(reach.url, 7 * 86_400_000);
  const body = [
    reason === "changed" ? "Blip's link changed (the Mac or Blip restarted). Here's the new one." : "Here's how to open Blip on your phone, from anywhere.",
    "",
    "1. On your phone, tap this link. It opens Blip and signs you in (it works once, within 7 days):",
    `   ${signIn}`,
    "2. iPhone: tap Share, then Add to Home Screen. Android: tap the menu, then Install app.",
    "3. Open Blip from your Home Screen and allow notifications, so it can tell you when it needs you.",
    "",
    `Your Blip link: ${reach.url}`,
    "If the sign-in link was already used, open this one and type the code from Settings → Connect your phone on the Mac.",
    "",
    ...(reach.permanent
      ? ["This link is permanent."]
      : ["This link changes when the Mac restarts. Blip emails you the new one each time. For a link that never changes, turn on Tailscale in Settings → Use Blip anywhere.", ""]),
    "Keep this email private: the sign-in link opens your Blip.",
    "",
    "Blip, on your Mac",
  ].join("\n");
  await sendEmail({ to, subject: reason === "changed" ? "Blip has a new link" : "Open Blip on your phone", body });
  state.owner = { ...state.owner!, lastEmailAt: new Date().toISOString() };
  save();
}

/** When the link changes: email the owner (if Blip has a mailbox) and ping the phone with a tap-to-open link. */
onLinkChange((url, previous) => {
  if (!previous) return; // the first link of a fresh setup is sent from the setup screen
  if (state.owner?.email && state.email) void sendLinkEmail("changed").catch((e) => console.error("Couldn't email the new link:", (e as Error).message));
  void push({ title: "Blip has a new link", body: "Tap to open Blip at its new address.", url: newLoginLink(url, 86_400_000), tag: "blip-link" });
});
