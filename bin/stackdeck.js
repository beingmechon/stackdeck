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
 *   stackdeck mcp            run an MCP server over stdio (for AI agents)
 */
"use strict";
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, execFileSync } = require("child_process");

const SERVER = path.join(__dirname, "..", "server.js");

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
  const child = spawn(process.execPath, [SERVER], { detached: true, stdio: "ignore" });
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

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  try { execFileSync(cmd, [url], { stdio: "ignore" }); } catch { console.log(url); }
}

(async () => {
  const [cmd, name] = process.argv.slice(2);

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
  if (cmd === "logs") {
    if (!name) { console.error("usage: stackdeck logs <service>"); process.exit(1); }
    await ensureDaemon();
    const res = await fetch(`${BASE}/api/logs?name=${encodeURIComponent(name)}`, { headers: authHeaders() });
    if (!res.ok) { console.error("error:", (await res.json()).error); process.exit(1); }
    let buf = "";
    for await (const chunk of res.body) {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop(); // keep any partial SSE frame for the next chunk
      for (const line of lines)
        if (line.startsWith("data: ")) { try { console.log(JSON.parse(line.slice(6))); } catch {} }
    }
    return;
  }
  if (cmd === "mcp") {
    await ensureDaemon();
    runMcp();
    return;
  }
  console.error("unknown command:", cmd);
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
          serverInfo: { name: "stackdeck", version: "0.3.0" } });
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
