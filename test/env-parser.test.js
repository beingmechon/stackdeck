"use strict";
/* .env parsing. The contract is deliberately small — this is a loader, not a
   shell — and these tests pin the "deliberately" part: no interpolation, no
   multi-line values. Both are documented behaviour, not oversights. */
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// server.js writes config/logs into STACKDECK_HOME the moment it is required,
// so point it somewhere disposable before the require.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "stackdeck-env-"));
process.env.STACKDECK_HOME = HOME;
const { parseEnv, parseEnvFile } = require("../server.js");
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

test("plain KEY=value", () => {
  assert.deepStrictEqual(parseEnv("PORT=3000\nNODE_ENV=development\n"), {
    PORT: "3000",
    NODE_ENV: "development",
  });
});

test("export prefix is stripped", () => {
  assert.deepStrictEqual(parseEnv("export API_KEY=abc123\n"), { API_KEY: "abc123" });
});

test("quoted values, single and double", () => {
  assert.deepStrictEqual(parseEnv(`A="hello world"\nB='single quoted'\n`), {
    A: "hello world",
    B: "single quoted",
  });
});

test("anything after a closing quote is ignored", () => {
  assert.deepStrictEqual(parseEnv(`A="value" trailing junk\n`), { A: "value" });
});

test("full-line comments and blank lines are skipped", () => {
  assert.deepStrictEqual(parseEnv("# a comment\n\n  \nPORT=3000\n#PORT=9999\n"), { PORT: "3000" });
});

test("a value that is only a comment is skipped, not set empty", () => {
  assert.deepStrictEqual(parseEnv("A=#nope\nB=2\n"), { B: "2" });
});

test("inline comments are stripped from unquoted values", () => {
  assert.deepStrictEqual(parseEnv("PORT=3000 # the dev port\n"), { PORT: "3000" });
});

test("a '#' inside a quoted value survives", () => {
  assert.deepStrictEqual(parseEnv(`PASSWORD="a#b"\n`), { PASSWORD: "a#b" });
});

test("mid-value '#' with no leading space is kept", () => {
  // The inline-comment strip requires whitespace before the '#', so a URL
  // fragment is not silently truncated.
  assert.deepStrictEqual(parseEnv("URL=http://x/a#frag\n"), { URL: "http://x/a#frag" });
});

test("a value STARTING with '#' drops the key (known gotcha)", () => {
  // `COLOR=#ff0000` reads as a comment, so the variable is not set at all.
  // Quote it to keep it. Pinned here because it is surprising, not obvious.
  assert.deepStrictEqual(parseEnv("COLOR=#ff0000\n"), {});
  assert.deepStrictEqual(parseEnv(`COLOR="#ff0000"\n`), { COLOR: "#ff0000" });
});

test("surrounding whitespace around key, '=' and value is trimmed", () => {
  assert.deepStrictEqual(parseEnv("   KEY   =   value   \n"), { KEY: "value" });
});

test("empty value is allowed", () => {
  assert.deepStrictEqual(parseEnv("EMPTY=\n"), { EMPTY: "" });
});

test("malformed lines are skipped, not thrown", () => {
  const out = parseEnv([
    "this is not an assignment",
    "1BAD=leading digit is not a valid key",
    "BAD-KEY=dashes are not valid",
    "=novalue",
    "GOOD=yes",
  ].join("\n"));
  assert.deepStrictEqual(out, { GOOD: "yes" });
});

test("later assignments win", () => {
  assert.deepStrictEqual(parseEnv("A=1\nA=2\n"), { A: "2" });
});

test("NO interpolation: $VAR stays literal", () => {
  // This is the whole point of the parser being a loader rather than a shell.
  assert.deepStrictEqual(parseEnv("B=world\nA=$B\nC=${B}\nD=hello $B\n"), {
    B: "world",
    A: "$B",
    C: "${B}",
    D: "hello $B",
  });
});

test("NO interpolation inside double quotes either", () => {
  assert.deepStrictEqual(parseEnv(`A="$HOME/bin"\n`), { A: "$HOME/bin" });
});

test("escape sequences are NOT decoded", () => {
  assert.deepStrictEqual(parseEnv(String.raw`A="line1\nline2"` + "\n"), { A: String.raw`line1\nline2` });
});

test("multiline values are NOT supported — a value ends at its newline", () => {
  // Documented limitation. A quoted value spanning lines yields the first
  // line only (unterminated quote, so no quote match) and the continuation
  // lines are skipped as malformed.
  const out = parseEnv('CERT="-----BEGIN KEY-----\nmiddle line\n-----END KEY-----"\nAFTER=ok\n');
  assert.deepStrictEqual(out, { CERT: '"-----BEGIN KEY-----', AFTER: "ok" });
});

test("CRLF line endings leave no stray carriage return", () => {
  assert.deepStrictEqual(parseEnv("A=1\r\nB=2\r\n"), { A: "1", B: "2" });
});

test("parseEnvFile reads a real file", () => {
  const f = path.join(HOME, "sample.env");
  fs.writeFileSync(f, "export DATABASE_URL='postgres://localhost/dev'\nDEBUG=1 # noisy\n");
  assert.deepStrictEqual(parseEnvFile(f), {
    DATABASE_URL: "postgres://localhost/dev",
    DEBUG: "1",
  });
});

test("parseEnvFile on a missing file returns {} rather than throwing", () => {
  assert.deepStrictEqual(parseEnvFile(path.join(HOME, "does-not-exist.env")), {});
});

test("parseEnvFile on a directory returns {} rather than throwing", () => {
  assert.deepStrictEqual(parseEnvFile(HOME), {});
});
