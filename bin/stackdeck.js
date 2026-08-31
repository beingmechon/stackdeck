#!/usr/bin/env node
/**
 * stackdeck CLI — same daemon as the web board.
 *
 *   stackdeck                start the daemon (if down) and open the board
 *   stackdeck daemon         run the daemon in the foreground
 *   stackdeck status         list services and their state
 *   stackdeck start <name>   start a service
 *   stackdeck stop <name>    stop a service
 *   stackdeck restart <name> restart a service
 *   stackdeck logs <name>    stream a service's logs (Ctrl-C to quit)
 *   stackdeck ports [q]      every listening port, and who owns it
 *   stackdeck kill <pid>     kill whatever is holding a port
 *   stackdeck tui            the same board, in the terminal
 *   stackdeck mcp            run an MCP server over stdio (for AI agents)
 *   stackdeck version|help
 */
"use strict";
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, execFileSync } = require("child_process");

const SERVER = path.join(__dirname, "..", "server.js");
const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version; }
  catch { return "unknown"; }
})();

// The API requires the per-install secret; same-user processes read it from disk.
function stateHome() {
  if (process.env.STACKDECK_HOME)
    return process.env.STACKDECK_HOME.replace(/^~(?=\/|$)/, os.homedir());
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdg, "stackdeck");
}
const token = () => { try { return fs.readFileSync(path.join(stateHome(), "secret"), "utf8").trim(); } catch { return ""; } };
const authHeaders = () => ({ "X-Stackdeck-Token": token() });

// Same port resolution as the daemon: env override, else config, else default.
function resolvePort() {
  const env = Number(process.env.STACKDECK_PORT);
  if (Number.isInteger(env) && env >= 1 && env <= 65535) return env;
  try {
    const p = JSON.parse(fs.readFileSync(path.join(stateHome(), "config.json"), "utf8")).port;
    if (Number.isInteger(p) && p >= 1 && p <= 65535) return p;
  } catch {}
  return 8899;
}
const PORT = resolvePort();
const BASE = `http://127.0.0.1:${PORT}`;

async function up() {
  try { const r = await fetch(`${BASE}/api/ping`); return r.ok; } catch { return false; }
}

async function ensureDaemon() {
  if (await up()) return;
  // The daemon's own stderr (crash guards, request errors) goes to a log —
  // safety nets that report to /dev/null are worse than no nets.
  let out = "ignore";
  try {
    fs.mkdirSync(path.join(stateHome(), "logs"), { recursive: true, mode: 0o700 });
    out = fs.openSync(path.join(stateHome(), "logs", "daemon.log"), "a");
  } catch {}
  const child = spawn(process.execPath, [SERVER], { detached: true, stdio: ["ignore", out, out] });
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (await up()) return;
    await new Promise((ok) => setTimeout(ok, 250));
  }
  console.error("daemon did not come up — try: stackdeck daemon");
  process.exit(1);
}

async function post(pathname, body) {
  const r = await fetch(BASE + pathname, {
    method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error("error:", j.error || r.statusText); process.exit(1); }
  return j;
}

const age = (s) => s == null ? "" :
  s < 60 ? s + "s" : s < 3600 ? Math.round(s / 60) + "m" :
  s < 86400 ? Math.round(s / 3600) + "h" : Math.round(s / 86400) + "d";

/* WSL2 is Linux, but the browser is not: xdg-open there is usually absent,
   and opens nothing useful when it is present. wslview (from wslu) is the
   polite way across; explorer.exe always works and always exits non-zero, so
   its exit code is ignored rather than trusted. Falling back to printing the
   URL is the honest last resort — the board is still reachable. */
const isWSL = () => !!process.env.WSL_DISTRO_NAME ||
  (() => { try { return /microsoft/i.test(fs.readFileSync("/proc/version", "utf8")); } catch { return false; } })();

function openBrowser(url) {
  const openers = process.platform === "darwin" ? ["open"]
                : isWSL() ? ["wslview", "explorer.exe"]
                : ["xdg-open"];
  for (const cmd of openers) {
    try { execFileSync(cmd, [url], { stdio: "ignore" }); return; }
    catch (e) {
      if (e.code === "ENOENT") continue;          // not installed: try the next one
      if (cmd === "explorer.exe") return;         // it opened; it just says otherwise
    }
  }
  console.log(url);
}

const USAGE = `stackdeck ${VERSION} — your projects folder, as a control panel

  stackdeck                 start the daemon (if down) and open the board
  stackdeck tui             the same board, in your terminal
  stackdeck status          list services and their state
  stackdeck start <name>    start a service
  stackdeck stop <name>     stop a service
  stackdeck restart <name>  restart a service
  stackdeck logs <name>     stream a service's logs (Ctrl-C to quit)

  stackdeck ports [q]       every listening port on this machine, who owns it
  stackdeck kill <pid>      kill whatever is holding a port

  stackdeck daemon          run the daemon in the foreground
  stackdeck mcp             run an MCP server over stdio (for AI agents)

  stackdeck version         print the version
  stackdeck help            this text

Board: ${BASE}   ·   config and logs: ${stateHome()}`;

(async () => {
  const [cmd, name] = process.argv.slice(2);

  // Answered without touching the daemon: `--version` must work on a machine
  // where nothing is running (Homebrew's install test does exactly that).
  if (["version", "--version", "-v"].includes(cmd)) { console.log(VERSION); return; }
  if (["help", "--help", "-h"].includes(cmd)) { console.log(USAGE); return; }

  if (!cmd || cmd === "up" || cmd === "open") {
    await ensureDaemon();
    console.log(`stackdeck · ${BASE}`);
    openBrowser(BASE);
    return;
  }
  if (cmd === "daemon") {
    require(SERVER);
    return;
  }
  if (cmd === "status") {
    await ensureDaemon();
    const r = await fetch(`${BASE}/api/services`, { headers: authHeaders() });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { console.error("error:", d.error || r.statusText); process.exit(1); }
    for (const s of d.services) {
      const state = s.running ? (s.managed ? "up" : "up (external)") : "down";
      console.log(`${s.running ? "●" : "○"} ${s.name.padEnd(16)} ${state.padEnd(14)} :${s.port ?? "—"}  ${s.branch ?? ""}`);
    }
    return;
  }
  if (["start", "stop", "restart"].includes(cmd)) {
    if (!name) { console.error(`usage: stackdeck ${cmd} <service>`); process.exit(1); }
    await ensureDaemon();
    await post(`/api/${cmd}`, { name });
    console.log(`${name}: ${cmd} ok`);
    return;
  }
  // "what has :3000?" is the question people leave a dashboard to answer, so it
  // has to work without one: `stackdeck ports 3000` is the whole interaction.
  if (cmd === "ports") {
    await ensureDaemon();
    const r = await fetch(`${BASE}/api/ports?fresh=1`, { headers: authHeaders() });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { console.error("error:", d.error || r.statusText); process.exit(1); }
    const q = (name || "").toLowerCase();
    const rows = q
      ? d.ports.filter((p) => `${p.port} ${p.pid ?? ""} ${p.proc ?? ""} ${p.cmd ?? ""} ${p.owner ? p.owner.svc : ""}`.toLowerCase().includes(q))
      : d.ports;
    if (!rows.length) { console.log(q ? `nothing listening matches '${name}'` : "nothing is listening"); return; }
    const home = os.homedir();
    for (const p of rows) {
      if (p.foreign) {
        console.log(`:${String(p.port).padEnd(6)} ${"—".padEnd(8)} ${"another user".padEnd(14)} owned by root or another account — needs sudo`);
        continue;
      }
      const tags = [p.owner ? p.owner.svc : "", p.system ? "system" : ""].filter(Boolean).join(" ");
      console.log(
        `:${String(p.port).padEnd(6)} ${String(p.pid).padEnd(8)} ${String(p.proc || "").slice(0, 13).padEnd(14)}` +
        `${age(p.age).padStart(4)}  ${tags ? `[${tags}] ` : ""}${String(p.cmd || "").split(home).join("~").slice(0, 70)}`);
    }
    const foreign = rows.filter((p) => p.foreign).length;
    console.error(`\n${rows.length} shown · ${foreign} owned by another user (Stackdeck runs as you)`);
    return;
  }
  if (cmd === "kill") {
    if (!name) { console.error("usage: stackdeck kill <pid>   (see: stackdeck ports)"); process.exit(1); }
    await ensureDaemon();
    const j = await post("/api/kill", { pid: Number(name) });
    console.log(j.note || `killed pid ${name}${j.port ? ` on :${j.port}` : ""}${j.group ? " (and its process group)" : ""}`);
    return;
  }
  if (cmd === "logs") {
    if (!name) { console.error("usage: stackdeck logs <service>"); process.exit(1); }
    await ensureDaemon();
    const res = await fetch(`${BASE}/api/logs?name=${encodeURIComponent(name)}`, { headers: authHeaders() });
    if (!res.ok) { console.error("error:", (await res.json()).error); process.exit(1); }
    // fetch() yields Uint8Array, not Buffer — .toString() would give
    // "58,99,111,…". Decode explicitly, statefully across chunk boundaries.
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop(); // keep any partial SSE frame for the next chunk
      for (const line of lines)
        if (line.startsWith("data: ")) { try { console.log(JSON.parse(line.slice(6))); } catch {} }
    }
    return;
  }
  if (cmd === "tui" || cmd === "top") {
    await ensureDaemon();
    require("./tui.js")({ BASE, authHeaders, token });
    return;
  }
  if (cmd === "mcp") {
    await ensureDaemon();
    runMcp();
    return;
  }
  console.error(`unknown command: ${cmd}\n`);
  console.error(USAGE);
  process.exit(1);
})();

/* ---------- MCP server (stdio, zero-dep) ----------
   Exposes the daemon to AI agents: list services, start/stop/restart, read
   logs. Newline-delimited JSON-RPC 2.0, MCP protocol 2025-03-26. */
function runMcp() {
  const TOOLS = [
    { name: "list_services", description: "List all Stackdeck services with running state, port, pid, git branch, and dirty flag.",
      inputSchema: { type: "object", properties: {} } },
    { name: "start_service", description: "Start a service by name (starts its dependencies first). Optional branch to check out.",
      inputSchema: { type: "object", properties: { name: { type: "string" }, branch: { type: "string" } }, required: ["name"] } },
    { name: "stop_service", description: "Stop (kill) a service by name.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
    { name: "restart_service", description: "Restart a service by name.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
    { name: "get_logs", description: "Return the most recent log lines for a service (from its on-disk log).",
      inputSchema: { type: "object", properties: { name: { type: "string" }, lines: { type: "number", description: "default 100" } }, required: ["name"] } },
    // An agent that can start services but cannot see why a port is taken will
    // keep retrying a start that can never work. These close that loop.
    { name: "list_ports", description: "Every listening TCP port on this machine, not just configured services: port, pid, process, full command, age, which Stackdeck service owns it, whether it is an OS process, and whether it belongs to another user (then it cannot be inspected or killed without sudo, which Stackdeck never uses).",
      inputSchema: { type: "object", properties: { query: { type: "string", description: "optional filter over port, pid, process name and command" } } } },
    { name: "whats_on_port", description: "What is holding a specific port, if anything. Use this before starting a service that failed to bind.",
      inputSchema: { type: "object", properties: { port: { type: "number" } }, required: ["port"] } },
    /* The capability the whole project is built around, and the one an agent
       could not reach: it could start a service but not the parallel branch
       it had just made a worktree for. */
    { name: "list_worktrees", description: "Every git worktree of a service's repository, wherever it lives on disk and whatever created it — including ones you or another tool made. Says which are running under Stackdeck, on what port, and which Stackdeck created; only those can be removed by it.",
      inputSchema: { type: "object", properties: { name: { type: "string", description: "service name" } }, required: ["name"] } },
    { name: "start_worktree", description: "Run a branch of a service in its own git worktree, in parallel with the main checkout, on its own port. Adopts an existing worktree for that branch rather than creating a second. Heavy directories (node_modules, target, .venv) are symlinked from the main checkout, not copied.",
      inputSchema: { type: "object", properties: { name: { type: "string", description: "service name" }, branch: { type: "string" } }, required: ["name", "branch"] } },
    { name: "stop_worktree", description: "Stop a running worktree instance by its key (the \"service@branch\" form returned by list_worktrees or start_worktree). Stops the process; the worktree stays on disk.",
      inputSchema: { type: "object", properties: { key: { type: "string", description: "service@branch" } }, required: ["key"] } },
    { name: "kill_pid", description: "Kill a process by pid. Only pids currently holding a listening port can be killed; the daemon's own pid and other users' processes are refused. Prefer stop_service when the pid belongs to a configured service.",
      inputSchema: { type: "object", properties: { pid: { type: "number" } }, required: ["pid"] } },
  ];
  async function callTool(name, args) {
    if (name === "list_services") {
      const r = await fetch(`${BASE}/api/services`, { headers: authHeaders() });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      return d.services.map((s) => ({
        name: s.name, running: s.running, managed: s.managed, pid: s.pid, port: s.port ?? null,
        branch: s.branch, dirty: s.dirty, group: s.group ?? null, command: s.command, dir: s.dir,
      }));
    }
    if (["start_service", "stop_service", "restart_service"].includes(name)) {
      const ep = { start_service: "start", stop_service: "stop", restart_service: "restart" }[name];
      const r = await fetch(`${BASE}/api/${ep}`, {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ name: args.name, branch: args.branch }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      return d;
    }
    if (name === "list_worktrees") {
      const r = await fetch(`${BASE}/api/worktrees?name=${encodeURIComponent(args.name)}`, { headers: authHeaders() });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      return d.worktrees.map((w) => ({
        branch: w.branch, directory: w.dir, isMainCheckout: w.main,
        running: w.running, key: w.key, port: w.port, pid: w.pid,
        createdByStackdeck: w.createdByStackdeck,
        // Said outright: an agent must not assume it can clean up after a
        // worktree somebody else is working in.
        removable: w.createdByStackdeck && !w.main,
        ...(w.detached ? { detached: true } : {}),
      }));
    }
    if (name === "start_worktree" || name === "stop_worktree") {
      const ep = name === "start_worktree" ? "start" : "stop";
      const body = name === "start_worktree" ? { name: args.name, branch: args.branch } : { key: args.key };
      const r = await fetch(`${BASE}/api/worktree/${ep}`, {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      return d;
    }
    if (name === "list_ports" || name === "whats_on_port") {
      const r = await fetch(`${BASE}/api/ports?fresh=1`, { headers: authHeaders() });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      const shape = (p) => p.foreign
        ? { port: p.port, owner: "another user (root?)", killable: false,
            note: "Stackdeck runs as you and cannot see or kill this without sudo" }
        : { port: p.port, pid: p.pid, process: p.proc, command: p.cmd, ageSeconds: p.age,
            service: p.owner ? p.owner.svc : null, serviceState: p.owner ? p.owner.kind : null,
            operatingSystemProcess: !!p.system, boundToAllInterfaces: p.addrs.some((a) => /^(\*|0\.0\.0\.0|\[::\]):/.test(a)),
            killable: !p.self, isStackdeckItself: !!p.self };
      if (name === "whats_on_port") {
        const hit = d.ports.filter((p) => p.port === Number(args.port));
        return hit.length ? hit.map(shape) : { port: Number(args.port), free: true };
      }
      const q = String(args.query || "").toLowerCase();
      return d.ports
        .filter((p) => !q || `${p.port} ${p.pid ?? ""} ${p.proc ?? ""} ${p.cmd ?? ""}`.toLowerCase().includes(q))
        .map(shape);
    }
    if (name === "kill_pid") {
      const r = await fetch(`${BASE}/api/kill`, {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ pid: Number(args.pid) }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || r.statusText);
      return d;
    }
    if (name === "get_logs") {
      const n = Math.min(Math.max(Number(args.lines) || 100, 1), 2000);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(args.name)) throw new Error("bad service name");
      const file = path.join(stateHome(), "logs", `${args.name}.log`);
      let text = "";
      try { text = fs.readFileSync(file, "utf8"); } catch { throw new Error(`no logs for '${args.name}'`); }
      return text.split("\n").slice(-n).join("\n");
    }
    throw new Error(`unknown tool: ${name}`);
  }
  let pending = 0, stdinDone = false;
  const maybeExit = () => { if (stdinDone && pending === 0) process.exit(0); };
  const reply = (id, result, error) => {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error: { code: -32000, message: error } } : { result }) }) + "\n");
  };
  let buf = "";
  process.stdin.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    const linesIn = buf.split("\n");
    buf = linesIn.pop();
    for (const line of linesIn) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.method === "initialize")
        reply(msg.id, { protocolVersion: "2025-03-26", capabilities: { tools: {} },
          serverInfo: { name: "stackdeck", version: VERSION } });
      else if (msg.method === "tools/list") reply(msg.id, { tools: TOOLS });
      else if (msg.method === "tools/call") {
        pending++; // dispatched concurrently: a slow call must not delay (or exit before) queued ones
        callTool(msg.params.name, msg.params.arguments || {})
          .then((out) => reply(msg.id, { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out, null, 2) }] }))
          .catch((e) => reply(msg.id, { content: [{ type: "text", text: `error: ${e.message}` }], isError: true }))
          .finally(() => { pending--; maybeExit(); });
      }
      else if (msg.id !== undefined) reply(msg.id, {}); // politely ack anything else with an id
    }
  });
  // Exit when the host closes the pipe — but only after in-flight calls finish.
  process.stdin.on("end", () => { stdinDone = true; setImmediate(maybeExit); });
}
