"use strict";
/* Three parsers for three text formats, and a wrong answer here is silent
   rather than loud: the board just shows the wrong pid against a port. These
   run against fixtures in the exact shapes lsof, ss, netstat and ps emit.
   Fixtures are hand-written from real captured output — deliberately, so no
   machine's usernames or project paths end up committed. */
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "stackdeck-ports-"));
process.env.STACKDECK_HOME = HOME;
process.env.STACKDECK_NO_LISTEN = "1"; // helpers only: do not start the daemon
const {
  parseLsofPortPids, parseSsPortPids,
  parseLsofListeners, parseSsListeners,
  parsePsTable, parsePgidTable,
  parseNetstatPorts, parseSsPorts,
  etimeSec, isSystemPath,
} = require("../server.js");
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const fixture = (n) => fs.readFileSync(path.join(__dirname, "fixtures", n), "utf8");
// Comparing plain objects gives a readable diff when a port maps to the wrong pid.
const obj = (map) => Object.fromEntries([...map.entries()].map(([k, v]) => [k, v]));

/* ---------- lsof -Fpn: port -> pid ---------- */

test("parseLsofPortPids maps every listening port to its pid", () => {
  assert.deepStrictEqual(obj(parseLsofPortPids(fixture("lsof-Fpn.txt"))), {
    3000: 101,
    8080: 202,
    5432: 202,
  });
});

test("parseLsofPortPids: the first pid on a port wins", () => {
  // pid 303 also has :3000 in the fixture; lsof lists oldest first and the
  // board wants the owner, not the most recent to appear.
  assert.strictEqual(parseLsofPortPids(fixture("lsof-Fpn.txt")).get(3000), 101);
});

test("parseLsofPortPids: IPv6 rows are counted, not dropped", () => {
  assert.strictEqual(parseLsofPortPids("p7\nf3\nn[::1]:5173\n").get(5173), 7);
});

test("parseLsofPortPids: wildcard and truncated rows are skipped", () => {
  // 'n*:*' has no port, 'n127.0.0.1:' is truncated — neither may invent a key.
  const m = parseLsofPortPids(fixture("lsof-Fpn.txt"));
  assert.ok(!m.has(NaN), "NaN must never become a port key");
  assert.strictEqual([...m.keys()].every(Number.isInteger), true);
});

test("parseLsofPortPids: an 'n' line before any 'p' line is ignored", () => {
  assert.strictEqual(parseLsofPortPids("n127.0.0.1:3000\n").size, 0);
});

test("parseLsofPortPids on empty input returns an empty map", () => {
  assert.strictEqual(parseLsofPortPids("").size, 0);
});

/* ---------- ss -ltnpH: port -> pid ---------- */

test("parseSsPortPids maps every listening port to its pid", () => {
  assert.deepStrictEqual(obj(parseSsPortPids(fixture("ss-ltnpH.txt"))), {
    3000: 101,
    5432: 202,
    22: 303,
  });
});

test("parseSsPortPids: a row with no process column yields no pid", () => {
  // ss run unprivileged shows root-owned listeners with no users:(()) part.
  // Port 80 is in the fixture exactly for this.
  assert.strictEqual(parseSsPortPids(fixture("ss-ltnpH.txt")).has(80), false);
});

test("parseSsPortPids: IPv6 rows resolve to the port, not a bracket fragment", () => {
  const m = parseSsPortPids("LISTEN 0 128 [::]:22 [::]:* users:((\"sshd\",pid=303,fd=4))\n");
  assert.deepStrictEqual(obj(m), { 22: 303 });
});

test("parseSsPortPids on empty input returns an empty map", () => {
  assert.strictEqual(parseSsPortPids("").size, 0);
});

/* ---------- lsof -FpcLn: the full listener table ---------- */

const addrs = (byPid, pid) =>
  Object.fromEntries([...byPid.get(pid).addrs].map(([port, set]) => [port, [...set].sort()]));

test("parseLsofListeners returns pid, command, user and addresses", () => {
  const byPid = parseLsofListeners(fixture("lsof-FpcLn.txt"));
  assert.deepStrictEqual([...byPid.keys()], [101, 202, 303]);

  assert.strictEqual(byPid.get(101).proc, "node");
  assert.strictEqual(byPid.get(101).user, "devuser");
  // One pid listening on the same port over IPv4 and IPv6 is ONE row with
  // two addresses — not two rows.
  assert.deepStrictEqual(addrs(byPid, 101), { 3000: ["127.0.0.1:3000", "[::1]:3000"] });

  assert.strictEqual(byPid.get(202).proc, "postgres");
  assert.deepStrictEqual(addrs(byPid, 202), { 5432: ["127.0.0.1:5432"] });

  assert.strictEqual(byPid.get(303).proc, "docker-proxy");
  assert.strictEqual(byPid.get(303).user, "root");
  assert.deepStrictEqual(addrs(byPid, 303), { 8080: ["*:8080"] });
});

test("parseLsofListeners: a record with no address lines still appears", () => {
  const byPid = parseLsofListeners("p42\ncnode\nLdevuser\n");
  assert.strictEqual(byPid.get(42).proc, "node");
  assert.strictEqual(byPid.get(42).addrs.size, 0);
});

test("parseLsofListeners: a truncated final line does not throw", () => {
  const byPid = parseLsofListeners("p42\ncnode\nn127.0.0.1:");
  assert.strictEqual(byPid.get(42).addrs.size, 0);
});

test("parseLsofListeners on empty input returns an empty map", () => {
  assert.strictEqual(parseLsofListeners("").size, 0);
});

/* ---------- ss -ltnpH: the full listener table ---------- */

test("parseSsListeners returns the same shape as the lsof parser", () => {
  const byPid = parseSsListeners(fixture("ss-ltnpH.txt"));
  assert.deepStrictEqual([...byPid.keys()], [101, 202, 303]);

  assert.strictEqual(byPid.get(101).proc, "node");
  assert.deepStrictEqual(addrs(byPid, 101), { 3000: ["127.0.0.1:3000", "[::1]:3000"] });

  assert.strictEqual(byPid.get(202).proc, "postgres");
  assert.deepStrictEqual(addrs(byPid, 202), { 5432: ["127.0.0.1:5432"] });

  assert.strictEqual(byPid.get(303).proc, "sshd");
  assert.deepStrictEqual(addrs(byPid, 303), { 22: ["[::]:22"] });
});

test("parseSsListeners: ss has no user column, so user is empty", () => {
  // Deliberate: allListeners() only refuses to kill when it KNOWS the owner
  // is somebody else, and "" means "unknown", not "you".
  const byPid = parseSsListeners(fixture("ss-ltnpH.txt"));
  assert.strictEqual(byPid.get(101).user, "");
});

test("parseSsListeners: a row with no process column is dropped entirely", () => {
  const byPid = parseSsListeners(fixture("ss-ltnpH.txt"));
  assert.strictEqual([...byPid.values()].some((e) => e.addrs.has(80)), false);
});

test("parseSsListeners on empty input returns an empty map", () => {
  assert.strictEqual(parseSsListeners("").size, 0);
});

/* ---------- netstat / ss: every listening port, ownership aside ---------- */

test("parseNetstatPorts collects LISTEN rows across tcp4, tcp6 and tcp46", () => {
  assert.deepStrictEqual(
    [...parseNetstatPorts(fixture("netstat-an-tcp.txt"))].sort((a, b) => a - b),
    [3100, 5432, 8000, 8899],
  );
});

test("parseNetstatPorts ignores ESTABLISHED rows and headers", () => {
  const ports = parseNetstatPorts(fixture("netstat-an-tcp.txt"));
  // 52340 is the local port of an ESTABLISHED row in the fixture.
  assert.strictEqual(ports.has(52340), false);
  assert.strictEqual(ports.has(443), false);
});

test("parseNetstatPorts on empty input returns an empty set", () => {
  assert.strictEqual(parseNetstatPorts("").size, 0);
});

test("parseSsPorts collects every listening port including IPv6", () => {
  assert.deepStrictEqual(
    [...parseSsPorts(fixture("ss-ltnH.txt"))].sort((a, b) => a - b),
    [22, 80, 3000, 5432],
  );
});

test("parseSsPorts on empty or short lines returns nothing, and does not throw", () => {
  assert.strictEqual(parseSsPorts("").size, 0);
  assert.strictEqual(parseSsPorts("\n\nLISTEN 0 128\n").size, 0);
});

/* ---------- ps ---------- */

test("parsePsTable reads pid, ppid, pgid, age, rss and the full command", () => {
  const meta = parsePsTable(fixture("ps-table.txt"));
  assert.deepStrictEqual([...meta.keys()].sort((a, b) => a - b), [1, 101, 202, 303, 536]);

  assert.deepStrictEqual(meta.get(101), {
    ppid: 536,
    pgid: 101,
    age: 1 * 3600 + 23 * 60 + 45,
    rss: 84320,
    cmd: "node /opt/projects/orders-api/node_modules/.bin/vite --port 3000",
  });
  // The command must keep its arguments — that is the whole value of the row.
  assert.match(meta.get(202).cmd, /postgres -D /);
  assert.strictEqual(meta.get(1).age, 39 * 86400 + 14 * 3600 + 49 * 60 + 32);
  assert.strictEqual(meta.get(303).age, 9);
});

test("parsePsTable skips lines that do not match the column layout", () => {
  assert.strictEqual(parsePsTable("  PID  PPID  PGID ELAPSED   RSS COMMAND\n").size, 0);
  assert.strictEqual(parsePsTable("").size, 0);
});

test("parsePgidTable maps pid to process-group id", () => {
  assert.deepStrictEqual(obj(parsePgidTable(fixture("ps-pgid.txt"))), {
    1: 1, 101: 101, 303: 101, 536: 536,
  });
});

test("parsePgidTable ignores lines that are not exactly two columns", () => {
  assert.strictEqual(parsePgidTable("\n  1\n  1  2  3\n").size, 0);
});

/* ---------- etime ---------- */

test("etimeSec handles every ps elapsed-time shape", () => {
  assert.strictEqual(etimeSec("00:09"), 9);                       // mm:ss
  assert.strictEqual(etimeSec("05:12"), 312);
  assert.strictEqual(etimeSec("01:23:45"), 5025);                 // hh:mm:ss
  assert.strictEqual(etimeSec("2-03:04:05"), 2 * 86400 + 11045);  // dd-hh:mm:ss
});

test("etimeSec returns null on anything it does not recognise", () => {
  for (const bad of ["", "9", "Mon Aug 31", "abc", "1:2:3:4"]) {
    assert.strictEqual(etimeSec(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

/* ---------- system-path classification ---------- */

test("isSystemPath flags OS-shipped binaries by path, never by name", () => {
  assert.strictEqual(isSystemPath("/usr/libexec/rapportd"), true);
  assert.strictEqual(isSystemPath("/System/Library/CoreServices/ControlCenter"), true);
  assert.strictEqual(isSystemPath("/lib/systemd/systemd-resolved"), true);
  // Your own binary that happens to share a name is not a system process.
  assert.strictEqual(isSystemPath("/opt/projects/tools/rapportd"), false);
  assert.strictEqual(isSystemPath("node /opt/projects/web/server.js"), false);
  assert.strictEqual(isSystemPath(""), false);
});
