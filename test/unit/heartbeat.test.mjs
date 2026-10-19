import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { dist, tempHome } from "../helpers.mjs";

tempHome();
const { state } = await import(dist("store"));
const { beat } = await import(dist("health"));

test("the heartbeat pings the monitor, and /fail when something's wrong", async () => {
  const hits = [];
  const server = http.createServer((req, res) => (hits.push(req.url), res.end("OK")));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  state.settings.healthcheckUrl = `http://127.0.0.1:${server.address().port}/abc123`;
  assert.equal((await beat()).ok, true);
  await beat("/fail");
  server.close();
  assert.deepEqual(hits, ["/abc123", "/abc123/fail"]);
});

test("no link set means no pings at all", async () => {
  state.settings.healthcheckUrl = undefined;
  assert.equal(await beat(), undefined);
});
