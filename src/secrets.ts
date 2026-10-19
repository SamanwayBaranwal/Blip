import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { save, state } from "./store.js";

// The secrets vault (Grok Bot's masked secret requests). Passwords and API keys live in the Mac's Keychain,
// never in chats, files or logs. Bots only ever see a placeholder, {{secret:name}}; Blip fills in the real
// value at the moment an approved action runs, and scrubs it from anything a tool sends back.

const run = promisify(execFile);
const SERVICE = "Blip";
export const PLACEHOLDER = /\{\{\s*secret:([a-z0-9][a-z0-9_.-]{0,39})\s*\}\}/gi;
const values = new Map<string, string>(); // in memory, for filling in and scrubbing

// Tests use a pretend Keychain held in memory (BLIP_TEST_KEYCHAIN=memory), so they never touch the real one.
const fakeKeychain = process.env.BLIP_TEST_KEYCHAIN === "memory" ? new Map<string, string>() : undefined;

export const cleanName = (name: string) => name.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
export const hasSecret = (name: string) => state.secrets.some((s) => s.name === cleanName(name));
export const listSecrets = () => state.secrets.map(({ name, note, createdAt, lastUsedAt }) => ({ name, note, createdAt, lastUsedAt }));

/** Saves a secret to the Keychain. The value goes in through stdin, so it never shows in the process list. */
export async function saveSecret(rawName: string, value: string, note = "") {
  const name = cleanName(rawName);
  if (!name) throw new Error("A secret needs a name.");
  if (!value) throw new Error("The secret is empty.");
  if (/[\r\n]/.test(value)) throw new Error("A secret can't contain line breaks.");
  if (fakeKeychain) fakeKeychain.set(name, value);
  else await new Promise<void>((resolve, reject) => {
    const p = spawn("/usr/bin/security", ["add-generic-password", "-U", "-s", SERVICE, "-a", name, "-l", `Blip: ${name}`, "-w"], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Keychain refused it: ${err.replace(/password data.*?:|retype.*?:/gi, "").trim() || code}`))));
    p.stdin.end(`${value}\n${value}\n`); // it asks twice
  });
  values.set(name, value);
  state.secrets = [...state.secrets.filter((s) => s.name !== name), { name, note: note.slice(0, 200), createdAt: new Date().toISOString() }];
  save();
  return name;
}

/** For Blip's own use (the agent email's password). Bots never get values, only placeholders. */
export const readSecretValue = (name: string) => readSecret(cleanName(name));

async function readSecret(name: string): Promise<string | undefined> {
  if (values.has(name)) return values.get(name);
  if (fakeKeychain) return fakeKeychain.get(name);
  try {
    const { stdout } = await run("/usr/bin/security", ["find-generic-password", "-s", SERVICE, "-a", name, "-w"]);
    const value = stdout.replace(/\n$/, "");
    values.set(name, value);
    return value;
  } catch {
    return undefined;
  }
}

export async function deleteSecret(rawName: string) {
  const name = cleanName(rawName);
  if (fakeKeychain) fakeKeychain.delete(name);
  else await run("/usr/bin/security", ["delete-generic-password", "-s", SERVICE, "-a", name]).catch(() => {});
  values.delete(name);
  state.secrets = state.secrets.filter((s) => s.name !== name);
  save();
}

/** For the self-test: can a value be written to and read back from the Keychain? (Uses its own test entry.) */
export async function keychainWorks() {
  if (fakeKeychain) return true;
  const probe = `ok-${Date.now()}`;
  try {
    await new Promise<void>((resolve, reject) => {
      const p = spawn("/usr/bin/security", ["add-generic-password", "-U", "-s", SERVICE, "-a", "blip-selftest", "-w"], { stdio: ["pipe", "ignore", "ignore"] });
      p.on("error", reject);
      p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(String(code)))));
      p.stdin.end(`${probe}\n${probe}\n`);
    });
    const { stdout } = await run("/usr/bin/security", ["find-generic-password", "-s", SERVICE, "-a", "blip-selftest", "-w"]);
    return stdout.trim() === probe;
  } catch {
    return false;
  } finally {
    await run("/usr/bin/security", ["delete-generic-password", "-s", SERVICE, "-a", "blip-selftest"]).catch(() => {});
  }
}

/** Loads every saved secret into memory, so tool output can be scrubbed even before one is used. */
export async function loadSecrets() {
  for (const s of state.secrets) await readSecret(s.name);
}

/** The secret names an action refers to. */
export function placeholdersIn(input: unknown): string[] {
  const names = new Set<string>();
  for (const m of JSON.stringify(input ?? "").matchAll(PLACEHOLDER)) names.add(cleanName(m[1]!));
  return [...names];
}

const deepMap = (v: unknown, fn: (s: string) => string): unknown =>
  typeof v === "string" ? fn(v)
  : Array.isArray(v) ? v.map((x) => deepMap(x, fn))
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepMap(x, fn)]))
  : v;

/** Replaces placeholders with the real values (only for an action that's about to run). */
export async function fillSecrets<T>(input: T): Promise<T> {
  const names = placeholdersIn(input);
  const found = new Map<string, string>();
  for (const name of names) {
    const value = await readSecret(name);
    if (value === undefined) throw new Error(`The secret "${name}" isn't in the Keychain any more.`);
    found.set(name, value);
    const meta = state.secrets.find((s) => s.name === name);
    if (meta) meta.lastUsedAt = new Date().toISOString();
  }
  save();
  return deepMap(input, (s) => s.replace(PLACEHOLDER, (_, n: string) => found.get(cleanName(n)) ?? _)) as T;
}

/** Scrubs any secret value out of text a tool returned, putting the placeholder back. Undefined when clean. */
export function scrub(output: unknown): unknown | undefined {
  const known = [...values.entries()].filter(([, v]) => v.length >= 4);
  if (!known.length) return undefined;
  const text = JSON.stringify(output ?? "");
  if (!known.some(([, v]) => text.includes(v) || text.includes(JSON.stringify(v).slice(1, -1)))) return undefined;
  return deepMap(output, (s) => known.reduce((acc, [name, v]) => acc.split(v).join(`{{secret:${name}}}`), s));
}
