"use strict";
/* Name hygiene. These three functions are the boundary between user input and
   the filesystem, argv and the UI's inline handlers, so the charset rules are
   security invariants rather than taste. */
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "stackdeck-sanitize-"));
process.env.STACKDECK_HOME = HOME;
const { sanitizeBranch, validSvcName, validLabel } = require("../server.js");
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

/* ---------- sanitizeBranch ---------- */

test("ordinary branch names pass through untouched", () => {
  for (const b of ["main", "develop", "v1.2.3", "release_2024", "fix-404"]) {
    assert.strictEqual(sanitizeBranch(b), b);
  }
});

test("feature/foo becomes a single path-safe segment", () => {
  assert.strictEqual(sanitizeBranch("feature/foo"), "feature-foo");
  assert.strictEqual(sanitizeBranch("users/ana/spike"), "users-ana-spike");
});

test("spaces and unicode are replaced", () => {
  assert.strictEqual(sanitizeBranch("my branch"), "my-branch");
  assert.strictEqual(sanitizeBranch("naïve-café"), "na-ve-caf-");
  assert.strictEqual(sanitizeBranch("emoji-🚀-branch"), "emoji---branch");
});

test("a run of unsafe characters collapses to one dash", () => {
  assert.strictEqual(sanitizeBranch("a///b"), "a-b");
  assert.strictEqual(sanitizeBranch("a   b"), "a-b");
});

test('"." and ".." are rejected', () => {
  // These are the two names that would traverse out of the worktrees dir.
  assert.strictEqual(sanitizeBranch("."), "");
  assert.strictEqual(sanitizeBranch(".."), "");
});

test("empty and non-string input is rejected, not coerced into a path", () => {
  for (const bad of ["", null, undefined, 0, false, {}, []]) {
    assert.strictEqual(sanitizeBranch(bad), "", `expected "" for ${JSON.stringify(bad)}`);
  }
});

test("CRITICAL: a branch that looks like a git flag can never survive", () => {
  // A branch literally named `--upload-pack=/tmp/x` would be parsed by git as
  // an OPTION, not a branch, if it ever reached argv as a bare operand. The
  // sanitizer refuses to emit anything starting with a dash, and every git
  // call that takes a branch passes it after a `--` separator.
  for (const hostile of [
    "--upload-pack=/tmp/x",
    "--force",
    "-f",
    "--exec=rm -rf /",
    "-upload-pack",
    "--",
  ]) {
    const out = sanitizeBranch(hostile);
    assert.strictEqual(out, "", `${hostile} must not produce a usable name`);
    assert.strictEqual(out.startsWith("-"), false);
  }
});

test("the sanitized name is always a single, non-escaping path segment", () => {
  const hostile = [
    "../../etc/passwd",
    "..%2f..%2fetc",
    "a/../../b",
    "/absolute/path",
    "with\nnewline",
    "with\0null",
    "with;semicolon",
    "$(whoami)",
    "`id`",
    "..",
    ".",
  ];
  const base = path.join(os.tmpdir(), "worktrees");
  for (const b of hostile) {
    const safe = sanitizeBranch(b);
    if (!safe) continue; // rejected outright, nothing to join
    assert.strictEqual(safe.includes("/"), false, `${b} kept a slash`);
    assert.strictEqual(safe.includes(path.sep), false, `${b} kept a separator`);
    assert.match(safe, /^[A-Za-z0-9._-]+$/, `${b} produced ${safe}`);
    const joined = path.resolve(base, safe);
    assert.strictEqual(path.dirname(joined), base, `${b} escaped to ${joined}`);
  }
});

/* ---------- validSvcName ---------- */

test("valid service names are accepted", () => {
  for (const n of ["api", "orders-api", "web_2", "a", "Postgres.16", "x".repeat(64)]) {
    assert.strictEqual(validSvcName(n), true, `${n} should be valid`);
  }
});

test("a service name over 64 characters is rejected", () => {
  assert.strictEqual(validSvcName("x".repeat(64)), true);
  assert.strictEqual(validSvcName("x".repeat(65)), false);
});

test("path separators and traversal are rejected as service names", () => {
  // The name becomes a log-file path, so this is the invariant that keeps
  // logs inside the log directory.
  for (const n of ["../etc/passwd", "a/b", "a\\b", ".hidden", "-dash-first"]) {
    assert.strictEqual(validSvcName(n), false, `${n} should be rejected`);
  }
});

test("newlines, quotes and markup are rejected as service names", () => {
  for (const n of ["a\nb", "a b", 'a"b', "a'b", "<script>", "a;b", "a$b", "a`b"]) {
    assert.strictEqual(validSvcName(n), false, `${JSON.stringify(n)} should be rejected`);
  }
});

test("empty and non-string service names are rejected", () => {
  for (const n of ["", null, undefined, 42, {}, [], true]) {
    assert.strictEqual(validSvcName(n), false, `${JSON.stringify(n)} should be rejected`);
  }
});

/* ---------- validLabel (section and category names) ---------- */

test("labels are permissive about spacing and punctuation", () => {
  for (const n of ["Work", "Side projects", "Client — Acme", "café ☕", "x".repeat(64)]) {
    assert.strictEqual(validLabel(n), true, `${n} should be valid`);
  }
});

test("labels reject the characters that would break out of the UI's markup", () => {
  // Labels are interpolated into the page, so angle brackets, quotes and
  // backslashes are out; slashes are out because labels also key config.
  for (const n of ["<b>", "a>b", 'a"b', "a'b", "a\\b", "a/b", "a\nb"]) {
    assert.strictEqual(validLabel(n), false, `${JSON.stringify(n)} should be rejected`);
  }
});

test("labels reject empty, over-length and non-string input", () => {
  assert.strictEqual(validLabel(""), false);
  assert.strictEqual(validLabel("x".repeat(65)), false);
  for (const n of [null, undefined, 42, {}, []]) {
    assert.strictEqual(validLabel(n), false, `${JSON.stringify(n)} should be rejected`);
  }
});
