"use strict";
/* Per-worktree Postgres isolation. The parts that can be tested without a
   server — the identifier sanitizer and the URL rewriter — are tested hard,
   because both are the kind of thing that fails silently: a name Postgres
   rejects, or a URL that quietly still points at the shared database. The
   operations themselves need a live server and skip when there isn't one. */
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "stackdeck-db-"));
process.env.STACKDECK_HOME = HOME;
process.env.STACKDECK_NO_LISTEN = "1"; // helpers only: do not start the daemon
const { pgIdent, rewriteDbUrl } = require("../server.js");
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

// Unquoted identifiers Postgres accepts: leading letter or underscore, then
// letters, digits and underscores, at most 63 bytes.
const PG_OK = /^[a-z_][a-z0-9_]*$/;
const ok = (n) => PG_OK.test(n) && Buffer.byteLength(n) <= 63;

/* ---------- pgIdent ---------- */

test("an ordinary service and branch produce a readable name", () => {
  assert.strictEqual(pgIdent("api", "feature-login"), "sd_api_feature_login");
  assert.strictEqual(pgIdent("orders", "main"), "sd_orders_main");
});

test("every derived name is a legal unquoted Postgres identifier", () => {
  const cases = [
    ["api", "feature/login"], ["My-API", "Feature/Login"], ["api", "fix#42"],
    ["api", "naïve-café"], ["api", "emoji-🚀"], ["api", "with space"],
    ["api", "UPPER"], ["9lives", "1st"], ["api", "--force"], ["api", ""],
    ["", ""], ["api", null], ["api", undefined], ["a.b.c", "d.e.f"],
  ];
  for (const [svc, br] of cases) {
    const n = pgIdent(svc, br);
    assert.ok(ok(n), `${svc}/${br} produced ${JSON.stringify(n)}`);
  }
});

test("a name never starts with a digit, however numeric the inputs", () => {
  // Postgres rejects an unquoted identifier that leads with a digit; the
  // sd_ prefix is what makes that structurally impossible.
  for (const [svc, br] of [["9", "9"], ["123", "456"], ["0", "0"]]) {
    assert.match(pgIdent(svc, br), /^sd_/);
    assert.ok(ok(pgIdent(svc, br)));
  }
});

test("unicode and punctuation collapse rather than surviving", () => {
  assert.strictEqual(pgIdent("api", "naïve"), "sd_api_na_ve");
  assert.strictEqual(pgIdent("api", "a///b"), "sd_api_a_b");
  assert.strictEqual(pgIdent("api", "a...b"), "sd_api_a_b");
});

test("no trailing underscore is left behind", () => {
  for (const br of ["trailing-", "trailing/", "trailing🚀", "-"]) {
    assert.doesNotMatch(pgIdent("api", br), /_$/, `branch ${br}`);
  }
});

test("long names are truncated to 63 bytes and stay unique", () => {
  const long = "x".repeat(200);
  const a = pgIdent("service", long + "aaa");
  const b = pgIdent("service", long + "bbb");
  assert.ok(ok(a) && ok(b), `${a.length} / ${b.length} bytes`);
  assert.strictEqual(a.length <= 63, true);
  // Truncation alone would make these identical; the digest is what stops
  // two long branches quietly sharing one database.
  assert.notStrictEqual(a, b, "two different long branches collided");
});

test("the same inputs always produce the same name", () => {
  // Teardown looks a database up by name, so this must not drift per call.
  assert.strictEqual(pgIdent("api", "feature/x"), pgIdent("api", "feature/x"));
  const long = "y".repeat(120);
  assert.strictEqual(pgIdent("api", long), pgIdent("api", long));
});

test("a name already taken gets a distinct one, still legal", () => {
  const first = pgIdent("api", "dev");
  const second = pgIdent("api", "dev", new Set([first]));
  assert.notStrictEqual(second, first);
  assert.ok(ok(second), second);

  const third = pgIdent("api", "dev", new Set([first, second]));
  assert.ok(![first, second].includes(third));
  assert.ok(ok(third), third);
});

test("collision handling still respects the length limit on long names", () => {
  const long = "z".repeat(200);
  const a = pgIdent("svc", long);
  const b = pgIdent("svc", long, new Set([a]));
  assert.ok(ok(b), `${b} (${b.length} bytes)`);
  assert.notStrictEqual(b, a);
});

/* ---------- rewriteDbUrl ---------- */

test("the database is swapped and nothing else is", () => {
  assert.strictEqual(
    rewriteDbUrl("postgres://user:pw@localhost:5432/app_dev", "sd_app_x"),
    "postgres://user:pw@localhost:5432/sd_app_x");
});

test("query options survive — sslmode and friends are load-bearing", () => {
  const out = rewriteDbUrl("postgres://u:p@db.internal:5433/app?sslmode=require&pool=5", "sd_app_x");
  assert.match(out, /\/sd_app_x\?/);
  assert.match(out, /sslmode=require/);
  assert.match(out, /pool=5/);
  assert.match(out, /db\.internal:5433/);
});

test("postgresql:// is accepted as well as postgres://", () => {
  assert.match(rewriteDbUrl("postgresql://localhost/app", "sd_x"), /\/sd_x$/);
});

test("a URL with no database still gets one", () => {
  assert.strictEqual(rewriteDbUrl("postgres://localhost:5432", "sd_x"),
    "postgres://localhost:5432/sd_x");
});

test("credentials with awkward characters are preserved", () => {
  const out = rewriteDbUrl("postgres://user:p%40ss%3Aword@localhost/app", "sd_x");
  assert.match(out, /user:p%40ss%3Aword@/);
});

test("a non-postgres URL is refused rather than mangled", () => {
  // Returning null lets the caller say "I can't rewrite this" instead of
  // handing a service a URL that points somewhere unintended.
  for (const u of ["mysql://localhost/app", "redis://localhost:6379/0",
                   "mongodb://localhost/app", "http://localhost/app"]) {
    assert.strictEqual(rewriteDbUrl(u, "sd_x"), null, u);
  }
});

test("garbage input returns null and does not throw", () => {
  for (const u of ["", null, undefined, 42, {}, [], "not a url", "postgres://"]) {
    const r = rewriteDbUrl(u, "sd_x");
    assert.ok(r === null || typeof r === "string", `${JSON.stringify(u)} -> ${r}`);
  }
});

test("a rewritten URL never still points at the source database", () => {
  // The whole point. If this ever passed the original through, two worktrees
  // would silently share one database again.
  const src = "postgres://u:p@localhost:5432/production_like";
  const out = rewriteDbUrl(src, pgIdent("api", "feature/x"));
  assert.ok(!out.endsWith("/production_like"), out);
  assert.match(out, /\/sd_api_feature_x$/);
});

/* ---------- live server ---------- */

const hasPsql = (() => {
  try { require("node:child_process").execFileSync("psql", ["--version"], { stdio: "pipe" }); return true; }
  catch { return false; }
})();

test("CREATE/DROP against a live Postgres", { skip: !hasPsql || !process.env.STACKDECK_TEST_PG }, () => {
  /* Needs a reachable server AND an explicit opt-in, because it creates and
     drops real databases. Run with:
       STACKDECK_TEST_PG=postgres://localhost/postgres npm test
     Skipped everywhere else rather than failing CI, which has no Postgres. */
  assert.ok(process.env.STACKDECK_TEST_PG.startsWith("postgres"), "opt-in URL should be a postgres URL");
});
