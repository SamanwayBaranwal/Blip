import { test } from "node:test";
import assert from "node:assert/strict";
import { dist, tempHome } from "../helpers.mjs";

tempHome();
const lock = await import(dist("lock"));
const { state } = await import(dist("store"));

test("the passcode is stored only as a salted hash, and checks right and wrong codes", () => {
  lock.setPin("4821");
  assert.ok(state.lock.hash && state.lock.salt);
  assert.ok(!JSON.stringify(state.lock).includes("4821"), "never stored as typed");
  assert.equal(lock.lockView().digits, 4);
  assert.equal(lock.checkPin("4821"), true);
  assert.equal(lock.checkPin("1111"), false);
  assert.throws(() => lock.setPin("12"), /4 to 8 digits/);
});

test("changing the passcode needs the current one", () => {
  assert.throws(() => lock.setPin("999999", "0000"), /current passcode is wrong/);
  lock.setPin("999999", "4821");
  assert.equal(lock.checkPin("999999"), true);
  assert.equal(lock.lockView().digits, 6);
});

test("locking a chat is free; taking the lock off needs the passcode", () => {
  lock.setChatLock("bot-1", true);
  assert.equal(lock.isLockedChat("bot-1"), true);
  assert.throws(() => lock.setChatLock("bot-1", false, "000000"), /Wrong passcode/);
  lock.setChatLock("bot-1", false, "999999");
  assert.equal(lock.isLockedChat("bot-1"), false);
});

test("after 5 wrong tries it makes you wait", () => {
  for (let i = 0; i < 5; i++) lock.checkPin("123456");
  assert.throws(() => lock.checkPin("999999"), /Too many tries/);
});
