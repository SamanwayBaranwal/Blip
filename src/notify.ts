import fs from "node:fs";
import path from "node:path";
import webpush from "web-push";
import { config } from "./config.js";

// Push notifications to the installed app (iPhone needs the app added to the Home Screen, over HTTPS).
const KEYS_FILE = path.join(config.dataDir, "vapid.json");
const SUBS_FILE = path.join(config.dataDir, "push-subscriptions.json");

function keys(): { publicKey: string; privateKey: string } {
  if (fs.existsSync(KEYS_FILE)) return JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"));
  const generated = webpush.generateVAPIDKeys();
  fs.writeFileSync(KEYS_FILE, JSON.stringify(generated), { mode: 0o600 });
  return generated;
}

const vapid = keys();
webpush.setVapidDetails("mailto:owner@localhost", vapid.publicKey, vapid.privateKey);

let subs: webpush.PushSubscription[] = [];
try {
  subs = JSON.parse(fs.readFileSync(SUBS_FILE, "utf8"));
} catch {
  subs = [];
}
const saveSubs = () => fs.writeFileSync(SUBS_FILE, JSON.stringify(subs), { mode: 0o600 });

export const pushPublicKey = vapid.publicKey;

export function addSubscription(sub: webpush.PushSubscription) {
  if (!sub?.endpoint) return;
  subs = [...subs.filter((s) => s.endpoint !== sub.endpoint), sub];
  saveSubs();
}

/** Sends a notification to every installed app. `tag` replaces an older notification with the same tag. */
export async function push(n: { title: string; body: string; botId?: string; tag?: string; silent?: boolean }) {
  if (!subs.length) return;
  const payload = JSON.stringify({ ...n, body: n.body.slice(0, 240) });
  const list = subs; // subs may change while sending; match results to the list they came from
  const results = await Promise.allSettled(list.map((s) => webpush.sendNotification(s, payload, { TTL: 3600 })));
  const gone = results
    .map((r, i) => (r.status === "rejected" && [404, 410].includes((r.reason as { statusCode?: number }).statusCode ?? 0) ? list[i]!.endpoint : undefined))
    .filter(Boolean);
  if (gone.length) {
    subs = subs.filter((s) => !gone.includes(s.endpoint));
    saveSubs();
  }
}
