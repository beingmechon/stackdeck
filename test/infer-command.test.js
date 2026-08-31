"use strict";
/* Ecosystem detection, one fixture project per case, plus the precedence
   rules — which are the part that goes quietly wrong when a detector is
   added in the wrong place. Fixture projects live in fixtures/projects/. */
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "stackdeck-infer-"));
process.env.STACKDECK_HOME = HOME;
const { inferCommand, detectProcs } = require("../server.js");
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const PROJECTS = path.join(__dirname, "fixtures", "projects");
const proj = (name) => path.join(PROJECTS, name);

/* Every case as data, so a new ecosystem is one line. The comment column is
   what the detector is actually keying on. */
const CASES = [
  // author intent — these beat every language manifest
  ["bindev", "bin/dev"],                                  // Rails 7+ and friends
  ["makefile", "make dev"],
  ["justfile", "just dev"],
  ["taskfile", "task dev"],

  // JavaScript / TypeScript: runner from the lockfile, script by convention
  ["node-npm", "npm run dev"],
  ["node-pnpm", "pnpm run dev"],
  ["node-yarn", "yarn run dev"],
  ["node-bun", "bun run dev"],
  ["node-start-only", "npm run start"],                   // falls through dev -> start
  ["deno", "deno task dev"],
  ["deno-jsonc", "deno task dev"],                        // comments tolerated

  // Python: toolchain from the lockfile, entry point from convention
  ["python-uv", "uv run python main.py"],
  ["python-poetry-script", "poetry run serve"],           // declared console script wins
  ["python-src-layout", "python3 src/main.py"],
  ["django", "python3 manage.py runserver"],

  // systems & compiled
  ["cargo", "cargo run"],
  ["go", "go run ."],
  ["zig", "zig build run"],
  ["swift", "swift run"],
  ["dotnet", "dotnet run"],

  // JVM
  ["gradle-spring", "./gradlew bootRun"],
  ["gradle-plain", "gradle run"],                         // no wrapper: bare gradle
  ["maven-spring", "mvn spring-boot:run"],

  // Ruby / PHP / Elixir / Dart / Haskell
  ["rails", "bin/rails server"],
  ["rack", "bundle exec rackup"],
  ["laravel", "php artisan serve"],
  ["composer", "composer run dev"],
  ["phoenix", "mix phx.server"],
  ["elixir", "mix run --no-halt"],
  ["flutter", "flutter run"],
  ["dart", "dart run"],
  ["haskell", "stack run"],

  // containers, last resort
  ["compose", "docker compose up"],
];

for (const [dir, expected] of CASES) {
  test(`inferCommand: ${dir} -> ${expected}`, () => {
    assert.strictEqual(inferCommand(proj(dir)), expected);
  });
}

/* ---------- precedence ---------- */

test("a Makefile beats package.json", () => {
  // Documented intent: files that encode the AUTHOR'S intent (bin/dev,
  // Makefile, justfile, Taskfile) rank above language manifests, because a
  // repo that ships a `make dev` target means it.
  assert.strictEqual(inferCommand(proj("make-beats-node")), "make dev");
});

test("package.json beats docker-compose.yml", () => {
  // Compose is the last resort: it only wins when nothing language-level did.
  assert.strictEqual(inferCommand(proj("node-beats-compose")), "npm run dev");
});

/* ---------- nothing to infer ---------- */

test("a folder with no runnable signal returns null", () => {
  assert.strictEqual(inferCommand(proj("plain-folder")), null);
});

test("package.json with no dev/start/serve/develop script returns null", () => {
  assert.strictEqual(inferCommand(proj("node-no-dev-script")), null);
});

test("an empty directory returns null", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "stackdeck-empty-"));
  try {
    assert.strictEqual(inferCommand(empty), null);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("a directory that does not exist returns null rather than throwing", () => {
  assert.strictEqual(inferCommand(path.join(PROJECTS, "no-such-project")), null);
});

test("a malformed package.json does not abort the remaining detectors", () => {
  // Tolerant JSON is the point: one broken manifest must not hide the
  // Cargo.toml sitting next to it.
  assert.strictEqual(inferCommand(proj("broken-json")), "cargo run");
});

/* ---------- multi-process repos ---------- */

test("detectProcs reads a Procfile as an authoritative process list", () => {
  const got = detectProcs(proj("procfile"));
  assert.deepStrictEqual(got.map((p) => [p.name, p.command]), [
    ["web", "bundle exec puma"],
    ["worker", "bundle exec sidekiq"],
  ]);
  assert.strictEqual(got[0].dir, proj("procfile"));
});

test("detectProcs returns null when a repo is really one process", () => {
  assert.strictEqual(detectProcs(proj("procfile-single")), null);
  assert.strictEqual(detectProcs(proj("node-npm")), null);
  assert.strictEqual(detectProcs(proj("plain-folder")), null);
});

test("detectProcs expands pnpm workspace packages with the right runner", () => {
  assert.deepStrictEqual(
    detectProcs(proj("pnpm-workspace")).map((p) => [p.name, p.command]),
    [["api", "pnpm -F @acme/api dev"], ["web", "pnpm -F @acme/web dev"]],
  );
});

test("detectProcs lists docker-compose services and stops at the dedent", () => {
  // `volumes:` in the fixture must not be read as a service.
  assert.deepStrictEqual(
    detectProcs(proj("compose-multi")).map((p) => [p.name, p.command]),
    [["db", "docker compose up db"], ["redis", "docker compose up redis"]],
  );
});
