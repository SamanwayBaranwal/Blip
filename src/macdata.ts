import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildHelper } from "./native.js";
import { isSensitive } from "./permissions.js";
import { state } from "./store.js";

// Structured access to the Mac's own apps and files, much faster and sturdier than screenshots and clicks:
//   • Calendar, Reminders, Contacts through Apple's frameworks (the blip-macdata helper)
//   • Mail through scripting (reads the accounts already set up in Mail.app)
//   • files through Spotlight
// macOS asks once, on the Blip Mac, before Blip may read each of these.

const run = promisify(execFile);
const UTF8 = { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" };

// Runs the user didn't start (check-ins, routines) must never pop a permission dialog on the Mac.
let noPrompt = false;
export async function withoutPrompts<T>(fn: () => Promise<T>): Promise<T> {
  const before = noPrompt;
  noPrompt = true;
  try {
    return await fn();
  } finally {
    noPrompt = before;
  }
}

// Test runs (BLIP_FAKE_MAC_DATA=1) get a pretend Calendar, Reminders and Contacts, so a test can never touch,
// or ask macOS for, the real ones on the developer's Mac.
const fake = process.env.BLIP_FAKE_MAC_DATA === "1";
const today = new Date().toISOString().slice(0, 10);
const fakeEvents: Record<string, unknown>[] = [{ id: "e0", title: "Dentist (test data)", start: `${today}T15:00:00`, end: `${today}T15:30:00`, allDay: false, calendar: "Test", location: "Elm Street", notes: "" }];
const fakeReminders: Record<string, unknown>[] = [{ id: "r0", title: "Pay rent (test data)", due: `${today}T09:00:00`, list: "Test", notes: "" }];
function fakeHelper(args: string[]): unknown {
  const input = () => JSON.parse(args[1] ?? "{}");
  const id = `fake-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  switch (args[0]) {
    case "status": return { calendar: "allowed", reminders: "allowed", contacts: "allowed" };
    case "events": return fakeEvents.filter((e) => String(e.start).slice(0, 10) >= args[1]!.slice(0, 10) && String(e.start).slice(0, 10) <= args[2]!.slice(0, 10));
    case "reminders": return fakeReminders;
    case "contacts": return [{ name: "Raj Test", organization: "", phones: ["+1 555 0100"], emails: ["raj@example.com"] }];
    case "add-event": fakeEvents.push({ id, ...input(), calendar: input().calendar ?? "Test" }); return { ok: true, id, title: input().title };
    case "add-reminder": fakeReminders.push({ id, ...input(), list: input().list ?? "Test" }); return { ok: true, id, title: input().title };
    case "delete-event": fakeEvents.splice(fakeEvents.findIndex((e) => e.id === args[1]), 1); return { ok: true };
    case "delete-reminder": fakeReminders.splice(fakeReminders.findIndex((r) => r.id === args[1]), 1); return { ok: true };
    default: return { ok: true };
  }
}

async function helper(args: string[]): Promise<unknown> {
  if (fake) return fakeHelper(args);
  const bin = await buildHelper("macdata", "blip-macdata");
  if (!bin) throw new Error("Calendar, Reminders and Contacts need Apple's command line tools on the Blip Mac. In Terminal there: xcode-select --install, then ./blip.sh restart");
  const env = noPrompt ? { ...UTF8, BLIP_NO_PROMPT: "1" } : UTF8;
  const { stdout } = await run(bin, args, { timeout: 150_000, env }).catch((e: { stdout?: string; message: string }) => ({ stdout: e.stdout || JSON.stringify({ error: e.message }) }));
  const data = JSON.parse(stdout.trim().split("\n").pop() || "{}");
  if (data && typeof data === "object" && "error" in data) throw new Error(String((data as { error: string }).error));
  return data;
}

export const macStatus = () => helper(["status"]);
export const calendarEvents = (from: string, to: string) => helper(["events", from, to]);
export const addCalendarEvent = (e: { title: string; start: string; end?: string; calendar?: string; location?: string; notes?: string; allDay?: boolean }) => helper(["add-event", JSON.stringify(e)]);
export const reminders = () => helper(["reminders"]);
export const addReminder = (r: { title: string; due?: string; list?: string; notes?: string }) => helper(["add-reminder", JSON.stringify(r)]);
export const findContacts = (q: string) => helper(["contacts", q]);
export const deleteCalendarEvent = (id: string) => helper(["delete-event", id]);
export const deleteReminder = (id: string) => helper(["delete-reminder", id]);

// ---------------------------------------------------------------- Mail
const MAIL_SCRIPT = `
function run(argv) {
  const query = (argv[0] || "").toLowerCase(), limit = Number(argv[1]) || 15, unreadOnly = argv[2] === "1";
  const Mail = Application("Mail");
  // Opening Mail would pop a window on the Mac: only read it when it's already running.
  if (!Mail.running()) return JSON.stringify({ error: "Mail isn't open on the Blip Mac. Open Mail there once (and keep it open) so bots can read it." });
  const msgs = Mail.inbox.messages;
  const scan = Math.min(msgs.length, 300);
  const found = [];
  for (let i = 0; i < scan && found.length < limit; i++) {
    const m = msgs[i];
    const read = m.readStatus();
    if (unreadOnly && read) continue;
    const subject = m.subject() || "", from = m.sender() || "";
    if (query && !(subject + " " + from).toLowerCase().includes(query)) continue;
    found.push({ subject, from, date: m.dateReceived().toISOString(), unread: !read, account: m.mailbox().account().name(), i });
  }
  // The text of the first few, so a bot can triage without opening each one.
  for (let k = 0; k < Math.min(found.length, 5); k++) {
    try { found[k].preview = (msgs[found[k].i].content() || "").slice(0, 600); } catch (e) {}
  }
  found.forEach((f) => delete f.i);
  return JSON.stringify(found);
}`;

export async function recentMail(opts: { query?: string; limit?: number; unreadOnly?: boolean; background?: boolean }) {
  if (fake) return [{ subject: "Invoice #42 (test data)", from: "billing@example.com", date: new Date().toISOString(), unread: true, account: "Test", preview: "Your invoice is due Friday." }];
  // The first read of Mail asks macOS for permission: in the background, only once the user has allowed it.
  if (opts.background && !state.macAccess?.mail) throw new Error("Blip isn't allowed to read Mail yet. On the Blip Mac: Settings → This Mac → Check Mac access.");
  const { stdout } = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", MAIL_SCRIPT, opts.query ?? "", String(Math.min(50, opts.limit ?? 15)), opts.unreadOnly ? "1" : "0"], {
    timeout: 90_000,
    env: UTF8,
    maxBuffer: 5_000_000,
  }).catch((e: { message: string }) => {
    throw new Error(/not allowed|1743|authoriz/i.test(e.message) ? "macOS hasn't let Blip read Mail. On the Blip Mac: System Settings → Privacy & Security → Automation → node → turn on Mail." : e.message.split("\n")[0]);
  });
  const data = JSON.parse(stdout);
  if (data?.error) throw new Error(data.error);
  return data as { subject: string; from: string; date: string; unread: boolean; account: string; preview?: string }[];
}

// ---------------------------------------------------------------- files (Spotlight)
const SKIP = /\/(Library|\.Trash|node_modules|\.git|\.cache)(\/|$)/;

export async function findFiles(query: string, opts: { contents?: boolean; limit?: number } = {}) {
  const home = os.homedir();
  const searches = [run("/usr/bin/mdfind", ["-onlyin", home, "-name", query], { timeout: 30_000, maxBuffer: 20_000_000 })];
  if (opts.contents) searches.push(run("/usr/bin/mdfind", ["-onlyin", home, query], { timeout: 30_000, maxBuffer: 20_000_000 }));
  const paths = new Set<string>();
  for (const r of await Promise.allSettled(searches)) {
    if (r.status === "fulfilled") for (const p of r.value.stdout.split("\n")) if (p && !SKIP.test(p) && !isSensitive(p)) paths.add(p);
  }
  const rows = [...paths].slice(0, 400).flatMap((p) => {
    try {
      const st = fs.statSync(p);
      return [{ path: p, folder: st.isDirectory(), kb: Math.round(st.size / 1024), modified: st.mtime.toISOString().slice(0, 16).replace("T", " ") }];
    } catch {
      return [];
    }
  });
  return rows.sort((a, b) => b.modified.localeCompare(a.modified)).slice(0, opts.limit ?? 25).map((r) => ({ ...r, path: r.path.replace(home, "~") }));
}

/** For the self-test and health page: which of these macOS has allowed so far (never asks). */
export async function macAccessStatus() {
  return macStatus().catch(() => null);
}

export const toFull = (p: string) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);
