"use strict";
/* Readiness probing. "Started" means the process spawned, which is not the
   same as serving — an agent that acts on the difference makes a request that
   was never going to work. The TCP and HTTP probes are exercised against a
   real throwaway server rather than mocked, because what is being tested is
   whether they agree with a socket. */
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "stackdeck-ready-"));
process.env.STACKDECK_HOME = HOME;
process.env.STACKDECK_NO_LISTEN = "1"; // helpers only: do not start the daemon
const { waitReadyFor, readyTimeout } = require("../server.js");
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const servers = [];
after(() => { for (const s of servers) { try { s.close(); } catch {} } });

// A real listener on a real ephemeral port. Returns { port, close }.
function listen(handler) {
  return new Promise((resolve) => {
    const s = handler ? http.createServer(handler) : net.createServer((c) => c.end());
    servers.push(s);
    s.listen(0, "127.0.0.1", () => resolve({ port: s.address().port, server: s }));
  });
}

/* ---------- timeout clamping (pure) ---------- */

test("readyTimeout clamps to a sane window and defaults to 60s", () => {
  assert.strictEqual(readyTimeout(undefined), 60000);
  assert.strictEqual(readyTimeout(null), 60000);
  assert.strictEqual(readyTimeout(""), 60000);
  assert.strictEqual(readyTimeout(30), 30000);
  assert.strictEqual(readyTimeout(1), 1000);
  assert.strictEqual(readyTimeout(600), 600000);
});

test("readyTimeout refuses values that would hold a request open forever", () => {
  for (const bad of [0, -5, 601, 1e9, Infinity, NaN, "abc", {}, []]) {
    assert.strictEqual(readyTimeout(bad), 60000, `${JSON.stringify(bad)} should fall back to the default`);
  }
});

test("readyTimeout rounds fractional seconds", () => {
  assert.strictEqual(readyTimeout(2.4), 2000);
  assert.strictEqual(readyTimeout(2.6), 3000);
});

/* ---------- the port probe, against a real socket ---------- */

test("the port probe succeeds once something is actually listening", async () => {
  const { port } = await listen();
  const r = await waitReadyFor({ port, alive: () => true }, 5000);
  assert.deepStrictEqual(r, { ok: true });
});

test("the port probe times out on a port nobody holds, and says so", async () => {
  // Bind then immediately release, so the port is real but free.
  const { port, server } = await listen();
  await new Promise((r) => server.close(r));
  const t = Date.now();
  const r = await waitReadyFor({ port, alive: () => true }, 1200);
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /never opened/);
  assert.ok(Date.now() - t >= 1000, "it should have waited for the timeout");
});

test("the port probe gives up early when the process exits", async () => {
  const { port, server } = await listen();
  await new Promise((r) => server.close(r));
  let alive = true;
  setTimeout(() => { alive = false; }, 300);
  const t = Date.now();
  const r = await waitReadyFor({ port, alive: () => alive }, 30000);
  assert.deepStrictEqual(r, { ok: false, why: "process exited" });
  assert.ok(Date.now() - t < 5000, "it must not wait out the full timeout after the process died");
});

/* ---------- the http probe, against a real server ---------- */

test("the http probe succeeds on a 2xx", async () => {
  const { port } = await listen((req, res) => { res.writeHead(200); res.end("ok"); });
  const r = await waitReadyFor({ readyWhen: { http: `http://127.0.0.1:${port}/health` }, alive: () => true }, 5000);
  assert.deepStrictEqual(r, { ok: true });
});

test("the http probe keeps waiting on a 5xx and passes when it recovers", async () => {
  let healthy = false;
  const { port } = await listen((req, res) => { res.writeHead(healthy ? 200 : 503); res.end(); });
  setTimeout(() => { healthy = true; }, 600);
  const r = await waitReadyFor({ readyWhen: { http: `http://127.0.0.1:${port}/` }, alive: () => true }, 8000);
  assert.deepStrictEqual(r, { ok: true });
});

test("the http probe does NOT follow redirects", async () => {
  /* It must never chase a Location header: a redirect could point anywhere,
     including off the machine, and this probe fires repeatedly. A 3xx still
     counts as ready — an app redirecting / to /login IS serving — but the
     target must never receive a request from us. */
  let targetHits = 0;
  const target = await listen((req, res) => { targetHits++; res.writeHead(200); res.end(); });
  const { port } = await listen((req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${target.port}/` });
    res.end();
  });

  const r = await waitReadyFor({ readyWhen: { http: `http://127.0.0.1:${port}/` }, alive: () => true }, 2000);

  assert.strictEqual(targetHits, 0, "the probe followed the redirect — it must not");
  assert.deepStrictEqual(r, { ok: true }, "a 3xx means the service is answering");
});

test("the http probe sends no Stackdeck token", async () => {
  // The probe URL is the user's own service, not our API. Leaking the
  // per-install secret to it would be a real problem.
  let seen = null;
  const { port } = await listen((req, res) => { seen = req.headers; res.writeHead(200); res.end(); });
  await waitReadyFor({ readyWhen: { http: `http://127.0.0.1:${port}/` }, alive: () => true }, 5000);
  assert.ok(seen, "the probe should have made a request");
  for (const h of Object.keys(seen)) {
    assert.ok(!/stackdeck|authorization|cookie/i.test(h), `probe leaked header: ${h}`);
  }
});

test("the http probe times out when nothing ever answers", async () => {
  const { port, server } = await listen((req, res) => res.end());
  await new Promise((r) => server.close(r));
  const r = await waitReadyFor({ readyWhen: { http: `http://127.0.0.1:${port}/` }, alive: () => true }, 1200);
  assert.deepStrictEqual(r, { ok: false, why: "http check never passed" });
});

/* ---------- the log probe ---------- */

test("a bad readyWhen.log regex fails loudly rather than hanging", async () => {
  const r = await waitReadyFor({ readyWhen: { log: "([unclosed" }, logKey: "nope" }, 5000);
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /bad readyWhen\.log regex/);
});

test("the log probe times out with a reason when the pattern never appears", async () => {
  const t = Date.now();
  const r = await waitReadyFor({ readyWhen: { log: "ready in \\d+ms" }, logKey: "silent-svc" }, 900);
  assert.deepStrictEqual(r, { ok: false, why: "log pattern not seen in time" });
  assert.ok(Date.now() - t >= 800);
});

/* ---------- no signal at all ---------- */

test("with no readyWhen and no port, it grants a brief grace and says ready", async () => {
  const t = Date.now();
  const r = await waitReadyFor({ alive: () => true }, 5000);
  assert.deepStrictEqual(r, { ok: true });
  assert.ok(Date.now() - t >= 900, "there should be a short grace period");
});

test("readyWhen precedence: log beats http beats port", async () => {
  // A service with all three configured should use the log probe, which is
  // the most specific signal the author gave us.
  const { port } = await listen((req, res) => { res.writeHead(200); res.end(); });
  const r = await waitReadyFor(
    { readyWhen: { log: "never going to match", http: `http://127.0.0.1:${port}/` }, logKey: "prec", port },
    700);
  assert.strictEqual(r.ok, false);
  assert.match(r.why, /log pattern/, "the log probe should have been the one that ran");
});
