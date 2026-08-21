#!/usr/bin/env node
/**
 * DevBoard daemon — your projects folder, as a control panel.
 *
 * Zero dependencies (Node >= 18 builtins only). Binds to 127.0.0.1.
 *
 *   node server.js            run in foreground
 *   devboard                  (CLI) start daemon + open the board
 *
 * State lives in $DEVBOARD_HOME, else ~/.devboard (legacy, if present),
 * else $XDG_CONFIG_HOME/devboard (default ~/.config/devboard):
 *   config.json   services, sections, project roots, categories
 *   logs/         one log file per service + the daemon's own log
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execFileSync } = require("child_process");

const VERSION = "0.1.0";
const ROOT = __dirname;

/* ---------- state directory & config ---------- */

const expand = (p) => (p && p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

function resolveHome() {
  if (process.env.DEVBOARD_HOME) return expand(process.env.DEVBOARD_HOME);
  const legacy = path.join(os.homedir(), ".devboard");
  if (fs.existsSync(path.join(legacy, "config.json"))) return legacy;
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdg, "devboard");
}

const HOME_DIR = resolveHome();
const CONFIG_PATH = path.join(HOME_DIR, "config.json");
const LOG_DIR = path.join(HOME_DIR, "logs");
fs.mkdirSync(LOG_DIR, { recursive: true });

if (!fs.existsSync(CONFIG_PATH))
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({
    port: 8899,
    projectRoots: ["~/Projects"],
    services: [],
    groups: [],
  }, null, 2) + "\n");

let cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
cfg.groups = Array.isArray(cfg.groups) ? cfg.groups : [];
cfg.projectRoots = Array.isArray(cfg.projectRoots) && cfg.projectRoots.length ? cfg.projectRoots : ["~/Projects"];
const saveCfg = () => fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
const findSvc = (name) => cfg.services.find((s) => s.name === name);
const svcDir = (s) => expand(s.dir);

/* ---------- environment for spawned services ---------- */

// GUI launches (Finder, systemd user units) hand daemons a bare PATH with no
// nvm/homebrew/uv. Resolve the user's interactive-shell PATH once, so spawned
// services see the same toolchain the user's terminal does.
function resolveShellPath() {
  try {
    const shell = process.env.SHELL || "/bin/bash";
    const out = execFileSync(shell, ["-lc", "printf %s \"$PATH\""], { timeout: 8000 }).toString().trim();
    if (out.split(":").length > 3) return out;
  } catch {}
  return process.env.PATH;
}
const SHELL_PATH = resolveShellPath();

/* ---------- helpers ---------- */

function git(dir, ...args) {
  try {
    return { ok: true, out: execFileSync("git", ["-C", dir, ...args], { timeout: 8000 }).toString().trim() };
  } catch (e) {
    return { ok: false, out: (e.stderr || e.message || "").toString().trim() };
  }
}

function portPid(port) {
  if (!port) return null;
  try { // macOS + most Linux
    const out = execFileSync("lsof", ["-tnP", `-iTCP:${port}`, "-sTCP:LISTEN"], { timeout: 4000 }).toString().trim();
    if (out) return Number(out.split("\n")[0]);
  } catch {}
  try { // Linux fallback (iproute2)
    const out = execFileSync("ss", ["-ltnpH", `sport = :${port}`], { timeout: 4000 }).toString();
    const m = out.match(/pid=(\d+)/);
    if (m) return Number(m[1]);
  } catch {}
  return null;
}

const MAX_BUF = 2000;
const procs = {};   // name -> { child, startedAt, branch }
const buffers = {}; // name -> [lines]
const clients = {}; // name -> Set<res> (SSE)

function pushLog(name, chunk) {
  const lines = chunk.toString().split("\n").filter((l) => l.length);
  const buf = (buffers[name] = buffers[name] || []);
  for (const l of lines) {
    buf.push(l);
    if (buf.length > MAX_BUF) buf.shift();
  }
  fs.appendFile(path.join(LOG_DIR, `${name}.log`), chunk, () => {});
  for (const res of clients[name] || []) {
    for (const l of lines) res.write(`data: ${JSON.stringify(l)}\n\n`);
  }
}

function serviceState(s) {
  const dir = svcDir(s);
  const p = procs[s.name];
  const managedUp = p && p.child.exitCode === null;
  const pid = managedUp ? p.child.pid : portPid(s.port);
  const isGit = fs.existsSync(path.join(dir, ".git"));
  let branch = null, branches = [], dirty = false;
  if (isGit) {
    branch = git(dir, "branch", "--show-current").out || "(detached)";
    branches = (git(dir, "for-each-ref", "refs/heads", "--format=%(refname:short)").out || "").split("\n").filter(Boolean);
    dirty = (git(dir, "status", "--porcelain").out || "") !== "";
  }
  return {
    ...s,
    running: managedUp || pid !== null,
    managed: !!managedUp,
    pid,
    startedBranch: p ? p.branch : null,
    startedAt: p ? p.startedAt : null,
    branch, branches, dirty, isGit,
  };
}

/* ---------- project discovery ---------- */

let projCache = { t: 0, data: null };

// Fast branch read (no git spawn): parse .git/HEAD directly.
function gitBranchFast(dir) {
  try {
    const head = fs.readFileSync(path.join(dir, ".git", "HEAD"), "utf8").trim();
    return head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : "(detached)";
  } catch { return null; }
}

function inferCommand(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  try {
    if (has("package.json")) {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      const runner = has("pnpm-lock.yaml") || has("pnpm-workspace.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
      if (pkg.scripts && pkg.scripts.dev) return `${runner} run dev`;
      if (pkg.scripts && pkg.scripts.start) return `${runner} start`;
    }
    if (has("Makefile")) {
      const mk = fs.readFileSync(path.join(dir, "Makefile"), "utf8");
      for (const t of ["dev", "start", "run", "serve"]) if (new RegExp(`^${t}:`, "m").test(mk)) return `make ${t}`;
    }
    if (has("Procfile")) return null; // many processes; let the user pick
    if (has("pyproject.toml") || has("requirements.txt")) {
      const py = has("uv.lock") ? "uv run python" : "python3";
      for (const m of ["main.py", "app.py", "server.py", "run.py", "manage.py"])
        if (has(m)) return m === "manage.py" ? `${py} manage.py runserver` : `${py} ${m}`;
    }
    if (has("docker-compose.yml") || has("compose.yml") || has("compose.yaml")) return "docker compose up";
    if (has("Cargo.toml")) return "cargo run";
    if (has("go.mod")) return "go run .";
  } catch {}
  return null;
}

function scanProjects() {
  const out = [];
  const excluded = new Set((cfg.excludes || []).map(expand));
  const pc = cfg.projectCategories || {};
  const entry = (dir, name, root, catKeys) => ({
    name,
    dir,
    root,
    isGit: fs.existsSync(path.join(dir, ".git")),
    branch: gitBranchFast(dir),
    suggestedCommand: inferCommand(dir),
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
      if (fs.existsSync(path.join(dir, ".git")) || inferCommand(dir)) {
        out.push(entry(dir, e.name, root, [e.name]));
        continue;
      }
      // Container folder: not a repo itself, but may hold repos one level
      // down (e.g. symphony/repo.symphony_appstore). Surface those instead,
      // inheriting the container's category unless mapped individually.
      const subs = lsDirs(dir)
        .map((s) => path.join(dir, s.name))
        .filter((sdir) => !excluded.has(sdir))
        .filter((sdir) => fs.existsSync(path.join(sdir, ".git")) || inferCommand(sdir));
      if (subs.length) {
        for (const sdir of subs) {
          const sub = path.basename(sdir);
          out.push(entry(sdir, `${e.name}/${sub}`, root, [`${e.name}/${sub}`, sub, e.name]));
        }
      } else {
        out.push(entry(dir, e.name, root, [e.name])); // plain folder, listed as-is
      }
    }
  }
  out.sort((a, b) => (b.suggestedCommand ? 1 : 0) - (a.suggestedCommand ? 1 : 0) || a.name.localeCompare(b.name));
  return out;
}

/* ---------- actions ---------- */

function startService(s, branch) {
  const dir = svcDir(s);
  if (procs[s.name] && procs[s.name].child.exitCode === null)
    return { code: 409, error: `${s.name} is already running (managed)` };
  const busy = portPid(s.port);
  if (busy) return { code: 409, error: `port ${s.port} is busy (pid ${busy}, external) — kill it first` };
  if (!fs.existsSync(dir)) return { code: 400, error: `directory not found: ${dir}` };

  if (branch) {
    const cur = git(dir, "branch", "--show-current").out;
    if (branch !== cur) {
      if ((git(dir, "status", "--porcelain").out || "") !== "")
        return { code: 409, error: `cannot switch to '${branch}': working tree has uncommitted changes` };
      const co = git(dir, "checkout", branch);
      if (!co.ok) return { code: 500, error: `git checkout ${branch} failed: ${co.out}` };
      pushLog(s.name, `[devboard] checked out branch '${branch}'\n`);
    }
  }

  // Non-login, non-interactive shell: inherits the daemon's resolved PATH and
  // avoids surprises from profile files reordering toolchains.
  const child = spawn("bash", ["-c", s.command], {
    cwd: dir,
    env: { ...process.env, PATH: SHELL_PATH, ...(s.env || {}) },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => pushLog(s.name, d));
  child.stderr.on("data", (d) => pushLog(s.name, d));
  child.on("exit", (code, sig) => {
    pushLog(s.name, `[devboard] exited (code=${code} signal=${sig})\n`);
    delete procs[s.name];
  });
  procs[s.name] = { child, startedAt: Date.now(), branch: branch || null };
  pushLog(s.name, `[devboard] started: ${s.command} (pid ${child.pid})\n`);
  return { code: 200, ok: true, pid: child.pid };
}

function stopService(s) {
  const p = procs[s.name];
  if (p && p.child.exitCode === null) {
    const pid = p.child.pid;
    try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch {} }
    setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch {} }, 5000).unref();
    return { code: 200, ok: true, stopped: pid };
  }
  const ext = portPid(s.port);
  if (ext) {
    try { process.kill(ext, "SIGTERM"); } catch (e) { return { code: 500, error: `kill ${ext} failed: ${e.message}` }; }
    pushLog(s.name, `[devboard] killed external pid ${ext} on port ${s.port}\n`);
    return { code: 200, ok: true, stopped: ext, external: true };
  }
  return { code: 409, error: `${s.name} is not running` };
}

async function restartService(s) {
  const wasBranch = procs[s.name] ? procs[s.name].branch : null;
  const r = stopService(s);
  if (r.error && r.code !== 409) return r;
  for (let i = 0; i < 30; i++) { // wait up to ~6s for the port/process to clear
    const p = procs[s.name];
    if ((!p || p.child.exitCode !== null) && !portPid(s.port)) break;
    await new Promise((ok) => setTimeout(ok, 200));
  }
  return startService(s, wasBranch);
}

/* ---------- http ---------- */

const readBody = (req) => new Promise((resolve) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
});
const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

// maxHeaderSize: browsers can carry >16KB of localhost cookies from other dev
// apps, which would hit Node's default header limit and 431 every request.
const server = http.createServer({ maxHeaderSize: 262144 }, async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(fs.readFileSync(path.join(ROOT, "index.html")));
  }

  if (req.method === "GET" && url.pathname === "/api/meta")
    return json(res, 200, {
      version: VERSION,
      configPath: CONFIG_PATH,
      logDir: LOG_DIR,
      projectRoots: cfg.projectRoots,
      categoryOrder: cfg.categoryOrder || [],
      excludes: cfg.excludes || [],
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
    saveCfg();
    projCache.t = 0;
    return json(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/fs") {
    // List subdirectories of a path — powers the folder browser in settings.
    const p = expand(url.searchParams.get("path") || "~");
    try {
      const dirs = fs.readdirSync(p, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));
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
    });

  if (req.method === "GET" && url.pathname === "/api/projects") {
    if (!projCache.data || Date.now() - projCache.t > 30000 || url.searchParams.has("fresh"))
      projCache = { t: Date.now(), data: scanProjects() };
    return json(res, 200, projCache.data);
  }

  if (req.method === "POST" && url.pathname === "/api/start") {
    const { name, branch } = await readBody(req);
    const s = findSvc(name);
    if (!s) return json(res, 404, { error: "unknown service" });
    const r = startService(s, branch);
    return json(res, r.code, r);
  }

  if (req.method === "POST" && url.pathname === "/api/stop") {
    const { name } = await readBody(req);
    const s = findSvc(name);
    if (!s) return json(res, 404, { error: "unknown service" });
    const r = stopService(s);
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
    if (!n) return json(res, 400, { error: "section name required" });
    if (cfg.groups.includes(n)) return json(res, 409, { error: "section already exists" });
    cfg.groups.push(n);
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

  if (req.method === "POST" && url.pathname === "/api/service") {
    const b = await readBody(req);
    if (!b.name || !b.dir || !b.command) return json(res, 400, { error: "name, dir, command are required" });
    let s = findSvc(b.name);
    if (s && procs[s.name] && procs[s.name].child.exitCode === null)
      return json(res, 409, { error: "stop the service before editing it" });
    if (!s) { s = { name: b.name }; cfg.services.push(s); }
    s.dir = b.dir; s.command = b.command;
    s.port = b.port ? Number(b.port) : undefined;
    s.env = b.env && typeof b.env === "object" ? b.env : (s.env || {});
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
    saveCfg();
    projCache.t = 0; // "configured" flags may have changed
    return json(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/logs") {
    const name = url.searchParams.get("name");
    if (!findSvc(name)) return json(res, 404, { error: "unknown service" });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    for (const l of (buffers[name] || []).slice(-300)) res.write(`data: ${JSON.stringify(l)}\n\n`);
    (clients[name] = clients[name] || new Set()).add(res);
    req.on("close", () => clients[name].delete(res));
    return;
  }

  json(res, 404, { error: "not found" });
});

const PORT = Number(process.env.DEVBOARD_PORT || cfg.port || 8899);
server.listen(PORT, "127.0.0.1", () =>
  console.log(`devboard v${VERSION} · http://localhost:${PORT} · config ${CONFIG_PATH}`)
);
