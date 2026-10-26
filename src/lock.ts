import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { save, state } from "./store.js";

// Chat lock (like WhatsApp's): a passcode, set once, that hides chosen chats (or the whole app) on every device
// until it's typed. Only a salted scrypt hash is kept. Locked chats also get notifications without their text.
// It guards against someone holding your unlocked phone; the app itself is already behind your sign-in.

const hash = (pin: string, salt: string) => scryptSync(pin, salt, 32).toString("hex");
const validPin = (pin: unknown): pin is string => typeof pin === "string" && /^\d{4,8}$/.test(pin);

let tries = 0;
let blockedUntil = 0;

export const lockView = () => ({ set: !!state.lock, chats: state.lock?.chats ?? [], app: !!state.lock?.app, digits: state.lock?.digits ?? 0 });
export const isLockedChat = (chatId: string) => !!state.lock?.chats.includes(chatId);

/** Checks a passcode. After 5 wrong tries, waits grow (30 s, 60 s, …) so it can't be guessed. */
export function checkPin(pin: unknown) {
  if (!state.lock) return true;
  if (Date.now() < blockedUntil) throw new Error(`Too many tries. Wait ${Math.ceil((blockedUntil - Date.now()) / 1000)} s.`);
  const ok = validPin(pin) && timingSafeEqual(Buffer.from(hash(pin, state.lock.salt), "hex"), Buffer.from(state.lock.hash, "hex"));
  if (ok) {
    tries = 0;
    return true;
  }
  if (++tries >= 5) blockedUntil = Date.now() + 30_000 * 2 ** Math.min(tries - 5, 6);
  return false;
}

/** Sets or changes the passcode (changing needs the current one). */
export function setPin(pin: unknown, current?: unknown) {
  if (!validPin(pin)) throw new Error("Use 4 to 8 digits.");
  if (state.lock && !checkPin(current)) throw new Error("The current passcode is wrong.");
  const salt = randomBytes(16).toString("hex");
  state.lock = { salt, hash: hash(pin, salt), digits: pin.length, chats: state.lock?.chats ?? [], app: state.lock?.app ?? false };
  save();
}

/** Locks or unlocks a chat. Unlocking (taking the lock off for good) needs the passcode. */
export function setChatLock(chatId: string, locked: boolean, pin?: unknown) {
  if (!state.lock) throw new Error("Set a passcode first (Settings → Privacy).");
  if (!locked && !checkPin(pin)) throw new Error("Wrong passcode.");
  const chats = new Set(state.lock.chats);
  if (locked) chats.add(chatId);
  else chats.delete(chatId);
  state.lock.chats = [...chats];
  save();
}

export function setAppLock(on: boolean, pin?: unknown) {
  if (!state.lock) throw new Error("Set a passcode first.");
  if (!on && !checkPin(pin)) throw new Error("Wrong passcode.");
  state.lock.app = on;
  save();
}

/** Removes the passcode and every lock (needs the passcode). */
export function removeLock(pin: unknown) {
  if (!checkPin(pin)) throw new Error("Wrong passcode.");
  state.lock = undefined;
  save();
}
