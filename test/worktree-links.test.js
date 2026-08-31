"use strict";
/* Symlinking a worktree's heavy directories back at the main checkout. Nearly
   every test here is a REFUSAL: the failure mode that matters is not "we
   didn't save disk", it is "we linked something we shouldn't have and the
   user committed a symlink", or worse, "teardown followed a link and deleted
   the real node_modules". */
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "stackdeck-links-"));
process.env.STACKDECK_HOME = HOME;
process.env.STACKDECK_NO_LISTEN = "1"; // helpers only: do not start the daemon
const { detectEcosystems, heavyDirsFor, linkHeavyDirs, excludeLinkedDirs, humanSize } = require("../server.js");

const temps = [HOME];
const tmpdir = (label) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `stackdeck-${label}-`));
  temps.push(d);
  return d;
};
after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

const hasGit = (() => {
  try { execFileSync("git", ["--version"], { stdio: "pipe" }); return true; } catch { return false; }
})();
const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" }).toString();
const write = (p, c = "x") => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };

/* A real repo, because the tracked-directory check shells out to git and a
   faked one would test nothing. Returns the main checkout's path. */
function repo(label = "main") {
  const dir = tmpdir(label);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.invalid");
  git(dir, "config", "user.name", "t");
  return dir;
}
const commit = (dir) => git(dir, "-c", "user.email=t@example.invalid", "-c", "user.name=t",
  "commit", "-q", "--allow-empty", "-m", "x");

/* ---------- ecosystem detection ---------- */

test("detectEcosystems finds every ecosystem present, not just the first", () => {
  const d = tmpdir("multi");
  write(path.join(d, "package.json"), "{}");
  write(path.join(d, "Cargo.toml"), "[package]");
  // A Makefile-driven repo is where inferCommand would stop early and tell us
  // nothing — this is exactly why detection is separate from it.
  write(path.join(d, "Makefile"), "dev:\n\ttrue\n");
  assert.deepStrictEqual([...detectEcosystems(d)].sort(), ["node", "rust"]);
});

test("detectEcosystems returns nothing for a repo with no markers", () => {
  assert.deepStrictEqual([...detectEcosystems(tmpdir("bare"))], []);
});

test("heavyDirsFor picks the right list per ecosystem", () => {
  const node = tmpdir("eco-node"); write(path.join(node, "package.json"), "{}");
  assert.ok(heavyDirsFor(node).includes("node_modules"));
  assert.ok(heavyDirsFor(node).includes(".next"));
  assert.ok(!heavyDirsFor(node).includes("target"), "a Node repo has no cargo target");

  const rust = tmpdir("eco-rust"); write(path.join(rust, "Cargo.toml"), "[package]");
  assert.deepStrictEqual(heavyDirsFor(rust), ["target"]);

  const py = tmpdir("eco-py"); write(path.join(py, "pyproject.toml"), "[project]");
  assert.deepStrictEqual(heavyDirsFor(py).sort(), [".venv", "__pycache__", "venv"]);
});

test("heavyDirsFor dedupes directories two ecosystems share", () => {
  // "build" is Node and Java; "vendor" is Go and PHP.
  const d = tmpdir("eco-dup");
  write(path.join(d, "package.json"), "{}");
  write(path.join(d, "pom.xml"), "<project/>");
  const dirs = heavyDirsFor(d);
  assert.strictEqual(dirs.filter((x) => x === "build").length, 1, "build must appear once");

  const gp = tmpdir("eco-dup2");
  write(path.join(gp, "go.mod"), "module x");
  write(path.join(gp, "composer.json"), "{}");
  assert.strictEqual(heavyDirsFor(gp).filter((x) => x === "vendor").length, 1);
});

/* ---------- the refusals ---------- */

test("a directory TRACKED by git is never linked", { skip: !hasGit }, () => {
  // The most important rule in the file. A symlink where git expects a
  // directory shows the worktree as dirty and invites committing the symlink.
  const main = repo("tracked");
  write(path.join(main, "package.json"), "{}");
  write(path.join(main, "vendor", "lib.php"), "<?php");
  write(path.join(main, "composer.json"), "{}");
  git(main, "add", "-A"); commit(main);

  const wt = tmpdir("tracked-wt");
  const r = linkHeavyDirs({ name: "s" }, main, wt);

  assert.ok(!r.linked.includes("vendor"), "vendor is tracked and must not be linked");
  assert.strictEqual(fs.existsSync(path.join(wt, "vendor")), false);
  assert.deepStrictEqual(r.skipped.find((x) => x.dir === "vendor"), { dir: "vendor", why: "tracked by git" });
});

test("an untracked heavy directory IS linked (the happy path still works)", { skip: !hasGit }, () => {
  const main = repo("happy");
  write(path.join(main, "package.json"), "{}");
  write(path.join(main, ".gitignore"), "node_modules/\n");
  write(path.join(main, "node_modules", "pkg", "index.js"), "module.exports=1");
  git(main, "add", "-A"); commit(main);

  const wt = tmpdir("happy-wt");
  const r = linkHeavyDirs({ name: "s" }, main, wt);

  assert.ok(r.linked.includes("node_modules"), `expected a link, got ${JSON.stringify(r)}`);
  assert.strictEqual(fs.lstatSync(path.join(wt, "node_modules")).isSymbolicLink(), true);
  // and it resolves to the real thing
  assert.strictEqual(fs.readFileSync(path.join(wt, "node_modules", "pkg", "index.js"), "utf8"), "module.exports=1");
});

test("an existing directory in the worktree is skipped, never clobbered", { skip: !hasGit }, () => {
  const main = repo("clobber");
  write(path.join(main, "package.json"), "{}");
  write(path.join(main, "node_modules", "from-main.js"), "main");
  const wt = tmpdir("clobber-wt");
  write(path.join(wt, "node_modules", "from-worktree.js"), "worktree");

  const r = linkHeavyDirs({ name: "s" }, main, wt);

  assert.ok(!r.linked.includes("node_modules"));
  assert.deepStrictEqual(r.skipped.find((x) => x.dir === "node_modules"),
    { dir: "node_modules", why: "already in the worktree" });
  // the worktree's own copy is untouched, and did NOT become a symlink
  assert.strictEqual(fs.lstatSync(path.join(wt, "node_modules")).isSymbolicLink(), false);
  assert.strictEqual(fs.readFileSync(path.join(wt, "node_modules", "from-worktree.js"), "utf8"), "worktree");
});

test("a file where a directory was expected is not linked", { skip: !hasGit }, () => {
  const main = repo("file");
  write(path.join(main, "package.json"), "{}");
  write(path.join(main, "node_modules"), "this is a file, not a directory");
  const wt = tmpdir("file-wt");
  const r = linkHeavyDirs({ name: "s" }, main, wt);
  assert.ok(!r.linked.includes("node_modules"));
  assert.deepStrictEqual(r.skipped.find((x) => x.dir === "node_modules"),
    { dir: "node_modules", why: "not a plain directory" });
});

test("a directory absent from the main checkout is skipped quietly", { skip: !hasGit }, () => {
  const main = repo("absent");
  write(path.join(main, "package.json"), "{}");
  const wt = tmpdir("absent-wt");
  const r = linkHeavyDirs({ name: "s" }, main, wt);
  assert.deepStrictEqual(r.linked, []);
  assert.ok(r.skipped.every((x) => x.why === "not in the main checkout"));
});

test("linkDirs cannot escape the checkout", { skip: !hasGit }, () => {
  const main = repo("escape");
  const outside = tmpdir("escape-secret");
  write(path.join(outside, "secret.txt"), "do not link me");
  const wt = tmpdir("escape-wt");

  const r = linkHeavyDirs({ name: "s", linkDirs: ["../../etc", "..", "../escape-secret"] }, main, wt);

  assert.deepStrictEqual(r.linked, [], "nothing outside the checkout may be linked");
  assert.ok(r.skipped.every((x) => x.why === "outside the checkout"), JSON.stringify(r.skipped));
  assert.strictEqual(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "do not link me");
});

/* ---------- configuration ---------- */

test("linkDirs: false disables linking entirely", { skip: !hasGit }, () => {
  const main = repo("off");
  write(path.join(main, "package.json"), "{}");
  write(path.join(main, "node_modules", "a.js"), "1");
  const wt = tmpdir("off-wt");

  const r = linkHeavyDirs({ name: "s", linkDirs: false }, main, wt);

  assert.strictEqual(r.disabled, true);
  assert.deepStrictEqual(r.linked, []);
  assert.strictEqual(fs.existsSync(path.join(wt, "node_modules")), false);
});

test("linkDirs: [...] replaces detection outright", { skip: !hasGit }, () => {
  const main = repo("override");
  write(path.join(main, "package.json"), "{}");            // would detect node_modules
  write(path.join(main, "node_modules", "a.js"), "1");
  write(path.join(main, "my-cache", "b.bin"), "1");
  const wt = tmpdir("override-wt");

  const r = linkHeavyDirs({ name: "s", linkDirs: ["my-cache"] }, main, wt);

  assert.deepStrictEqual(r.linked, ["my-cache"], "only the listed directory");
  assert.strictEqual(fs.existsSync(path.join(wt, "node_modules")), false, "detection must not also run");
});

test("a nested linkDirs entry is created under its parent", { skip: !hasGit }, () => {
  const main = repo("nested");
  write(path.join(main, "apps", "web", "node_modules", "a.js"), "1");
  const wt = tmpdir("nested-wt");
  const r = linkHeavyDirs({ name: "s", linkDirs: ["apps/web/node_modules"] }, main, wt);
  assert.deepStrictEqual(r.linked, ["apps/web/node_modules"]);
  assert.strictEqual(fs.readFileSync(path.join(wt, "apps/web/node_modules/a.js"), "utf8"), "1");
});

/* ---------- keeping the worktree clean ---------- */

test("a linked worktree is CLEAN to git, not '?? node_modules'", { skip: !hasGit }, () => {
  /* The trap: a .gitignore written "node_modules/" (the common form) does not
     match a symlink, so without the exclude step the worktree shows the link
     as untracked and `git add -A` commits it. */
  const main = repo("clean");
  write(path.join(main, "package.json"), "{}");
  write(path.join(main, ".gitignore"), "node_modules/\n"); // trailing slash, on purpose
  write(path.join(main, "node_modules", "a.js"), "1");
  git(main, "add", "-A"); commit(main);
  git(main, "branch", "wt-clean");

  const wt = path.join(tmpdir("clean-parent"), "wt");
  git(main, "worktree", "add", "-q", "--end-of-options", wt, "wt-clean");

  const r = linkHeavyDirs({ name: "s" }, main, wt);
  assert.ok(r.linked.includes("node_modules"));
  assert.ok(r.excluded.includes("node_modules"), "the name should have been excluded");

  assert.strictEqual(git(wt, "status", "--porcelain").trim(), "",
    "the worktree must be clean, or the symlink gets committed");
  git(main, "worktree", "remove", "--force", "--end-of-options", wt);
});

test("excludeLinkedDirs is idempotent and never duplicates", { skip: !hasGit }, () => {
  const main = repo("idem");
  assert.deepStrictEqual(excludeLinkedDirs(main, ["node_modules"]), ["node_modules"]);
  assert.deepStrictEqual(excludeLinkedDirs(main, ["node_modules"]), [], "second call adds nothing");
  const body = fs.readFileSync(path.join(main, ".git", "info", "exclude"), "utf8");
  assert.strictEqual(body.split("\n").filter((l) => l.trim() === "node_modules").length, 1);
});

test("excludeLinkedDirs respects a pattern the user already wrote", { skip: !hasGit }, () => {
  const main = repo("respect");
  fs.mkdirSync(path.join(main, ".git", "info"), { recursive: true });
  fs.writeFileSync(path.join(main, ".git", "info", "exclude"), "# mine\nnode_modules\n");
  assert.deepStrictEqual(excludeLinkedDirs(main, ["node_modules"]), []);
  assert.strictEqual(fs.readFileSync(path.join(main, ".git", "info", "exclude"), "utf8"), "# mine\nnode_modules\n");
});

/* ---------- teardown: the one that must never regress ---------- */

test("git worktree remove does NOT follow the symlink and delete the real directory",
  { skip: !hasGit }, () => {
    /* This is the test that matters most in this file. If `git worktree
       remove` ever followed a symlink, removing a branch would silently
       delete the main checkout's node_modules — unrecoverable, and it would
       look like Stackdeck ate your disk rather than saved it. Verified
       against real git rather than assumed. */
    const main = repo("teardown");
    write(path.join(main, "package.json"), "{}");
    write(path.join(main, ".gitignore"), "node_modules/\n");
    write(path.join(main, "node_modules", "precious.js"), "IRREPLACEABLE");
    git(main, "add", "-A"); commit(main);
    git(main, "branch", "feature-x");

    const wt = path.join(tmpdir("teardown-parent"), "wt");
    git(main, "worktree", "add", "-q", "--end-of-options", wt, "feature-x");

    const r = linkHeavyDirs({ name: "s" }, main, wt);
    assert.ok(r.linked.includes("node_modules"), "precondition: the link was made");
    assert.strictEqual(fs.lstatSync(path.join(wt, "node_modules")).isSymbolicLink(), true);

    // exactly what /api/worktree/remove runs
    git(main, "worktree", "remove", "--force", "--end-of-options", wt);
    git(main, "worktree", "prune");

    assert.strictEqual(fs.existsSync(wt), false, "the worktree should be gone");
    assert.strictEqual(
      fs.readFileSync(path.join(main, "node_modules", "precious.js"), "utf8"),
      "IRREPLACEABLE",
      "the MAIN checkout's node_modules must survive removing the worktree",
    );
  });

/* ---------- reporting ---------- */

test("humanSize reads the way a person would write it", () => {
  assert.strictEqual(humanSize(0), "0 B");
  assert.strictEqual(humanSize(512), "512 B");
  assert.strictEqual(humanSize(1024), "1.0 KB");
  assert.strictEqual(humanSize(1536), "1.5 KB");
  assert.strictEqual(humanSize(9.82 * 1024 ** 3), "9.8 GB");
  assert.strictEqual(humanSize(120 * 1024 ** 2), "120 MB");
});

test("the result always reports both what was linked and why the rest was not",
  { skip: !hasGit }, () => {
    const main = repo("report");
    write(path.join(main, "package.json"), "{}");
    write(path.join(main, ".gitignore"), "node_modules/\n");
    write(path.join(main, "node_modules", "a.js"), "1");
    write(path.join(main, "dist", "b.js"), "1");
    git(main, "add", "-A"); commit(main);           // dist is tracked, node_modules is not
    const wt = tmpdir("report-wt");

    const r = linkHeavyDirs({ name: "s" }, main, wt);

    assert.ok(r.linked.includes("node_modules"));
    assert.ok(r.skipped.some((x) => x.dir === "dist" && x.why === "tracked by git"));
    // every candidate is accounted for, one way or the other
    for (const x of r.skipped) assert.ok(x.dir && x.why, `incomplete skip record: ${JSON.stringify(x)}`);
  });

/* ---------- worktree discovery, whatever made them ---------- */

const { parseWorktreeList } = require("../server.js");

test("parseWorktreeList reads main, linked, detached and bare records", () => {
  const out = [
    "worktree /home/dev/app", "HEAD abc123", "branch refs/heads/main", "",
    "worktree /home/dev/app/.claude/worktrees/agent-a", "HEAD def456", "branch refs/heads/agent-a", "",
    "worktree /elsewhere/sibling/agent-b", "HEAD 789abc", "detached", "",
    "worktree /home/dev/app-bare", "bare", "",
  ].join("\n");
  assert.deepStrictEqual(parseWorktreeList(out), [
    { dir: "/home/dev/app", branch: "main", head: "abc123", bare: false, detached: false },
    { dir: "/home/dev/app/.claude/worktrees/agent-a", branch: "agent-a", head: "def456", bare: false, detached: false },
    { dir: "/elsewhere/sibling/agent-b", branch: null, head: "789abc", bare: false, detached: true },
    { dir: "/home/dev/app-bare", branch: null, head: null, bare: true, detached: false },
  ]);
});

test("parseWorktreeList tolerates no trailing blank line and empty input", () => {
  assert.deepStrictEqual(parseWorktreeList("worktree /a\nHEAD z\nbranch refs/heads/b"),
    [{ dir: "/a", branch: "b", head: "z", bare: false, detached: false }]);
  assert.deepStrictEqual(parseWorktreeList(""), []);
  assert.deepStrictEqual(parseWorktreeList("garbage\nmore garbage"), []);
});

test("a path with spaces survives the parse", () => {
  // Worktrees land under "~/Library/Application Support" and the like.
  assert.strictEqual(parseWorktreeList("worktree /Users/d/My Projects/app\nbranch refs/heads/x")[0].dir,
    "/Users/d/My Projects/app");
});

test("worktrees in three different layouts are all discovered", { skip: !hasGit }, () => {
  /* Every agent puts them somewhere different: nested in the repo, a sibling
     directory, a central cache. git tracks absolute paths, so all three come
     back from one `git worktree list` — this pins that we read all of it. */
  const main = repo("layouts");
  write(path.join(main, "f.txt"), "1");
  git(main, "add", "-A"); commit(main);
  for (const b of ["nested", "sibling", "central"]) git(main, "branch", b);

  const central = tmpdir("layouts-central");
  const sibling = tmpdir("layouts-sibling");
  const layouts = {
    nested: path.join(main, ".claude", "worktrees", "nested"),
    sibling: path.join(sibling, "app-sibling"),
    central: path.join(central, "cache", "app-central"),
  };
  for (const [b, dir] of Object.entries(layouts)) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(main, "worktree", "add", "-q", "--end-of-options", dir, b);
  }

  const found = parseWorktreeList(git(main, "worktree", "list", "--porcelain"));
  for (const [b, dir] of Object.entries(layouts)) {
    const w = found.find((x) => x.branch === b);
    assert.ok(w, `${b} was not discovered`);
    assert.strictEqual(fs.realpathSync(w.dir), fs.realpathSync(dir), `${b} resolved to the wrong path`);
  }
  assert.strictEqual(found.length, 4, "the main checkout plus three worktrees");
  for (const dir of Object.values(layouts)) git(main, "worktree", "remove", "--force", "--end-of-options", dir);
});
