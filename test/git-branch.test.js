"use strict";
/* gitBranchFast reads .git/HEAD directly instead of spawning git — that is
   why scanning a few hundred projects is cheap. The cost is that it has to
   handle every shape .git comes in itself, which is what these pin.

   Everything here builds a real directory under os.tmpdir(): a committed
   fixture cannot contain a .git directory, and hardcoded paths would not
   survive the move between macOS and Linux. */
const { test, after } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "stackdeck-git-"));
process.env.STACKDECK_HOME = HOME;
process.env.STACKDECK_NO_LISTEN = "1"; // helpers only: do not start the daemon
const { gitBranchFast } = require("../server.js");

const temps = [HOME];
const tmpdir = (label) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `stackdeck-${label}-`));
  temps.push(d);
  return d;
};
after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

// A repo whose .git is a normal directory.
function repo(headContents) {
  const dir = tmpdir("repo");
  fs.mkdirSync(path.join(dir, ".git"));
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), headContents);
  return dir;
}

test("a normal checkout returns the branch name", () => {
  assert.strictEqual(gitBranchFast(repo("ref: refs/heads/main\n")), "main");
});

test("a slashed branch name keeps its slashes", () => {
  // Only the "refs/heads/" prefix is stripped — the rest is the branch.
  assert.strictEqual(gitBranchFast(repo("ref: refs/heads/feature/login\n")), "feature/login");
});

test("HEAD without a trailing newline still parses", () => {
  assert.strictEqual(gitBranchFast(repo("ref: refs/heads/develop")), "develop");
});

test("a detached HEAD (raw sha) reports (detached)", () => {
  assert.strictEqual(gitBranchFast(repo("9ecf1a3f4b2c8d1e0a7f6b5c4d3e2f1a0b9c8d7e\n")), "(detached)");
});

test("a HEAD pointing at a tag ref is not mistaken for a branch", () => {
  assert.strictEqual(gitBranchFast(repo("ref: refs/tags/v1.0.0\n")), "(detached)");
});

test("the worktree case: .git is a FILE containing 'gitdir: <path>'", () => {
  // This is what a git worktree (and a submodule) looks like, and it is the
  // shape that matters most here: coding agents create worktrees constantly.
  const main = tmpdir("wt-main");
  const gitdir = path.join(main, ".git", "worktrees", "feature-x");
  fs.mkdirSync(gitdir, { recursive: true });
  fs.writeFileSync(path.join(gitdir, "HEAD"), "ref: refs/heads/feature-x\n");

  const wt = tmpdir("wt-checkout");
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${gitdir}\n`);

  assert.strictEqual(gitBranchFast(wt), "feature-x");
});

test("a relative gitdir: path resolves against the checkout", () => {
  const base = tmpdir("wt-rel");
  const gitdir = path.join(base, "meta");
  fs.mkdirSync(gitdir);
  fs.writeFileSync(path.join(gitdir, "HEAD"), "ref: refs/heads/rel-branch\n");
  const wt = path.join(base, "checkout");
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, ".git"), "gitdir: ../meta\n");

  assert.strictEqual(gitBranchFast(wt), "rel-branch");
});

test("a .git file with no gitdir: line returns null", () => {
  const dir = tmpdir("wt-bad");
  fs.writeFileSync(path.join(dir, ".git"), "this is not a gitlink\n");
  assert.strictEqual(gitBranchFast(dir), null);
});

test("a .git file pointing at a directory with no HEAD returns null", () => {
  const dir = tmpdir("wt-nohead");
  const gitdir = tmpdir("wt-empty-gitdir");
  fs.writeFileSync(path.join(dir, ".git"), `gitdir: ${gitdir}\n`);
  assert.strictEqual(gitBranchFast(dir), null);
});

test("a directory with no .git at all returns null and does not throw", () => {
  assert.strictEqual(gitBranchFast(tmpdir("plain")), null);
});

test("a directory that does not exist returns null and does not throw", () => {
  assert.strictEqual(gitBranchFast(path.join(os.tmpdir(), "stackdeck-definitely-not-here")), null);
});

test("a .git directory with no HEAD returns null", () => {
  const dir = tmpdir("nohead");
  fs.mkdirSync(path.join(dir, ".git"));
  assert.strictEqual(gitBranchFast(dir), null);
});

test("it agrees with real git in a real repository", () => {
  // The fixtures above are hand-built; this one proves the shape is right by
  // asking git itself. Skipped where git is unavailable.
  const { execFileSync } = require("node:child_process");
  const dir = tmpdir("realgit");
  try {
    const run = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
    run("init", "-q", "-b", "trunk");
    assert.strictEqual(gitBranchFast(dir), "trunk");
    run("-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x");
    run("checkout", "-q", "-b", "feature/nested");
    assert.strictEqual(gitBranchFast(dir), "feature/nested");
    const sha = run("rev-parse", "HEAD").toString().trim();
    run("checkout", "-q", "--detach", sha);
    assert.strictEqual(gitBranchFast(dir), "(detached)");
  } catch (e) {
    if (e.code === "ENOENT") return; // no git on this machine: nothing to compare against
    throw e;
  }
});
