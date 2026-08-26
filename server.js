#!/usr/bin/env node
/**
 * Stackdeck daemon — your projects folder, as a control panel.
 *
 * Zero dependencies (Node >= 18.13 builtins only). Binds to 127.0.0.1.
 *
 *   node server.js            run in foreground
 *   stackdeck                  (CLI) start daemon + open the board
 *
 * State lives in $STACKDECK_HOME, else $XDG_CONFIG_HOME/stackdeck
 * (default ~/.config/stackdeck):
 *   config.json   services, sections, project roots, categories
 *   logs/         one log file per service + the daemon's own log
 */
"use strict";
// Last-resort guards: a bug on one request path must never kill the board.
process.on("uncaughtException", (e) => console.error("uncaught exception:", e));
process.on("unhandledRejection", (e) => console.error("unhandled rejection:", e));
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execFileSync } = require("child_process");

// Version comes from package.json so `npm version` is the single source of truth.
const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version; }
  catch { return "unknown"; }
})();
const ROOT = __dirname;

/* ---------- state directory & config ---------- */

// Only "~" and "~/…" are home shorthand; "~user" is left untouched.
const expand = (p) => {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
};
// Locale-independent sort, so listings are identical on every machine.
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function resolveHome() {
  if (process.env.STACKDECK_HOME) return expand(process.env.STACKDECK_HOME);
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const home = path.join(xdg, "stackdeck");
  // One-time migration from pre-rename (devboard) and pre-0.1 (~/.devboard) locations.
  for (const legacy of [path.join(xdg, "devboard"), path.join(os.homedir(), ".devboard")]) {
    if (fs.existsSync(home) || !fs.existsSync(path.join(legacy, "config.json"))) continue;
    try { fs.mkdirSync(path.dirname(home), { recursive: true }); fs.renameSync(legacy, home); }
    catch { return legacy; } // cross-device or permission issue: stay on the old path
  }
  return home;
}

const HOME_DIR = resolveHome();
const CONFIG_PATH = path.join(HOME_DIR, "config.json");
const LOG_DIR = path.join(HOME_DIR, "logs");
// 0700: config holds env vars (often API keys) and logs hold whatever
// services print — none of it is for other users on a shared machine.
fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
try { fs.chmodSync(HOME_DIR, 0o700); fs.chmodSync(LOG_DIR, 0o700); } catch {}

// Names end up in log-file paths and in the UI's inline handlers — the strict
// charset (enforced at API *and* load time) is a security invariant, not taste.
const validSvcName = (n) => typeof n === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(n);
const validLabel = (n) => typeof n === "string" && n.length >= 1 && n.length <= 64 && !/[<>"'\\\/\n]/.test(n);

// A corrupt config must not brick the daemon: set it aside and start fresh.
let cfg = {};
if (fs.existsSync(CONFIG_PATH)) {
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error("not an object");
  } catch (e) {
    const broken = `${CONFIG_PATH}.broken-${Date.now()}`;
    fs.renameSync(CONFIG_PATH, broken);
    console.error(`config.json is invalid (${e.message}) — moved to ${broken}, starting with defaults`);
    cfg = {};
  }
}
// Normalize every field we index into; old or hand-edited configs stay safe.
cfg.port = Number.isInteger(cfg.port) && cfg.port >= 1 && cfg.port <= 65535 ? cfg.port : 8899;
cfg.services = Array.isArray(cfg.services)
  ? cfg.services.filter((s) => {
      const ok = s && typeof s === "object" && validSvcName(s.name);
      if (!ok && s && s.name) console.error(`dropping service with invalid name from config: ${JSON.stringify(s.name)}`);
      return ok;
    }) : [];
cfg.groups = Array.isArray(cfg.groups) ? cfg.groups.filter(validLabel) : [];
cfg.projectRoots = Array.isArray(cfg.projectRoots) && cfg.projectRoots.length ? cfg.projectRoots : ["~/Projects"];

// Atomic write: a crash mid-save must never truncate the config.
const saveCfg = () => {
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH);
};
if (!fs.existsSync(CONFIG_PATH)) saveCfg();
try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {} // tighten pre-existing files too

const findSvc = (name) => cfg.services.find((s) => s.name === name);
const svcDir = (s) => expand(s.dir);

/* ---------- auth token ----------
   localhost is not a security boundary: any local process can reach this
   port, and this daemon executes shell commands. A per-install secret
   (0600, same-user readable) gates every API call. The web page receives
   it by being served from disk by this same daemon. */
const crypto = require("crypto");
const SECRET_PATH = path.join(HOME_DIR, "secret");
let TOKEN = "";
try { TOKEN = fs.readFileSync(SECRET_PATH, "utf8").trim(); } catch {}
if (!TOKEN || TOKEN.length < 32) {
  TOKEN = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(SECRET_PATH, TOKEN + "\n", { mode: 0o600 });
}
function tokenOk(t) {
  if (typeof t !== "string" || !t) return false;
  const a = Buffer.from(t), b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------- environment for spawned services ---------- */

// GUI launches (Finder, systemd user units) hand daemons a bare PATH with no
// nvm/homebrew/uv. We want the user's interactive-shell PATH — that's where
// version managers initialize (.zshrc/.bashrc; plain -lc never reads them,
// and a login-only PATH can rank a stale system toolchain first).
//
// Resolution is ASYNC with a disk cache: an interactive shell under launchd
// can hang until its timeout, and the daemon must never block startup on it.
const { execFile } = require("child_process");
const SHELLPATH_CACHE = path.join(HOME_DIR, "shellpath");
let SHELL_PATH = process.env.PATH;
try {
  const cached = fs.readFileSync(SHELLPATH_CACHE, "utf8").trim();
  if (cached.split(":").length > 3) SHELL_PATH = cached;
} catch {}
(function refreshShellPath(i = 0) {
  const shell = process.env.SHELL || "/bin/bash";
  const flags = ["-ilc", "-lc"];
  if (i >= flags.length) return;
  // Interactive shells print noise (macOS "Restored session: …"), so the
  // value is fenced with markers instead of trusting raw stdout.
  execFile(shell, [flags[i], 'printf "__SD__%s__SD__" "$PATH"'], { timeout: 8000 }, (err, out) => {
    const m = (out || "").toString().match(/__SD__([^]*?)__SD__/);
    if (m && m[1].split(":").length > 3) {
      SHELL_PATH = m[1];
      for (const k of Object.keys(WHICH_CACHE)) delete WHICH_CACHE[k]; // re-detect tools with the real PATH
      try { fs.writeFileSync(SHELLPATH_CACHE, SHELL_PATH + "\n", { mode: 0o600 }); } catch {}
    } else refreshShellPath(i + 1);
  });
})();

/* ---------- helpers ---------- */

function git(dir, ...args) {
  try {
    return { ok: true, out: execFileSync("git", ["-C", dir, ...args], { timeout: 8000 }).toString().trim() };
  } catch (e) {
    return { ok: false, out: (e.stderr || e.message || "").toString().trim() };
  }
}

// One lsof/ss call covering ALL listeners, cached ~2.5s — the UI polls every
// service's port every 5s, and per-port subprocess spawns block the event loop.
let portCache = { t: 0, map: new Map() };
function listeningMap() {
  if (Date.now() - portCache.t < 2500) return portCache.map;
  const map = new Map();
  try { // macOS + most Linux
    const out = execFileSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"], { timeout: 4000 }).toString();
    let pid = null;
    for (const line of out.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      else if (line.startsWith("n")) {
        const m = line.match(/:(\d+)$/);
        if (m && pid && !map.has(Number(m[1]))) map.set(Number(m[1]), pid);
      }
    }
  } catch {
    try { // Linux fallback (iproute2)
      const out = execFileSync("ss", ["-ltnpH"], { timeout: 4000 }).toString();
      for (const line of out.split("\n")) {
        const m = line.match(/[:\]](\d+)\s.*pid=(\d+)/);
        if (m && !map.has(Number(m[1]))) map.set(Number(m[1]), Number(m[2]));
      }
    } catch {}
  }
  portCache = { t: Date.now(), map };
  return map;
}
const bustPortCache = () => { portCache.t = 0; };
function portPid(port) {
  if (!port) return null;
  return listeningMap().get(Number(port)) ?? null;
}

const MAX_BUF = 2000;
const nul = () => Object.create(null); // user input indexes these: no prototype keys
const procs = nul();   // name -> { child, startedAt, branch, stopping }
const buffers = nul(); // name -> [lines]
const clients = nul(); // name -> Set<res> (SSE)

/* Pids persist to disk so a restarted daemon re-adopts services it started
   (children are detached on purpose: killing the daemon must not kill your
   dev servers). Adopted services can't stream logs, but show as running and
   can be killed — same as any external process, minus the guesswork. */
const PROCS_PATH = path.join(HOME_DIR, "procs.json");
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const instances = nul(); // "svc@branch" -> { svc, branch, dir, port, startedAt, child? OR pid (adopted) }
const extKills = nul();  // name -> { pid, at } — recently killed externals, to spot supervisor resurrection
const instLive = (i) => (i.child ? i.child.exitCode === null : alive(i.pid));
const instPid = (i) => (i.child ? i.child.pid : i.pid);
const adopted = nul();
try {
  const saved = JSON.parse(fs.readFileSync(PROCS_PATH, "utf8"));
  const svc = saved.services || saved; // pre-0.3 format was a flat map of services
  for (const [n, v] of Object.entries(svc || {}))
    if (v && Number.isInteger(v.pid) && alive(v.pid)) adopted[n] = v;
  for (const [k, v] of Object.entries(saved.instances || {}))
    if (v && Number.isInteger(v.pid) && alive(v.pid)) instances[k] = v; // adopted instance: pid, no child
} catch {}
function saveProcs() {
  const out = { services: {}, instances: {} };
  for (const [n, p] of Object.entries(procs))
    if (p.child.exitCode === null && p.child.pid) out.services[n] = { pid: p.child.pid, startedAt: p.startedAt, branch: p.branch };
  for (const [n, v] of Object.entries(adopted)) if (!(n in out.services) && alive(v.pid)) out.services[n] = v;
  for (const [k, i] of Object.entries(instances))
    if (instLive(i)) out.instances[k] = { pid: instPid(i), svc: i.svc, branch: i.branch, dir: i.dir, port: i.port, startedAt: i.startedAt, externalWorktree: !!i.externalWorktree };
  try { fs.writeFileSync(PROCS_PATH, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 }); } catch {}
}
function adoptedPid(name) {
  const a = adopted[name];
  if (!a) return null;
  if (alive(a.pid)) return a.pid;
  delete adopted[name];
  return null;
}

// Disk logs: one append stream per service, rotated at 5MB (one .1 backup) so
// a chatty service can't eat the disk.
const logStreams = nul();
const logWrites = nul();
const MAX_LOG_BYTES = 5 * 1024 * 1024;
function logStream(name) {
  if (!logStreams[name]) {
    logStreams[name] = fs.createWriteStream(path.join(LOG_DIR, `${name}.log`), { flags: "a", mode: 0o600 });
    logStreams[name].on("error", () => { delete logStreams[name]; }); // disk full etc. must not kill the daemon
  }
  return logStreams[name];
}
function maybeRotate(name) {
  try {
    const f = path.join(LOG_DIR, `${name}.log`);
    if (fs.statSync(f).size > MAX_LOG_BYTES) {
      logStreams[name]?.end();
      delete logStreams[name];
      fs.renameSync(f, `${f}.1`);
    }
  } catch {}
}
function pushLog(name, chunk) {
  const lines = chunk.toString().split("\n").filter((l) => l.length);
  const buf = (buffers[name] = buffers[name] || []);
  for (const l of lines) {
    buf.push(l);
    if (buf.length > MAX_BUF) buf.shift();
  }
  logStream(name).write(chunk);
  if ((logWrites[name] = (logWrites[name] || 0) + 1) % 500 === 0) maybeRotate(name);
  notifyLogWaiters(name, lines); // readiness checks watch the live stream
  for (const res of clients[name] || []) {
    try { for (const l of lines) res.write(`data: ${JSON.stringify(l)}\n\n`); } catch {}
  }
}

// Git state per directory, cached ~10s: three synchronous git spawns per
// service per 5s poll would stall the event loop (and every SSE stream).
const gitCache = new Map(); // dir -> { t, isGit, branch, branches, dirty }
function gitInfo(dir) {
  const c = gitCache.get(dir);
  if (c && Date.now() - c.t < 10000) return c;
  const isGit = fs.existsSync(path.join(dir, ".git"));
  const info = { t: Date.now(), isGit, branch: null, branches: [], dirty: false };
  if (isGit) {
    info.branch = gitBranchFast(dir) || "(detached)";
    info.branches = (git(dir, "for-each-ref", "refs/heads", "--format=%(refname:short)").out || "").split("\n").filter(Boolean);
    info.dirty = (git(dir, "status", "--porcelain").out || "") !== "";
  }
  gitCache.set(dir, info);
  return info;
}

function serviceState(s) {
  const dir = svcDir(s);
  const p = procs[s.name];
  const managedUp = p && p.child.exitCode === null;
  let pid = managedUp ? p.child.pid : (portPid(s.port) ?? adoptedPid(s.name));
  // One of this service's own worktree instances sitting on its port is not
  // the service running — saying "up" there would be a lie about which branch.
  const instHoldsPort = !managedUp && !adoptedPid(s.name) && s.port &&
    Object.values(instances).some((i) => instLive(i) && i.svc === s.name && Number(i.port) === Number(s.port));
  if (instHoldsPort) pid = null;
  const rk = extKills[s.name];
  const resurrected = !!(rk && !managedUp && pid && pid !== rk.pid && Date.now() - rk.at < 120000);
  const g = gitInfo(dir);
  return {
    ...s,
    running: managedUp || pid !== null,
    managed: !!managedUp,
    pid,
    startedBranch: p ? p.branch : null,
    startedAt: p ? p.startedAt : null,
    lastExit: lastExit[s.name] || null,
    resurrected,
    instHoldsPort: !!instHoldsPort,
    restartPending: !!(restarts[s.name] && restarts[s.name].timer && !managedUp && restarts[s.name].n > 0 && restarts[s.name].n <= 5),
    branch: g.branch, branches: g.branches, dirty: g.dirty, isGit: g.isGit,
  };
}

/* ---------- project discovery ---------- */

let projCache = { t: 0, data: null };

// Fast branch read (no git spawn): parse .git/HEAD directly. Handles the
// worktree/submodule case where .git is a "gitdir: <path>" file.
function gitBranchFast(dir) {
  try {
    let g = path.join(dir, ".git");
    if (fs.statSync(g).isFile()) {
      const m = fs.readFileSync(g, "utf8").match(/^gitdir:\s*(.+?)\s*$/m);
      if (!m) return null;
      g = path.resolve(dir, m[1]);
    }
    const head = fs.readFileSync(path.join(g, "HEAD"), "utf8").trim();
    return head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : "(detached)";
  } catch { return null; }
}

/**
 * Infer how to run a project. Priority: files that encode the author's intent
 * (bin/dev, Makefile, justfile, Taskfile) → language manifests with their own
 * toolchain detection → docker-compose as the last resort.
 */
function inferCommand(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  const read = (f) => { try { return fs.readFileSync(path.join(dir, f), "utf8"); } catch { return ""; } };
  // Tolerant JSON: one malformed manifest must not abort the remaining
  // detectors. Parse as-is FIRST — comment-stripping breaks every URL
  // ("https://…") in valid JSON — and only fall back to stripping for
  // jsonc-style files.
  const jread = (f) => {
    const raw = read(f);
    try { return JSON.parse(raw) || {}; } catch {}
    try { return JSON.parse(raw.replace(/^\s*\/\/[^\n]*/gm, "")) || {}; } catch { return {}; }
  };
  const DEV_TARGETS = ["dev", "start", "run", "serve", "up"];
  try {
    /* -- author intent ------------------------------------------------ */
    if (has("bin/dev")) return "bin/dev";                       // Rails 7+ and friends
    if (has("Makefile")) {
      const mk = read("Makefile");
      for (const t of DEV_TARGETS) if (new RegExp(`^${t}:`, "m").test(mk)) return `make ${t}`;
    }
    for (const jf of ["justfile", "Justfile", ".justfile"]) if (has(jf)) {
      const j = read(jf);
      for (const t of DEV_TARGETS) if (new RegExp(`^${t}[\\s:]`, "m").test(j)) return `just ${t}`;
    }
    for (const tf of ["Taskfile.yml", "Taskfile.yaml", "taskfile.yml"]) if (has(tf)) {
      const y = read(tf);
      for (const t of DEV_TARGETS) if (new RegExp(`^  ${t}:`, "m").test(y)) return `task ${t}`;
    }

    /* -- JavaScript / TypeScript -------------------------------------- */
    if (has("package.json")) {
      const pkg = jread("package.json");
      const runner =
        has("bun.lockb") || has("bun.lock") ? "bun" :
        has("pnpm-lock.yaml") || has("pnpm-workspace.yaml") ? "pnpm" :
        has("yarn.lock") ? "yarn" : "npm";
      for (const s of ["dev", "start", "serve", "develop"])
        if (pkg.scripts && pkg.scripts[s]) return `${runner} run ${s}`;
    }
    for (const dj of ["deno.json", "deno.jsonc"]) if (has(dj)) {
      const tasks = jread(dj).tasks || {};
      for (const t of DEV_TARGETS) if (tasks[t]) return `deno task ${t}`;
    }

    /* -- Python --------------------------------------------------------
       Toolchain from lockfiles, entry point from convention. */
    if (has("pyproject.toml") || has("requirements.txt") || has("Pipfile") || has("setup.py")) {
      const toml = read("pyproject.toml");
      const runner =
        has("uv.lock") ? "uv run" :
        /\[tool\.poetry\]/.test(toml) ? "poetry run" :
        has("Pipfile") ? "pipenv run" :
        has("pdm.lock") ? "pdm run" : null;
      // A declared console script is the author's entry point — use it.
      const scriptSec = toml.match(/\[(?:project|tool\.poetry)\.scripts\]\s*\n\s*([A-Za-z0-9_-]+)\s*=/);
      if (runner && scriptSec) return `${runner} ${scriptSec[1]}`;
      const py = runner ? `${runner} python` : "python3";
      if (has("manage.py")) return `${py} manage.py runserver`;   // Django
      for (const m of ["main.py", "app.py", "server.py", "run.py", "api.py",
                       "src/main.py", "app/main.py"])
        if (has(m)) return `${py} ${m}`;
    }

    /* -- systems & compiled ------------------------------------------- */
    if (has("Cargo.toml")) return "cargo run";
    if (has("go.mod")) return "go run .";
    if (has("build.zig")) return "zig build run";
    if (has("Package.swift")) return "swift run";
    if ([".csproj", ".fsproj"].some((ext) => { try { return fs.readdirSync(dir).some((f) => f.endsWith(ext)); } catch { return false; } }))
      return "dotnet run";

    /* -- JVM ------------------------------------------------------------ */
    if (has("gradlew") || has("build.gradle") || has("build.gradle.kts")) {
      const g = read("build.gradle") + read("build.gradle.kts");
      const w = has("gradlew") ? "./gradlew" : "gradle";
      return /spring-boot/.test(g) ? `${w} bootRun` : `${w} run`;
    }
    if (has("pom.xml")) {
      const w = has("mvnw") ? "./mvnw" : "mvn";
      if (/spring-boot/.test(read("pom.xml"))) return `${w} spring-boot:run`;
    }

    /* -- Ruby / PHP / Elixir / Dart ------------------------------------ */
    if (has("Gemfile")) {
      if (has("config/application.rb")) return "bin/rails server";  // Rails
      if (has("config.ru")) return "bundle exec rackup";
    }
    if (has("artisan")) return "php artisan serve";                 // Laravel
    if (has("composer.json")) {
      const scripts = jread("composer.json").scripts || {};
      for (const t of ["dev", "start", "serve"]) if (scripts[t]) return `composer run ${t}`;
      if (has("index.php")) return "php -S localhost:8080";
    }
    if (has("mix.exs")) return /phoenix/.test(read("mix.exs")) ? "mix phx.server" : "mix run --no-halt";
    if (has("pubspec.yaml")) return /^\s{2}flutter\s*:/m.test(read("pubspec.yaml")) ? "flutter run" : "dart run";
    if (has("stack.yaml")) return "stack run";

    /* -- containers last: only when nothing language-level matched ----- */
    if (has("docker-compose.yml") || has("docker-compose.yaml") || has("compose.yml") || has("compose.yaml"))
      return "docker compose up";
  } catch {}
  return null;
}

/**
 * Multi-process repos: a Procfile, docker-compose services, or pnpm workspace
 * packages mean one repo is really several services. Returns [{name, command,
 * dir}] when there's more than one, else null.
 */
function detectProcs(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  const read = (f) => { try { return fs.readFileSync(path.join(dir, f), "utf8"); } catch { return ""; } };
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { return null; } };
  const app = [];   // the repo's own processes
  const infra = []; // databases and brokers it declares
  try {
    // A Procfile is an explicit, authoritative process list — it wins outright.
    for (const pf of ["Procfile.dev", "Procfile"]) if (has(pf)) {
      const procs = [];
      for (const line of read(pf).split("\n")) {
        const m = line.match(/^([A-Za-z0-9_-]+):\s*(.+?)\s*$/);
        if (m && !m[2].startsWith("#")) procs.push({ name: m[1], command: m[2], dir });
      }
      if (procs.length > 1) return procs;
    }

    const pkg = has("package.json") ? readJson("package.json") : null;
    const runner =
      has("bun.lockb") || has("bun.lock") ? "bun" :
      has("pnpm-lock.yaml") || has("pnpm-workspace.yaml") ? "pnpm" :
      has("yarn.lock") ? "yarn" : "npm";

    // Workspace packages (pnpm-workspace.yaml, or the workspaces field npm and
    // yarn use): each package that can run on its own is a process.
    const globs = has("pnpm-workspace.yaml")
      ? [...read("pnpm-workspace.yaml").matchAll(/^\s*-\s*['"]?([^'"\s#]+)/gm)].map((m) => m[1])
      : (pkg && Array.isArray(pkg.workspaces) ? pkg.workspaces
         : pkg && pkg.workspaces && Array.isArray(pkg.workspaces.packages) ? pkg.workspaces.packages : []);
    for (const g of globs) {
      const bases = g.endsWith("/*") ? (() => {
        try {
          return fs.readdirSync(path.join(dir, g.slice(0, -2)), { withFileTypes: true })
            .filter((e) => e.isDirectory()).map((e) => path.join(g.slice(0, -2), e.name));
        } catch { return []; }
      })() : [g];
      for (const rel of bases) {
        const wp = readJson(path.join(rel, "package.json"));
        const script = wp && wp.scripts && (wp.scripts.dev ? "dev" : wp.scripts.start ? "start" : null);
        if (!script || !wp.name) continue;
        const cmd =
          runner === "pnpm" ? `pnpm -F ${wp.name} ${script}` :
          runner === "yarn" ? `yarn workspace ${wp.name} ${script}` :
          runner === "bun" ? `bun run --filter ${wp.name} ${script}` :
          `npm run ${script} -w ${wp.name}`;
        app.push({ name: path.basename(rel), command: cmd, dir });
      }
    }

    // Monorepos without a workspaces field are common: several apps are driven
    // by a family of root scripts (dev, dev:admin, dev:worker) that each run one
    // of them. Treat the family as the process list.
    if (!app.length && pkg && pkg.scripts) {
      const fam = Object.keys(pkg.scripts).filter((k) => /^(dev|start)(:[A-Za-z0-9_-]+)?$/.test(k));
      const base = fam.filter((k) => !k.includes(":"));
      if (fam.length > 1 && fam.length - base.length >= 1) {
        for (const k of fam) {
          // "dev" alongside "dev:admin" is usually the primary app, not an
          // umbrella that starts everything; skip it if it fans out to the rest.
          const v = String(pkg.scripts[k]);
          if (!k.includes(":") && /concurrently|npm-run-all|turbo run|&\s*$|&&.*dev:/.test(v)) continue;
          app.push({ name: k.includes(":") ? k.split(":")[1] : "app", command: `${runner} run ${k}`, dir });
        }
      }
    }

    for (const cf of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) if (has(cf)) {
      let inServices = false;
      for (const line of read(cf).split("\n")) {
        if (/^services:\s*$/.test(line)) { inServices = true; continue; }
        if (inServices && /^[A-Za-z#]/.test(line)) inServices = false; // dedent = section over
        const m = inServices && line.match(/^ {2}([A-Za-z0-9._-]+):\s*$/);
        if (m) infra.push({ name: m[1], command: `docker compose up ${m[1]}`, dir });
      }
      if (infra.length) break;
    }
  } catch {}
  // Compose usually covers the databases while the app runs on the host, so
  // both halves belong on the board. Compose-only names lose to app names.
  const seen = new Set(app.map((p) => p.name));
  const all = [...app, ...infra.filter((p) => !seen.has(p.name))];
  return all.length > 1 ? all : null;
}

function scanProjects() {
  const out = [];
  const excluded = new Set((cfg.excludes || []).map(expand));
  const pc = cfg.projectCategories || {};
  const entry = (dir, name, root, catKeys, isGit, cmd) => ({
    name,
    dir,
    root,
    isGit,
    branch: gitBranchFast(dir),
    suggestedCommand: cmd,
    procs: detectProcs(dir),
    configured: cfg.services.some((s) => svcDir(s) === dir || svcDir(s).startsWith(dir + path.sep)),
    category: catKeys.map((k) => pc[k]).find(Boolean) || "Uncategorized",
  });
  const lsDirs = (p) => {
    try { return fs.readdirSync(p, { withFileTypes: true }).filter((x) => x.isDirectory() && !x.name.startsWith(".")); }
    catch { return []; }
  };
  for (const root of cfg.projectRoots.map(expand)) {
    for (const e of lsDirs(root)) {
      const dir = path.join(root, e.name);
      if (excluded.has(dir)) continue;
      // A real project: it's a git repo or we know how to run it.
      const isGit = fs.existsSync(path.join(dir, ".git"));
      const cmd = inferCommand(dir);
      if (isGit || cmd) {
        out.push(entry(dir, e.name, root, [e.name], isGit, cmd));
        continue;
      }
      // Container folder: not a repo itself, but may hold repos one level
      // down (e.g. work/team-api). Surface those instead, inheriting the
      // container's category unless mapped individually.
      const subs = lsDirs(dir)
        .map((s) => {
          const sdir = path.join(dir, s.name);
          if (excluded.has(sdir)) return null;
          const sGit = fs.existsSync(path.join(sdir, ".git"));
          const sCmd = inferCommand(sdir);
          return sGit || sCmd ? { sdir, sGit, sCmd } : null;
        })
        .filter(Boolean);
      if (subs.length) {
        for (const { sdir, sGit, sCmd } of subs) {
          const sub = path.basename(sdir);
          out.push(entry(sdir, `${e.name}/${sub}`, root, [`${e.name}/${sub}`, sub, e.name], sGit, sCmd));
        }
      } else {
        out.push(entry(dir, e.name, root, [e.name], false, null)); // plain folder, listed as-is
      }
    }
  }
  out.sort((a, b) => (b.suggestedCommand ? 1 : 0) - (a.suggestedCommand ? 1 : 0) || byName(a.name, b.name));
  return out;
}

/* ---------- dev-tool (infra) detection ----------
   DBngin-style: databases and brokers run as ordinary foreground services —
   managed child, streamed logs, clean kill — no daemons, no Docker required. */

const DATA_HOME = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "stackdeck");
const firstDir = (cands) => cands.map(expand).find((c) => c && fs.existsSync(c)) || null;
const own = (sub) => `mkdir -p '${DATA_HOME}/${sub}' && `; // self-initializing data dir (quoted: spaces in $HOME)

const INFRA = () => [
  { name: "postgres", title: "PostgreSQL", bin: "postgres", port: 5432,
    command: (() => {
      const d = firstDir([process.env.PGDATA,
        "/opt/homebrew/var/postgresql@18", "/opt/homebrew/var/postgresql@17", "/opt/homebrew/var/postgresql@16",
        "/opt/homebrew/var/postgresql@15", "/opt/homebrew/var/postgresql@14", "/opt/homebrew/var/postgres",
        "/usr/local/var/postgresql@17", "/usr/local/var/postgresql@16", "/usr/local/var/postgres",
        "/var/lib/postgresql/data", "/var/lib/postgres/data"]);
      return d ? `postgres -D '${d}'` : "postgres -D <your-data-dir>  # run initdb first";
    })() },
  { name: "mysql", title: "MySQL", bin: "mysqld", port: 3306, command: "mysqld" },
  { name: "mariadb", title: "MariaDB", bin: "mariadbd", port: 3306, command: "mariadbd" },
  { name: "mongodb", title: "MongoDB", bin: "mongod", port: 27017,
    command: (() => {
      const d = firstDir(["/opt/homebrew/var/mongodb", "/usr/local/var/mongodb", "/var/lib/mongodb"]);
      return d ? `mongod --dbpath '${d}'` : `${own("mongodb")}mongod --dbpath '${DATA_HOME}/mongodb'`;
    })() },
  { name: "redis", title: "Redis", bin: "redis-server", port: 6379, command: "redis-server" },
  { name: "valkey", title: "Valkey", bin: "valkey-server", port: 6379, command: "valkey-server" },
  { name: "memcached", title: "Memcached", bin: "memcached", port: 11211, command: "memcached -v" },
  { name: "elasticsearch", title: "Elasticsearch", bin: "elasticsearch", port: 9200, command: "elasticsearch" },
  { name: "opensearch", title: "OpenSearch", bin: "opensearch", port: 9200, command: "opensearch" },
  { name: "rabbitmq", title: "RabbitMQ", bin: "rabbitmq-server", port: 5672, command: "rabbitmq-server" },
  { name: "nats", title: "NATS", bin: "nats-server", port: 4222, command: "nats-server" },
  { name: "minio", title: "MinIO", bin: "minio", port: 9000, command: `${own("minio")}minio server '${DATA_HOME}/minio'` },
  { name: "temporal", title: "Temporal (dev)", bin: "temporal", port: 7233, command: "temporal server start-dev" },
  { name: "clickhouse", title: "ClickHouse", bin: "clickhouse", port: 8123, command: "clickhouse server" },
  { name: "mailpit", title: "Mailpit", bin: "mailpit", port: 8025, command: "mailpit" },
];

const WHICH_CACHE = nul();
function which(bin) {
  if (bin in WHICH_CACHE) return WHICH_CACHE[bin];
  try {
    WHICH_CACHE[bin] = execFileSync("bash", ["-c", `command -v ${bin}`],
      { env: { ...process.env, PATH: SHELL_PATH }, timeout: 3000 }).toString().trim() || null;
  } catch { WHICH_CACHE[bin] = null; }
  return WHICH_CACHE[bin];
}

/* ---------- actions ---------- */

// Minimal .env parser: KEY=value lines, optional `export `, quotes stripped,
// #-comments ignored. No interpolation — this is a loader, not a shell.
function parseEnvFile(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || m[2].startsWith("#")) continue;
      let v = m[2];
      const q = v.match(/^(['"])(.*?)\1/); // quoted value; anything after the close quote is ignored
      out[m[1]] = q ? q[2] : v.replace(/\s+#.*$/, "");
    }
  } catch {}
  return out;
}

async function startService(s, branch, force) {
  const dir = svcDir(s);
  if (procs[s.name] && procs[s.name].child.exitCode === null)
    return { code: 409, error: `${s.name} is already running (managed)`, already: true };
  if (adoptedPid(s.name))
    return { code: 409, error: `${s.name} is already running (from a previous daemon) — Kill it first`, already: true };
  bustPortCache(); // the busy check must not act on stale data
  let busy = portPid(s.port);
  if (busy && force) { // user confirmed: evict the squatter, then take the port
    try { process.kill(busy, "SIGTERM"); } catch {}
    for (let i = 0; i < 15 && busy; i++) {
      await new Promise((ok) => setTimeout(ok, 200));
      bustPortCache();
      busy = portPid(s.port);
    }
    if (busy) return { code: 409, error: `pid ${busy} did not release port ${s.port}` };
    pushLog(s.name, `[stackdeck] killed external process squatting port ${s.port}\n`);
  }
  if (busy) return { code: 409, error: `port ${s.port} is busy (pid ${busy}, external) — kill it first`, busyPid: busy };
  if (!fs.existsSync(dir)) return { code: 400, error: `directory not found: ${dir}` };

  if (branch) {
    // Only known local branches: a value like "-f" must never reach git argv.
    const g = gitInfo(dir);
    if (!g.isGit) return { code: 400, error: "not a git repository" };
    if (!g.branches.includes(branch)) return { code: 400, error: `unknown branch '${branch}'` };
    if (branch !== g.branch) {
      if ((git(dir, "status", "--porcelain").out || "") !== "")
        return { code: 409, error: `cannot switch to '${branch}': working tree has uncommitted changes` };
      const co = git(dir, "checkout", branch);
      if (!co.ok) return { code: 500, error: `git checkout ${branch} failed: ${co.out}` };
      gitCache.delete(dir);
      pushLog(s.name, `[stackdeck] checked out branch '${branch}'\n`);
    }
  }

  // Env precedence: daemon env < <dir>/.env (auto-loaded; set envFile:false
  // to skip, or a path to use a different file) < the service's own env.
  const envFile = s.envFile === false ? null : path.join(dir, s.envFile || ".env");
  const fileEnv = envFile && fs.existsSync(envFile) ? parseEnvFile(envFile) : {};
  const n = Object.keys(fileEnv).length;
  if (n) pushLog(s.name, `[stackdeck] loaded ${path.basename(envFile)} (${n} vars)\n`);

  // Non-login, non-interactive shell: inherits the daemon's resolved PATH and
  // avoids surprises from profile files reordering toolchains.
  const child = spawn("bash", ["-c", s.command], {
    cwd: dir,
    env: { ...process.env, PATH: SHELL_PATH, ...fileEnv, ...(s.env || {}) },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => pushLog(s.name, d));
  child.stderr.on("data", (d) => pushLog(s.name, d));
  // A spawn 'error' (cwd vanished, bash missing) is an event, not an exception —
  // unhandled it would take down the whole daemon.
  child.on("error", (e) => {
    pushLog(s.name, `[stackdeck] failed to start: ${e.message}\n`);
    delete procs[s.name];
    saveProcs();
  });
  const rec = { child, startedAt: Date.now(), branch: branch || null, stopping: false };
  child.on("exit", (code, sig) => {
    pushLog(s.name, `[stackdeck] exited (code=${code} signal=${sig})\n`);
    lastExit[s.name] = { code, sig, at: Date.now(), expected: rec.stopping };
    delete procs[s.name];
    saveProcs();
    maybeAutoRestart(s, rec, code);
  });
  procs[s.name] = rec;
  delete lastExit[s.name];
  const rt = restarts[s.name];
  if (rt) { clearTimeout(rt.timer); if (!rt.auto) restarts[s.name] = { n: 0 }; }
  saveProcs();
  pushLog(s.name, `[stackdeck] started: ${s.command} (pid ${child.pid})\n`);
  return { code: 200, ok: true, pid: child.pid };
}

/* restart: "on-failure" — exponential backoff, attempts reset after a minute
   of clean uptime; manual stops never trigger it. */
const lastExit = nul();   // name -> { code, sig, at, expected }
const restarts = nul();   // name -> { n, timer, auto }
function maybeAutoRestart(s, rec, code) {
  if (s.restart !== "on-failure" || rec.stopping || code === 0) return;
  const uptime = Date.now() - rec.startedAt;
  const r = (restarts[s.name] = restarts[s.name] || { n: 0 });
  if (uptime > 60000) r.n = 0;
  if (r.n >= 5) {
    pushLog(s.name, `[stackdeck] crashed ${r.n} times — giving up (edit the service to reset)\n`);
    return;
  }
  const delay = Math.min(30000, 1000 * 2 ** r.n);
  r.n += 1;
  pushLog(s.name, `[stackdeck] crashed (code=${code}) — restarting in ${delay / 1000}s (attempt ${r.n}/5)\n`);
  r.timer = setTimeout(async () => {
    r.auto = true;
    const cur = findSvc(s.name);
    if (cur && !(procs[s.name] && procs[s.name].child.exitCode === null)) await startService(cur, rec.branch);
    r.auto = false;
  }, delay);
  r.timer.unref();
}

/* Readiness: a service is "ready" when its readyWhen condition holds —
   { "log": "<regex>" } (matched against live output), { "http": "<url>" }
   (2xx/3xx), or, by default, its port accepting connections. */
const readyWaiters = nul(); // name -> [{ regex, resolve }]
function notifyLogWaiters(name, lines) {
  const ws = readyWaiters[name];
  if (!ws || !ws.length) return;
  for (const w of [...ws]) {
    if (lines.some((l) => w.regex.test(l))) {
      w.resolve(true);
      ws.splice(ws.indexOf(w), 1);
    }
  }
}
async function waitReady(s, timeoutMs = 60000) {
  const until = Date.now() + timeoutMs;
  const rw = s.readyWhen || {};
  if (rw.log) {
    let regex;
    try { regex = new RegExp(rw.log); } catch { return { ok: false, why: `bad readyWhen.log regex` }; }
    if ((buffers[s.name] || []).slice(-200).some((l) => regex.test(l))) return { ok: true };
    return await new Promise((resolve) => {
      const w = { regex, resolve: () => resolve({ ok: true }) };
      (readyWaiters[s.name] = readyWaiters[s.name] || []).push(w);
      setTimeout(() => {
        const ws = readyWaiters[s.name] || [];
        const i = ws.indexOf(w);
        if (i >= 0) { ws.splice(i, 1); resolve({ ok: false, why: "log pattern not seen in time" }); }
      }, timeoutMs).unref();
    });
  }
  if (rw.http) {
    while (Date.now() < until) {
      const ok = await new Promise((resolve) => {
        try {
          const mod = rw.http.startsWith("https:") ? require("https") : http;
          const req = mod.get(rw.http, { timeout: 2000 }, (r) => { r.resume(); resolve(r.statusCode < 400); });
          req.on("error", () => resolve(false));
          req.on("timeout", () => { req.destroy(); resolve(false); });
        } catch { resolve(false); }
      });
      if (ok) return { ok: true };
      if (!(procs[s.name] && procs[s.name].child.exitCode === null)) return { ok: false, why: "process exited" };
      await new Promise((r) => setTimeout(r, 500));
    }
    return { ok: false, why: "http check never passed" };
  }
  if (s.port) {
    while (Date.now() < until) {
      bustPortCache();
      if (portPid(s.port)) return { ok: true };
      if (!(procs[s.name] && procs[s.name].child.exitCode === null)) return { ok: false, why: "process exited" };
      await new Promise((r) => setTimeout(r, 500));
    }
    return { ok: false, why: `port ${s.port} never opened` };
  }
  await new Promise((r) => setTimeout(r, 1000)); // no signal at all: brief grace
  return { ok: true };
}

/* Dependency-ordered startup: topo-sort dependsOn, start each level, wait for
   readiness before starting dependents. Cycles fail loudly. */
async function startWithDeps(names, force) {
  const results = {};
  const visiting = new Set(), done = new Set();
  const startOne = async (name, chain) => {
    if (done.has(name)) return true;
    if (visiting.has(name)) { results[name] = { error: `dependency cycle: ${[...chain, name].join(" → ")}` }; return false; }
    visiting.add(name);
    const s = findSvc(name);
    if (!s) { results[name] = { error: "unknown service" }; visiting.delete(name); return false; }
    for (const dep of s.dependsOn || []) {
      if (!(await startOne(dep, [...chain, name]))) {
        results[name] = results[name] || { error: `dependency '${dep}' failed` };
        visiting.delete(name);
        return false;
      }
    }
    const alreadyUp = (procs[name] && procs[name].child.exitCode === null) || portPid(s.port) || adoptedPid(name);
    if (!alreadyUp) {
      const r = await startService(s, undefined, force);
      if (r.error && !r.already) { results[name] = { error: r.error }; visiting.delete(name); return false; }
      const ready = await waitReady(s);
      if (!ready.ok) { results[name] = { error: `started but not ready: ${ready.why}` }; visiting.delete(name); return false; }
      results[name] = { ok: true, started: true };
    } else {
      results[name] = { ok: true, alreadyRunning: true };
    }
    visiting.delete(name);
    done.add(name);
    return true;
  };
  for (const n of names) await startOne(n, []);
  return results;
}

async function stopService(s) {
  const rt = restarts[s.name];
  if (rt) { clearTimeout(rt.timer); rt.n = 0; } // a manual stop cancels pending auto-restarts
  const p = procs[s.name];
  if (p && p.child.exitCode === null) {
    p.stopping = true; // suppresses crash notification + on-failure restart
    const child = p.child, pid = child.pid;
    try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch {} }
    // Escalate only if OUR child is still alive — never fire a blind kill at a
    // pid that may have been reused by an unrelated process.
    setTimeout(() => {
      if (child.exitCode === null) { try { process.kill(-pid, "SIGKILL"); } catch {} }
    }, 5000).unref();
    return { code: 200, ok: true, stopped: pid };
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const adPid = adoptedPid(s.name);
  if (adPid) { // started by a previous daemon instance: we know its group
    try { process.kill(-adPid, "SIGTERM"); } catch { try { process.kill(adPid, "SIGTERM"); } catch {} }
    delete adopted[s.name];
    saveProcs();
    bustPortCache();
    pushLog(s.name, `[stackdeck] stopped pid ${adPid} (adopted from a previous daemon)\n`);
    return { code: 200, ok: true, stopped: adPid, adopted: true };
  }
  bustPortCache();
  const ext = portPid(s.port);
  if (ext) {
    // External processes may be supervised (brew services/launchd/systemd):
    // verify the kill sticks, escalate politely, and report resurrection
    // honestly instead of letting the row quietly turn green again.
    try { process.kill(ext, "SIGTERM"); } catch (e) { return { code: 500, error: `kill ${ext} failed: ${e.message}` }; }
    let now = ext;
    for (let i = 0; i < 8 && now === ext; i++) { await sleep(250); bustPortCache(); now = portPid(s.port); }
    if (now === ext) { // SIGTERM ignored — postgres, for one, "smart-waits"; SIGINT is its fast shutdown
      try { process.kill(ext, "SIGINT"); } catch {}
      for (let i = 0; i < 8 && now === ext; i++) { await sleep(250); bustPortCache(); now = portPid(s.port); }
    }
    if (now === ext)
      return { code: 409, error: `pid ${ext} ignored SIGTERM and SIGINT — it looks like a system-managed daemon; stop it with its own manager (e.g. brew services stop …)` };
    pushLog(s.name, `[stackdeck] killed external pid ${ext} on port ${s.port}\n`);
    extKills[s.name] = { pid: ext, at: Date.now() };
    if (now) { // something already took the port back: a supervisor restarted it
      pushLog(s.name, `[stackdeck] a supervisor restarted it as pid ${now}\n`);
      return { code: 200, ok: true, stopped: ext, resurrected: now,
               note: `${s.name}: killed pid ${ext}, but a supervisor (launchd/brew?) restarted it as pid ${now} — stop it with its own manager instead` };
    }
    return { code: 200, ok: true, stopped: ext, external: true };
  }
  return { code: 409, error: `${s.name} is not running` };
}

async function restartService(s) {
  const wasBranch = procs[s.name] ? procs[s.name].branch : null;
  const r = await stopService(s);
  if (r.error && r.code !== 409) return r;
  for (let i = 0; i < 30; i++) { // wait up to ~6s for the port/process to clear
    const p = procs[s.name];
    bustPortCache();
    if ((!p || p.child.exitCode !== null) && !portPid(s.port) && !adoptedPid(s.name)) break;
    await new Promise((ok) => setTimeout(ok, 200));
  }
  return startService(s, wasBranch);
}

/* ---------- worktree instances ----------
   Run ANOTHER branch of a service in parallel: a git worktree gives it its
   own checkout, a free port is injected as $PORT. Instances are ephemeral
   (they do not survive daemon restarts) and live under the data dir. */
function freePortFrom(base, allow) {
  bustPortCache();
  const taken = new Set(listeningMap().keys());
  for (const i of Object.values(instances)) if (instLive(i) && i.port) taken.add(i.port); // not yet bound ≠ free
  for (const s of cfg.services) if (s.port) taken.add(Number(s.port));
  if (allow) taken.delete(Number(allow)); // the stopped service's own port is fair game
  for (let p = base; p < base + 200; p++) if (!taken.has(p)) return p;
  return null;
}
// Where (if anywhere) a branch is already checked out. Coding agents make
// worktrees too (Claude Code puts them under .claude/worktrees), and git
// refuses to check the same branch out twice — so we adopt theirs instead.
function worktreeOf(mainDir, branch) {
  const out = git(mainDir, "worktree", "list", "--porcelain").out || "";
  let cur = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) cur = line.slice("worktree ".length).trim();
    else if (line.startsWith("branch ") && cur) {
      if (line.slice("branch ".length).trim().replace(/^refs\/heads\//, "") === branch) return cur;
    } else if (!line.trim()) cur = null;
  }
  return null;
}
/* Plenty of dev servers ignore $PORT (Vite reads vite.config, Next reads -p),
   so the injected port is a request. Watch what the instance's process group
   actually binds and correct the record — the board must not claim a port
   nothing is listening on, and the proxy routes by this value. */
function pgidMap() {
  const m = new Map();
  try {
    for (const line of execFileSync("ps", ["-Ao", "pid=,pgid="], { timeout: 4000 }).toString().split("\n")) {
      const t = line.trim().split(/\s+/);
      if (t.length === 2) m.set(Number(t[0]), Number(t[1]));
    }
  } catch {}
  return m;
}
async function confirmInstancePort(key, pgid, asked) {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const inst = instances[key];
    if (!inst || !instLive(inst)) return;
    bustPortCache();
    const groups = pgidMap();
    for (const [port, pid] of listeningMap()) {
      if (groups.get(pid) !== pgid) continue;
      if (inst.port !== port) {
        pushLog(key, `[stackdeck] listening on :${port}${asked ? ` — it ignored PORT=${asked}` : ""}\n`);
        const owner = cfg.services.find((s) => Number(s.port) === port && s.name !== inst.svc);
        const self = cfg.services.find((s) => s.name === inst.svc && Number(s.port) === port);
        if (self || owner)
          pushLog(key, `[stackdeck] that is ${self ? `${inst.svc}'s own port` : `${owner.name}'s port`} — the two cannot both run. This app reads its port from its config, not $PORT (Vite: server.port, Next: -p).\n`);
        inst.port = port;
        saveProcs();
      }
      return;
    }
  }
}
function startWorktree(s, branch) {
  const mainDir = svcDir(s);
  const g = gitInfo(mainDir);
  if (!g.isGit) return { code: 400, error: "not a git repository" };
  if (!g.branches.includes(branch)) return { code: 400, error: `unknown branch '${branch}'` };
  const safeBranch = branch.replace(/[^A-Za-z0-9._-]+/g, "-");
  const key = `${s.name}@${safeBranch}`; // also the log-file name — must stay path-safe
  if (instances[key] && instLive(instances[key]))
    return { code: 409, error: `${key} is already running`, already: true };
  const existing = worktreeOf(mainDir, branch);
  if (existing && path.resolve(existing) === path.resolve(mainDir))
    return { code: 409, error: `'${branch}' is checked out in the main copy — Start it there, or pick another branch` };
  let wtDir = path.join(DATA_HOME, "worktrees", s.name, safeBranch);
  let adopted = false;
  if (existing && path.resolve(existing) !== path.resolve(wtDir) && fs.existsSync(existing)) {
    wtDir = existing; // someone else's worktree for this branch: run it where it lives
    adopted = true;
  } else if (!fs.existsSync(wtDir)) {
    fs.mkdirSync(path.dirname(wtDir), { recursive: true });
    let r = git(mainDir, "worktree", "add", wtDir, branch);
    if (!r.ok) { // a hand-deleted worktree leaves stale metadata that blocks re-adding
      git(mainDir, "worktree", "prune");
      r = git(mainDir, "worktree", "add", wtDir, branch);
    }
    if (!r.ok) {
      try { fs.rmdirSync(path.dirname(wtDir)); } catch {} // only removes if empty
      return { code: 500, error: `git worktree add: ${r.out.split("\n").pop()}` };
    }
  }
  // With the main copy stopped there is nothing to run in parallel with, so the
  // branch takes the service's real port and the rest of your stack reaches it
  // at the address it already expects. Otherwise it gets the next free one up.
  const port = s.port
    ? (svcRunning(s) ? freePortFrom(Number(s.port) + 1) : freePortFrom(Number(s.port), s.port))
    : null;
  // .env is usually gitignored, so a fresh worktree has none — fall back to
  // the main checkout's. (That's the ".env collision" this feature exists for.)
  let envFile = null;
  if (s.envFile !== false) {
    const rel = s.envFile || ".env";
    envFile = fs.existsSync(path.join(wtDir, rel)) ? path.join(wtDir, rel)
            : fs.existsSync(path.join(mainDir, rel)) ? path.join(mainDir, rel) : null;
  }
  const fileEnv = envFile ? parseEnvFile(envFile) : {};
  if (envFile && envFile.startsWith(mainDir)) pushLog(key, `[stackdeck] using .env from the main checkout\n`);
  const child = spawn("bash", ["-c", s.command], {
    cwd: wtDir,
    env: { ...process.env, PATH: SHELL_PATH, ...fileEnv, ...(s.env || {}), ...(port ? { PORT: String(port) } : {}) },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => pushLog(key, d));
  child.stderr.on("data", (d) => pushLog(key, d));
  child.on("error", (e) => { pushLog(key, `[stackdeck] failed to start: ${e.message}\n`); delete instances[key]; saveProcs(); });
  child.on("exit", (code, sig) => { pushLog(key, `[stackdeck] exited (code=${code} signal=${sig})\n`); delete instances[key]; saveProcs(); });
  instances[key] = { svc: s.name, branch, dir: wtDir, port, child, startedAt: Date.now(), externalWorktree: adopted };
  saveProcs();
  confirmInstancePort(key, child.pid, port); // $PORT is a request, not a guarantee
  // shorten $HOME in the banner — log panes end up in screenshots and screen shares
  const wtShort = wtDir.startsWith(os.homedir()) ? "~" + wtDir.slice(os.homedir().length) : wtDir;
  pushLog(key, `[stackdeck] ${adopted ? "existing worktree (made outside Stackdeck)" : "worktree instance"}: branch '${branch}'${port ? `, PORT=${port}` : ""}, ${wtShort}\n`);
  return { code: 200, ok: true, key, port, pid: child.pid, externalWorktree: adopted };
}

/* ---------- http ---------- */

const MAX_BODY = 1024 * 1024;
// Collect Buffers and decode ONCE — per-chunk decoding corrupts multi-byte
// characters (emoji, non-Latin scripts) that land on a chunk boundary.
const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  let len = 0;
  req.on("data", (c) => {
    chunks.push(c);
    len += c.length;
    if (len > MAX_BODY) { resolve({}); req.destroy(); }
  });
  req.on("end", () => {
    try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { resolve({}); }
  });
  req.on("error", () => resolve({}));
});
const validEnv = (v) => v && typeof v === "object" && !Array.isArray(v) &&
  Object.entries(v).every(([k, val]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof val === "string");
const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

const envPort = Number(process.env.STACKDECK_PORT);
const PORT = Number.isInteger(envPort) && envPort >= 1 && envPort <= 65535 ? envPort : cfg.port;
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);

// maxHeaderSize: browsers can carry >16KB of localhost cookies from other dev
// apps, which would hit Node's default header limit and 431 every request.
const handle = async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  // This daemon executes shell commands, so it must only answer its own page
  // and local tools — never a random website the user has open:
  //  1. Host pinning: defeats DNS-rebinding (attacker.com resolving to 127.0.0.1).
  //  2. JSON-only POSTs: a cross-origin JSON POST triggers a CORS preflight,
  //     which we never answer, so browsers block it. text/plain sneak-POSTs
  //     are rejected here.
  //  3. Origin check: if a browser attaches an Origin, it must be ours.
  if (!ALLOWED_HOSTS.has(req.headers.host)) return json(res, 403, { error: "unrecognized Host" });
  if (req.method === "POST") {
    const ct = (req.headers["content-type"] || "").split(";")[0].trim();
    if (ct !== "application/json") return json(res, 415, { error: "content-type must be application/json" });
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) return json(res, 403, { error: "cross-origin request rejected" });
  }

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(fs.readFileSync(path.join(ROOT, "index.html"), "utf8").replace("__STACKDECK_TOKEN__", TOKEN));
  }

  // Everything under /api needs the per-install token (header, or ?t= for
  // EventSource which cannot set headers). Only the bare liveness ping is open.
  if (req.method === "GET" && url.pathname === "/api/ping")
    return json(res, 200, { ok: true, version: VERSION });
  if (url.pathname.startsWith("/api/")) {
    const t = req.headers["x-stackdeck-token"] || url.searchParams.get("t");
    if (!tokenOk(t)) return json(res, 401, { error: "missing or invalid token — reload the page" });
  }

  if (req.method === "GET" && url.pathname === "/api/meta")
    return json(res, 200, {
      version: VERSION,
      home: os.homedir(),
      configPath: CONFIG_PATH,
      logDir: LOG_DIR,
      projectRoots: cfg.projectRoots,
      categoryOrder: cfg.categoryOrder || [],
      excludes: cfg.excludes || [],
      proxyPort: PROXY_PORT,
      theme: cfg.theme || "",
      themeTokens: cfg.themeTokens || null,
    });

  if (req.method === "POST" && url.pathname === "/api/config") {
    // UI-editable settings. Only whitelisted fields; strings trimmed, empties dropped.
    const b = await readBody(req);
    const strList = (v) => Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : null;
    const roots = strList(b.projectRoots);
    if (roots) {
      if (!roots.length) return json(res, 400, { error: "at least one project root is required" });
      const missing = roots.filter((r) => !fs.existsSync(expand(r)));
      if (missing.length) return json(res, 400, { error: `not a directory: ${missing.join(", ")}` });
      cfg.projectRoots = roots;
    }
    const order = strList(b.categoryOrder);
    if (order !== null) cfg.categoryOrder = order;
    const excludes = strList(b.excludes);
    if (excludes !== null) cfg.excludes = excludes;
    if (b.theme !== undefined) {
      const t = String(b.theme);
      if (!["", "playful", "austere", "custom"].includes(t)) return json(res, 400, { error: "unknown theme" });
      cfg.theme = t;
    }
    if (b.themeTokens !== undefined && typeof b.themeTokens === "object" && b.themeTokens) {
      // numeric knobs only, clamped — nothing here ever reaches a shell or HTML
      const lim = { hue: [0, 360], tint: [0, 0.05], bgL: [0.08, 0.99], accentHue: [0, 360], accentC: [0, 0.25], radius: [0, 20] };
      const tk = {};
      for (const [k, [lo, hi]] of Object.entries(lim)) {
        const v = Number(b.themeTokens[k]);
        if (Number.isFinite(v)) tk[k] = Math.min(hi, Math.max(lo, v));
      }
      if (b.themeTokens.font === "mono" || b.themeTokens.font === "sans") tk.font = b.themeTokens.font;
      cfg.themeTokens = tk;
    }
    saveCfg();
    projCache.t = 0;
    return json(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/fs") {
    // List subdirectories — powers the folder browser. Browsing is limited to
    // the home directory and configured roots; the daemon user can read more,
    // but the API shouldn't hand it out.
    const p = path.resolve(expand(url.searchParams.get("path") || "~"));
    const allowedUnder = [os.homedir(), ...cfg.projectRoots.map((r) => path.resolve(expand(r)))];
    if (!allowedUnder.some((base) => p === base || p.startsWith(base + path.sep)))
      return json(res, 403, { error: "browsing is limited to your home directory and project roots" });
    try {
      const dirs = fs.readdirSync(p, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort(byName);
      return json(res, 200, { path: p, parent: path.dirname(p), dirs });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/services")
    return json(res, 200, {
      groups: cfg.groups,
      hiddenGroups: cfg.hiddenGroups || [],
      hiddenCategories: cfg.hiddenCategories || [],
      services: cfg.services.map(serviceState),
      instances: Object.entries(instances)
        .filter(([, i]) => instLive(i))
        .map(([key, i]) => ({ key, svc: i.svc, branch: i.branch, port: i.port, pid: instPid(i), startedAt: i.startedAt, adopted: !i.child, externalWorktree: !!i.externalWorktree })),
    });

  if (req.method === "POST" && url.pathname === "/api/worktree/start") {
    const { name, branch } = await readBody(req);
    const s = findSvc(name);
    if (!s) return json(res, 404, { error: "unknown service" });
    if (typeof branch !== "string" || !branch) return json(res, 400, { error: "branch required" });
    const r = startWorktree(s, branch);
    return json(res, r.code, r);
  }

  if (req.method === "POST" && url.pathname === "/api/worktree/stop") {
    const { key } = await readBody(req);
    const i = instances[key];
    if (!i || !instLive(i)) return json(res, 404, { error: "no such running instance" });
    const pid = instPid(i);
    try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch {} }
    if (i.child) {
      const child = i.child;
      setTimeout(() => { if (child.exitCode === null) { try { process.kill(-pid, "SIGKILL"); } catch {} } }, 5000).unref();
    } else { delete instances[key]; saveProcs(); }
    return json(res, 200, { ok: true, stopped: pid });
  }

  if (req.method === "POST" && url.pathname === "/api/worktree/remove") {
    // Delete a stopped instance's worktree checkout (git metadata included).
    const { name, branch } = await readBody(req);
    const s = findSvc(name);
    if (!s) return json(res, 404, { error: "unknown service" });
    const safeBranch = String(branch || "").replace(/[^A-Za-z0-9._-]+/g, "-");
    if (!safeBranch || safeBranch === "." || safeBranch === "..")
      return json(res, 400, { error: "bad branch name" });
    const key = `${name}@${safeBranch}`;
    if (instances[key] && instLive(instances[key])) return json(res, 409, { error: "stop the instance first" });
    if (instances[key] && instances[key].externalWorktree) { // not ours to delete
      delete instances[key];
      saveProcs();
      return json(res, 200, { ok: true, note: "that worktree was made outside Stackdeck — removed from the board, left on disk" });
    }
    delete instances[key];
    const wtDir = path.join(DATA_HOME, "worktrees", name, safeBranch);
    const r = git(svcDir(s), "worktree", "remove", "--force", wtDir);
    git(svcDir(s), "worktree", "prune");
    saveProcs();
    if (!r.ok && fs.existsSync(wtDir)) return json(res, 500, { error: `git worktree remove: ${r.out.split("\n").pop()}` });
    return json(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/infra")
    return json(res, 200, INFRA().map((t) => ({
      name: t.name, title: t.title, port: t.port, command: t.command,
      found: !!which(t.bin),
      runningPid: portPid(t.port),
      configured: cfg.services.some((s) => s.name === t.name),
    })).filter((t) => t.found));

  if (req.method === "GET" && url.pathname === "/api/projects") {
    if (!projCache.data || Date.now() - projCache.t > 30000 || url.searchParams.has("fresh"))
      projCache = { t: Date.now(), data: scanProjects() };
    return json(res, 200, projCache.data);
  }

  if (req.method === "POST" && url.pathname === "/api/start") {
    const { name, branch, force } = await readBody(req);
    const s = findSvc(name);
    if (!s) return json(res, 404, { error: "unknown service" });
    if (Array.isArray(s.dependsOn) && s.dependsOn.length) {
      const dep = await startWithDeps(s.dependsOn, false);
      const failed = Object.entries(dep).find(([, v]) => v.error);
      if (failed) return json(res, 409, { error: `dependency '${failed[0]}': ${failed[1].error}` });
    }
    const r = await startService(s, branch, force === true);
    return json(res, r.code, r);
  }

  if (req.method === "POST" && url.pathname === "/api/start-all") {
    // Dependency-ordered bulk start for one section (null group = Ungrouped).
    const { group } = await readBody(req);
    const names = cfg.services
      .filter((s) => (s.group || null) === (group || null) && !s.hidden)
      .map((s) => s.name);
    if (!names.length) return json(res, 400, { error: "nothing to start" });
    const results = await startWithDeps(names, false);
    return json(res, 200, { results });
  }

  if (req.method === "POST" && url.pathname === "/api/stop") {
    const { name } = await readBody(req);
    const s = findSvc(name);
    if (!s) return json(res, 404, { error: "unknown service" });
    const r = await stopService(s);
    return json(res, r.code, r);
  }

  if (req.method === "POST" && url.pathname === "/api/restart") {
    const { name } = await readBody(req);
    const s = findSvc(name);
    if (!s) return json(res, 404, { error: "unknown service" });
    const r = await restartService(s);
    return json(res, r.code, r);
  }

  if (req.method === "POST" && url.pathname === "/api/hide") {
    const { type, name, hidden } = await readBody(req);
    if (type === "service") {
      const s = findSvc(name);
      if (!s) return json(res, 404, { error: "unknown service" });
      if (hidden) s.hidden = true; else delete s.hidden;
    } else if (type === "group" || type === "category") {
      const key = type === "group" ? "hiddenGroups" : "hiddenCategories";
      const list = new Set(cfg[key] || []);
      hidden ? list.add(name) : list.delete(name);
      cfg[key] = [...list];
    } else return json(res, 400, { error: "bad type" });
    saveCfg();
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/group") {
    const { name } = await readBody(req);
    const n = (name || "").trim();
    if (!validLabel(n)) return json(res, 400, { error: "section name: 1–64 chars, no quotes/slashes/angle brackets" });
    if (cfg.groups.includes(n)) return json(res, 409, { error: "section already exists" });
    cfg.groups.push(n);
    saveCfg();
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/group/rename") {
    const { name, newName } = await readBody(req);
    const n = (newName || "").trim();
    if (!cfg.groups.includes(name)) return json(res, 404, { error: "unknown section" });
    if (!validLabel(n)) return json(res, 400, { error: "section name: 1–64 chars, no quotes/slashes/angle brackets" });
    if (n !== name && cfg.groups.includes(n)) return json(res, 409, { error: "a section with that name already exists" });
    cfg.groups = cfg.groups.map((g) => (g === name ? n : g));
    for (const s of cfg.services) if (s.group === name) s.group = n;
    cfg.hiddenGroups = (cfg.hiddenGroups || []).map((g) => (g === name ? n : g));
    saveCfg();
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/group/delete") {
    const { name } = await readBody(req);
    if (!cfg.groups.includes(name)) return json(res, 404, { error: "unknown section" });
    cfg.groups = cfg.groups.filter((g) => g !== name);
    for (const s of cfg.services) if (s.group === name) delete s.group;
    saveCfg();
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/move") {
    const { name, group, before } = await readBody(req);
    const s = findSvc(name);
    if (!s) return json(res, 404, { error: "unknown service" });
    if (group && !cfg.groups.includes(group)) return json(res, 404, { error: "unknown section" });
    cfg.services = cfg.services.filter((x) => x.name !== name);
    if (group) s.group = group; else delete s.group;
    const beforeIdx = before ? cfg.services.findIndex((x) => x.name === before) : -1;
    if (beforeIdx >= 0) cfg.services.splice(beforeIdx, 0, s);
    else {
      let last = -1;
      cfg.services.forEach((x, i) => { if ((x.group || null) === (group || null)) last = i; });
      cfg.services.splice(last + 1, 0, s);
    }
    saveCfg();
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/category") {
    const { name } = await readBody(req);
    const n = (name || "").trim();
    if (!validLabel(n)) return json(res, 400, { error: "category name: 1–64 chars, no quotes/slashes/angle brackets" });
    cfg.categoryOrder = cfg.categoryOrder || [];
    if (n === "Uncategorized" || cfg.categoryOrder.includes(n)) return json(res, 409, { error: "category already exists" });
    cfg.categoryOrder.push(n);
    saveCfg();
    projCache.t = 0;
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/category/delete") {
    const { name } = await readBody(req);
    cfg.categoryOrder = (cfg.categoryOrder || []).filter((c) => c !== name);
    for (const k of Object.keys(cfg.projectCategories || {}))
      if (cfg.projectCategories[k] === name) delete cfg.projectCategories[k];
    cfg.hiddenCategories = (cfg.hiddenCategories || []).filter((c) => c !== name);
    saveCfg();
    projCache.t = 0;
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/project/category") {
    // Assign a project to a category (null/absent = back to Uncategorized).
    const { name, category } = await readBody(req);
    if (typeof name !== "string" || !name || name.length > 128) return json(res, 400, { error: "bad project name" });
    cfg.projectCategories = cfg.projectCategories || {};
    if (category) {
      if (!validLabel(category)) return json(res, 400, { error: "bad category name" });
      cfg.projectCategories[name] = category;
      cfg.categoryOrder = cfg.categoryOrder || [];
      if (!cfg.categoryOrder.includes(category)) cfg.categoryOrder.push(category);
    } else delete cfg.projectCategories[name];
    saveCfg();
    projCache.t = 0;
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/service/rename") {
    const { name, newName } = await readBody(req);
    const s = findSvc(name);
    if (!s) return json(res, 404, { error: "unknown service" });
    const n = (newName || "").trim();
    if (!validSvcName(n)) return json(res, 400, { error: "service name must be letters/digits/dot/dash/underscore, max 64 chars" });
    if (n !== name && findSvc(n)) return json(res, 409, { error: "a service with that name already exists" });
    s.name = n;
    // Carry live runtime state across the rename (works mid-run). The disk
    // log follows too, so history doesn't split across two files.
    if (logStreams[name]) { logStreams[name].end(); delete logStreams[name]; }
    if (n !== name) {
      try { fs.renameSync(path.join(LOG_DIR, `${name}.log`), path.join(LOG_DIR, `${n}.log`)); } catch {}
      for (const map of [procs, buffers, clients, adopted, logWrites])
        if (name in map) { map[n] = map[name]; delete map[name]; }
      saveProcs();
    }
    saveCfg();
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/service") {
    const b = await readBody(req);
    if (!b.name || !b.dir || !b.command) return json(res, 400, { error: "name, dir, command are required" });
    if (!validSvcName(b.name))
      return json(res, 400, { error: "service name must be letters/digits/dot/dash/underscore, max 64 chars" });
    let s = findSvc(b.name);
    if (s && ((procs[s.name] && procs[s.name].child.exitCode === null) || adoptedPid(s.name)))
      return json(res, 409, { error: "stop the service before editing it" });
    if (typeof b.dir !== "string" || b.dir.length > 512) return json(res, 400, { error: "bad dir" });
    let dirStat = null;
    try { dirStat = fs.statSync(expand(b.dir.trim())); } catch {}
    if (!dirStat || !dirStat.isDirectory()) return json(res, 400, { error: `not a directory: ${b.dir}` });
    if (typeof b.command !== "string" || b.command.length > 4096) return json(res, 400, { error: "bad command" });
    if (b.env !== undefined && !validEnv(b.env)) return json(res, 400, { error: "env must be a flat object of string values with valid names" });
    if (b.port !== undefined && b.port !== null && b.port !== "") {
      const p = Number(b.port);
      if (!Number.isInteger(p) || p < 1 || p > 65535) return json(res, 400, { error: "port must be 1–65535" });
      b.port = p;
    } else b.port = undefined;
    if (!s) { s = { name: b.name }; cfg.services.push(s); }
    s.dir = b.dir.trim(); s.command = b.command.trim();
    s.port = b.port;
    s.env = b.env !== undefined ? b.env : (s.env || {});
    if (b.envFile !== undefined) { // false disables .env auto-load; string picks a file
      if (b.envFile === false || typeof b.envFile === "string") s.envFile = b.envFile;
      else delete s.envFile;
    }
    if (b.restart !== undefined) {
      if (b.restart === "on-failure") s.restart = "on-failure"; else delete s.restart;
      const rt = restarts[s.name]; if (rt) { clearTimeout(rt.timer); rt.n = 0; } // editing resets give-up state
    }
    if (b.dependsOn !== undefined) {
      const deps = Array.isArray(b.dependsOn) ? b.dependsOn.filter(validSvcName).filter((d) => d !== b.name) : [];
      if (deps.length) s.dependsOn = deps; else delete s.dependsOn;
    }
    if (b.readyWhen !== undefined) {
      const rw = b.readyWhen;
      if (rw && typeof rw === "object" && (typeof rw.log === "string" || typeof rw.http === "string")) {
        if (typeof rw.log === "string") { try { new RegExp(rw.log); } catch { return json(res, 400, { error: "readyWhen.log is not a valid regex" }); } }
        if (typeof rw.http === "string" && rw.http && !/^https?:\/\//.test(rw.http))
          return json(res, 400, { error: "readyWhen.http must start with http:// or https://" });
        s.readyWhen = { ...(typeof rw.log === "string" && rw.log ? { log: rw.log } : {}), ...(typeof rw.http === "string" && rw.http ? { http: rw.http } : {}) };
        if (!Object.keys(s.readyWhen).length) delete s.readyWhen;
      } else delete s.readyWhen;
    }
    if (b.group !== undefined) {
      if (b.group && cfg.groups.includes(b.group)) s.group = b.group;
      else delete s.group;
    }
    if (b.onDemand !== undefined) {
      if (b.onDemand) {
        if (!s.port) return json(res, 400, { error: "start on demand needs a port (that's how the proxy reaches it)" });
        s.onDemand = true;
      } else delete s.onDemand;
    }
    if (b.idleAfter !== undefined) {
      const m = Number(b.idleAfter);
      if (b.idleAfter === "" || b.idleAfter === null || m === 0) delete s.idleAfter;
      else if (!Number.isFinite(m) || m < 1 || m > 1440) return json(res, 400, { error: "idle stop must be 1–1440 minutes" });
      else s.idleAfter = Math.round(m);
    }
    saveCfg();
    projCache.t = 0; // "configured" flags may have changed
    return json(res, 200, serviceState(s));
  }

  if (req.method === "POST" && url.pathname === "/api/service/delete") {
    const { name } = await readBody(req);
    const s = findSvc(name);
    if (!s) return json(res, 404, { error: "unknown service" });
    if (procs[name] && procs[name].child.exitCode === null) return json(res, 409, { error: "stop it first" });
    cfg.services = cfg.services.filter((x) => x.name !== name);
    logStreams[name]?.end();
    delete logStreams[name]; delete buffers[name]; delete logWrites[name]; delete adopted[name];
    saveProcs();
    saveCfg();
    projCache.t = 0; // "configured" flags may have changed
    return json(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/logs") {
    const name = url.searchParams.get("name");
    if (!findSvc(name) && !instances[name] && !buffers[name]) return json(res, 404, { error: "unknown service" });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(":connected\n\n"); // SSE comment: flushes headers even when the buffer is empty
    for (const l of (buffers[name] || []).slice(-300)) res.write(`data: ${JSON.stringify(l)}\n\n`);
    // Capture the Set itself: after a service rename the map key changes, and
    // a close handler holding the old name would throw on a missing entry.
    const set = (clients[name] = clients[name] || new Set());
    set.add(res);
    res.on("error", () => set.delete(res)); // client vanished mid-write
    req.on("close", () => set.delete(res));
    return;
  }

  json(res, 404, { error: "not found" });
};

// maxHeaderSize: browsers can carry >16KB of localhost cookies from other dev apps.
const server = http.createServer({ maxHeaderSize: 262144 }, (req, res) => {
  handle(req, res).catch((e) => {
    console.error("request error:", e);
    try { json(res, 500, { error: `internal error: ${e.message}` }); } catch {}
  });
});

server.on("error", (e) => {
  console.error(e.code === "EADDRINUSE"
    ? `port ${PORT} is already in use — is another stackdeck daemon running?`
    : `server error: ${e.message}`);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () =>
  console.log(`stackdeck v${VERSION} · http://localhost:${PORT} · config ${CONFIG_PATH}`)
);

/* ---------- *.localhost reverse proxy ----------
   Browsers resolve *.localhost to loopback natively — no /etc/hosts, no PAC
   file. <service>.localhost → 127.0.0.1:<service port>. Unauthenticated by
   design (it only forwards to ports you configured); WebSockets pass through.
   Port 80 usually needs privileges (or is taken); we fall back to 8880. */
const net = require("net");
let PROXY_PORT = null;
const proxyTarget = (hostHeader) => {
  // Browsers lowercase hosts; curl and code may not — normalize.
  const m = /^([a-z0-9._-]+)\.localhost(?::\d+)?$/.exec((hostHeader || "").toLowerCase());
  if (!m) return null;
  const label = m[1];
  const svcByName = (n) => cfg.services.find((x) => x.name.toLowerCase() === n);
  const instByKey = (k) => {
    for (const [key, i] of Object.entries(instances))
      if (key.toLowerCase() === k && instLive(i) && i.port) return i;
    return null;
  };
  // 1. plain service:            orders-api.localhost
  const svc = svcByName(label);
  if (svc && svc.port) return { svc, port: svc.port };
  // 2. worktree instance:        feature-x.orders-api.localhost  (branch.service)
  const dot = label.lastIndexOf(".");
  if (dot > 0) {
    const i = instByKey(`${label.slice(dot + 1)}@${label.slice(0, dot)}`);
    if (i) return { port: i.port };
  }
  // 3. single-label form:        orders-api--feature-x.localhost
  const dash = label.indexOf("--");
  if (dash > 0) {
    const i = instByKey(`${label.slice(0, dash)}@${label.slice(dash + 2)}`);
    if (i) return { port: i.port };
  }
  return null;
};
const proxyTargetPort = (h) => (proxyTarget(h) || {}).port || null;

/* ---------- start on demand / idle stop ----------
   Opt-in per service (onDemand). Visiting <service>.localhost boots a stopped
   service and holds the request until it's ready. Off by default on purpose:
   the proxy is unauthenticated, so with onDemand any page you visit could
   cause a start. idleAfter (minutes) stops it again once nothing has hit it. */
const lastHit = nul();     // name -> timestamp of last proxied request
const demandStarts = nul(); // name -> in-flight start promise (parallel requests share one)

function svcRunning(s) {
  if (procs[s.name] && procs[s.name].child.exitCode === null) return true;
  if (adoptedPid(s.name)) return true;
  return !!(s.port && portPid(s.port));
}
function startOnDemand(s) {
  if (demandStarts[s.name]) return demandStarts[s.name];
  const p = (async () => {
    pushLog(s.name, `[stackdeck] on-demand start (request for ${s.name}.localhost)\n`);
    const r = await startService(s);
    if (r.code !== 200 && !r.already) return { ok: false, why: r.error };
    const ready = await waitReady(s, 60000);
    return ready.ok ? { ok: true } : { ok: false, why: ready.why };
  })().finally(() => { delete demandStarts[s.name]; });
  demandStarts[s.name] = p;
  return p;
}
setInterval(() => {
  const now = Date.now();
  for (const s of cfg.services) {
    const mins = Number(s.idleAfter);
    if (!mins || !svcRunning(s)) continue;
    const rec = procs[s.name];
    if (!rec) continue; // only ever auto-stop what we started
    const since = Math.max(lastHit[s.name] || 0, rec.startedAt || 0);
    if (now - since < mins * 60000) continue;
    pushLog(s.name, `[stackdeck] idle for ${mins}m with no requests — stopping\n`);
    stopService(s).catch(() => {});
  }
}, 30000).unref();
const proxy = http.createServer({ maxHeaderSize: 262144 }, async (req, res) => {
  const t = proxyTarget(req.headers.host);
  if (!t) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("stackdeck: no service with that name (or it has no port)\n"); }
  const { port, svc } = t;
  if (svc) {
    lastHit[svc.name] = Date.now();
    if (svc.onDemand && !svcRunning(svc)) {
      const r = await startOnDemand(svc);
      if (!r.ok) {
        res.writeHead(502, { "Content-Type": "text/plain" });
        return res.end(`stackdeck: could not start ${svc.name} on demand — ${r.why}\n`);
      }
    }
  }
  // Host is rewritten: dev servers (Vite post-CVE, others) reject unknown hosts.
  const headers = { ...req.headers, host: `127.0.0.1:${port}` };
  // host "localhost" + autoSelectFamily: dev servers bind IPv4 or IPv6-only
  // (Vite uses [::1]) — try both families.
  const up = http.request({ host: "localhost", autoSelectFamily: true, port, path: req.url, method: req.method, headers, timeout: 30000 }, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res);
  });
  up.on("timeout", () => up.destroy(new Error("upstream timed out")));
  up.on("error", (e) => { try { res.writeHead(502, { "Content-Type": "text/plain" }); res.end(`stackdeck proxy: ${e.message}\n`); } catch {} });
  req.pipe(up);
});
proxy.on("upgrade", (req, socket, head) => {
  const t = proxyTarget(req.headers.host);
  if (!t) return socket.destroy();
  const port = t.port;
  if (t.svc) lastHit[t.svc.name] = Date.now(); // a live socket counts as activity
  const up = net.connect({ port, host: "localhost", autoSelectFamily: true }, () => {
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const h = req.rawHeaders[i].toLowerCase() === "host" ? `127.0.0.1:${port}` : req.rawHeaders[i + 1];
      raw += `${req.rawHeaders[i]}: ${h}\r\n`;
    }
    up.write(raw + "\r\n");
    if (head && head.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});
(function listenProxy(ports) {
  if (!ports.length) { console.error("proxy: no port available — *.localhost domains disabled"); return; }
  const p = ports[0];
  proxy.once("error", (e) => {
    if (e.code === "EADDRINUSE" || e.code === "EACCES") listenProxy(ports.slice(1));
    else console.error(`proxy error: ${e.message}`);
  });
  proxy.listen(p, "127.0.0.1", () => {
    PROXY_PORT = p;
    console.log(`*.localhost proxy on :${p}`);
  });
})([80, 8880]);
