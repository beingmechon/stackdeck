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
 */
"use strict";
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, execFileSync } = require("child_process");

const SERVER = path.join(__dirname, "..", "server.js");
const PORT = Number(process.env.STACKDECK_PORT || 8899);
const BASE = `http://127.0.0.1:${PORT}`;

// The API requires the per-install secret; same-user processes read it from disk.
function stateHome() {
  if (process.env.STACKDECK_HOME)
    return process.env.STACKDECK_HOME.replace(/^~(?=\/|$)/, os.homedir());
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdg, "stackdeck");
}
const token = () => { try { return fs.readFileSync(path.join(stateHome(), "secret"), "utf8").trim(); } catch { return ""; } };
const authHeaders = () => ({ "X-Stackdeck-Token": token() });

async function up() {
  try { const r = await fetch(`${BASE}/api/meta`); return r.ok; } catch { return false; }
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
    const d = await (await fetch(`${BASE}/api/services`, { headers: authHeaders() })).json();
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
  console.error("unknown command:", cmd);
  process.exit(1);
})();
