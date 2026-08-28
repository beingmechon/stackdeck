/* Terminal board. Same daemon, same API as the browser page — this is for the
   half of the day you never leave the terminal.

   No dependencies: raw ANSI out, raw stdin in. The whole frame is composed as
   one string and written in a single syscall, so it never tears; the alternate
   screen buffer means your scrollback is exactly where you left it on quit. */

const ESC = "\x1b[";
const alt = (on) => ESC + (on ? "?1049h" : "?1049l");
const cursor = (on) => ESC + (on ? "?25h" : "?25l");
const home = ESC + "H";
const clearLine = ESC + "K";
const clearDown = ESC + "J";

// 256-colour codes, tuned to the board's warm charcoal palette.
const C = {
  dim: (s) => `${ESC}38;5;245m${s}${ESC}0m`,
  faint: (s) => `${ESC}38;5;240m${s}${ESC}0m`,
  text: (s) => `${ESC}38;5;253m${s}${ESC}0m`,
  accent: (s) => `${ESC}38;5;179m${s}${ESC}0m`,
  green: (s) => `${ESC}38;5;114m${s}${ESC}0m`,
  red: (s) => `${ESC}38;5;174m${s}${ESC}0m`,
  bold: (s) => `${ESC}1m${s}${ESC}0m`,
  sel: (s) => `${ESC}48;5;238m${s}${ESC}0m`,
};
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const pad = (s, n) => {
  const w = strip(s).length;
  return w >= n ? s : s + " ".repeat(n - w);
};
const cut = (s, n) => {
  if (strip(s).length <= n) return s;
  let out = "", w = 0, i = 0;
  while (i < s.length && w < n - 1) {
    if (s[i] === "\x1b") { const m = s.slice(i).match(/^\x1b\[[0-9;]*m/); if (m) { out += m[0]; i += m[0].length; continue; } }
    out += s[i++]; w++;
  }
  return out + "…" + ESC + "0m";
};

module.exports = function runTui({ BASE, authHeaders, token }) {
  const out = process.stdout;
  if (!out.isTTY) { console.error("stackdeck tui needs a terminal"); process.exit(1); }
  // Terminals get screen-shared as readily as browsers: never print $HOME.
  const HOME = require("os").homedir();
  const tilde = (s) => String(s || "").split(HOME).join("~");

  let services = [], instances = [], groups = [], hiddenGroups = [];
  let rows = [];                 // flattened, navigable: {kind, ...}
  let sel = 0, scroll = 0;
  let logFor = null, logLines = [], logStream = null;
  let status = "", statusAt = 0, filter = null, filtering = false, dead = false;

  const say = (m) => { status = m; statusAt = Date.now(); render(); };

  /* ---------- data ---------- */
  async function api(p, body) {
    const headers = { ...authHeaders() };
    if (body) headers["Content-Type"] = "application/json";
    const r = await fetch(BASE + p, body ? { method: "POST", headers, body: JSON.stringify(body) } : { headers });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  }
  async function refresh() {
    try {
      const d = await api("/api/services");
      services = d.services || []; instances = d.instances || [];
      groups = d.groups || []; hiddenGroups = d.hiddenGroups || [];
      build();
      render();
    } catch (e) { if (!dead) say(C.red("daemon unreachable: " + e.message)); }
  }
  function build() {
    const q = (filter || "").toLowerCase();
    const match = (s) => !q || s.name.toLowerCase().includes(q) || (s.command || "").toLowerCase().includes(q);
    const prev = rows[sel];
    rows = [];
    for (const g of (groups.length ? [...groups, null] : [null])) {
      if (g !== null && hiddenGroups.includes(g)) continue;
      const mine = services.filter((s) => (s.group || null) === g && !s.hidden && match(s));
      if (!mine.length) continue;
      const up = mine.filter((s) => s.running).length;
      rows.push({ kind: "head", label: g || "Ungrouped", up, total: mine.length });
      for (const s of mine) {
        rows.push({ kind: "svc", s });
        for (const i of instances.filter((i) => i.svc === s.name)) rows.push({ kind: "inst", i });
      }
    }
    // keep the cursor on the same thing across refreshes where possible
    if (prev) {
      const id = prev.kind === "svc" ? prev.s.name : prev.kind === "inst" ? prev.i.key : null;
      if (id) {
        const at = rows.findIndex((r) => (r.kind === "svc" && r.s.name === id) || (r.kind === "inst" && r.i.key === id));
        if (at >= 0) sel = at;
      }
    }
    if (sel >= rows.length) sel = rows.length - 1;
    if (sel < 0) sel = 0;
    if (rows[sel] && rows[sel].kind === "head") move(1);
  }

  /* ---------- logs ---------- */
  async function openLogs(name) {
    closeLogs();
    logFor = name; logLines = [];
    render();
    // AbortController, not stream.cancel(): async iteration holds a reader
    // lock, so cancelling mid-iteration rejects. Aborting tears the request
    // down cleanly and simply ends the loop below.
    const ac = new AbortController();
    logStream = ac;
    try {
      const res = await fetch(`${BASE}/api/logs?name=${encodeURIComponent(name)}&t=${token()}`,
        { headers: authHeaders(), signal: ac.signal });
      if (!res.ok) { say(C.red("logs: " + res.statusText)); logFor = null; return; }
      // fetch() yields Uint8Array, NOT Buffer: .toString() on it returns
      // "58,99,111,…", so decode explicitly. Decoder is stateful across
      // chunks, which also keeps multi-byte characters intact at boundaries.
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body) {
        if (logFor !== name) break;
        buf += dec.decode(chunk, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const l of lines) {
          if (!l.startsWith("data: ")) continue;
          try { logLines.push(JSON.parse(l.slice(6))); } catch {}
        }
        if (logLines.length > 500) logLines.splice(0, logLines.length - 500);
        render();
      }
    } catch { /* stream ended */ }
  }
  function closeLogs() {
    if (logStream) { try { logStream.abort(); } catch {} logStream = null; }
    logFor = null; logLines = [];
  }

  /* ---------- render ---------- */
  function move(d) {
    if (!rows.length) return;
    let i = sel;
    for (let n = 0; n < rows.length; n++) {
      i = (i + d + rows.length) % rows.length;
      if (rows[i].kind !== "head") { sel = i; return; }
    }
  }
  function render() {
    if (dead) return;
    const W = out.columns || 100, H = out.rows || 30;
    const logH = logFor ? Math.max(6, Math.min(14, Math.floor(H / 2) - 2)) : 0;
    const listH = H - 4 - (logH ? logH + 1 : 0);
    if (sel < scroll) scroll = sel;
    if (sel >= scroll + listH) scroll = sel - listH + 1;
    if (scroll < 0) scroll = 0;

    const up = services.filter((s) => s.running).length;
    const L = [];
    L.push(" " + C.bold("stack") + C.accent("deck") + "  " +
      C.dim(`${up} running · ${services.length - up} stopped`) +
      (filter ? "  " + C.accent(`/${filter}`) : "") +
      (instances.length ? C.dim(`  · ${instances.length} worktree`) : ""));
    L.push(C.faint(" " + "─".repeat(Math.max(0, W - 2))));

    const view = rows.slice(scroll, scroll + listH);
    for (let n = 0; n < listH; n++) {
      const r = view[n];
      if (!r) { L.push(""); continue; }
      const on = rows.indexOf(r) === sel;
      let line;
      if (r.kind === "head") {
        line = " " + C.dim(C.bold(r.label)) + C.faint(`  ${r.up}/${r.total} up`);
      } else if (r.kind === "svc") {
        const s = r.s;
        const dot = s.running ? C.green("●") : C.faint("○");
        const badge = s.running && !s.managed ? C.accent("ext ") : s.restartPending ? C.accent("restarting ") :
          (!s.running && s.lastExit && !s.lastExit.expected && s.lastExit.code) ? C.red("crashed ") : "";
        line = `  ${dot} ${pad(cut(C.text(s.name), 21), 22)}${pad(C.dim(":" + (s.port ?? "—")), 8)}` +
               `${pad(C.faint(String(s.pid ?? "")), 8)}${badge}${C.faint(tilde(s.command || ""))}`;
      } else {
        const i = r.i;
        line = `    ${C.green("●")} ${pad(cut(C.dim("⧉ " + i.branch), 25), 26)}${pad(C.dim(":" + (i.port ?? "—")), 8)}` +
               `${pad(C.faint(String(i.pid ?? "")), 8)}${i.externalWorktree ? C.faint("existing worktree") : C.faint("worktree")}`;
      }
      L.push(on ? C.sel(pad(cut(line, W - 1), W - 1)) : cut(line, W - 1));
    }

    if (logFor) {
      L.push(C.faint(" ─── ") + C.accent("logs: " + logFor) + C.faint(" " + "─".repeat(Math.max(0, W - 12 - logFor.length))));
      const tail = logLines.slice(-logH);
      for (let n = 0; n < logH; n++) {
        const l = tail[n];
        L.push(l === undefined ? "" : " " + C.dim(cut(tilde(l.replace(/\x1b\[[0-9;]*m/g, "")), W - 2)));
      }
    }

    L.push(C.faint(" " + "─".repeat(Math.max(0, W - 2))));
    const fresh = Date.now() - statusAt < 4000 ? status : "";
    L.push(" " + (fresh || C.faint(
      filtering ? "type to filter · enter accept · esc clear"
      : filter ? "↑↓ move  s start  x kill  r restart  ⏎ logs  esc clear filter  q quit"
      : "↑↓ move  s start  x kill  r restart  ⏎ logs  / filter  o open  q quit")));

    out.write(home + L.map((l) => l + clearLine).join("\n") + clearDown);
  }

  /* ---------- actions ---------- */
  const current = () => rows[sel];
  async function act(kind) {
    const r = current();
    if (!r) return;
    if (r.kind === "inst") {
      if (kind !== "stop") return say(C.faint("worktree instances only take x (kill)"));
      say(`killing ${r.i.key}…`);
      try { await api("/api/worktree/stop", { key: r.i.key }); say(`${r.i.key} killed`); }
      catch (e) { say(C.red(e.message)); }
      return refresh();
    }
    const s = r.s;
    say(`${kind === "start" ? "starting" : kind === "stop" ? "killing" : "restarting"} ${s.name}…`);
    try {
      const res = await api(`/api/${kind}`, { name: s.name });
      say(res.note ? C.accent(res.note) : `${s.name} ${kind === "start" ? "started" : kind === "stop" ? "killed" : "restarted"}`);
    } catch (e) { say(C.red(e.message)); }
    refresh();
  }

  /* ---------- input ---------- */
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (k) => {
    if (filtering) { // typing a filter
      if (k === "\r" || k === "\n") { filtering = false; filter = filter || null; build(); return render(); }
      if (k === "\x1b") { filtering = false; filter = null; build(); return render(); }
      if (k === "\x7f") { filter = filter.slice(0, -1); build(); return render(); }
      if (k === "\x03") return quit();
      if (k >= " " && k <= "~") { filter += k; build(); return render(); }
      return;
    }
    switch (k) {
      case "q": case "\x03": return quit();
      case "j": case ESC + "B": move(1); return render();
      case "k": case ESC + "A": move(-1); return render();
      case "g": sel = 0; move(1); return render();
      case "G": sel = rows.length - 1; move(-1); move(1); return render();
      case "s": return act("start");
      case "x": return act("stop");
      case "r": return act("restart");
      case "/": filtering = true; filter = ""; return render();
      case "o": {
        const { spawn } = require("child_process");
        const opener = process.platform === "darwin" ? "open" : "xdg-open";
        try { spawn(opener, [BASE], { detached: true, stdio: "ignore" }).unref(); say("opened the board in your browser"); } catch {}
        return;
      }
      case "\r": case "\n": {
        const r = current();
        if (!r) return;
        const name = r.kind === "inst" ? r.i.key : r.s.name;
        if (logFor === name) { closeLogs(); return render(); }
        return openLogs(name);
      }
      case "\x1b": if (logFor) { closeLogs(); render(); } return;
    }
  });
  out.on("resize", render);

  function quit() {
    dead = true;
    closeLogs();
    try { process.stdin.setRawMode(false); } catch {}
    out.write(cursor(true) + alt(false));
    process.exit(0);
  }
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, quit);
  // Never leave the terminal wedged in the alternate screen, whatever happens.
  const bail = (e) => {
    dead = true;
    try { process.stdin.setRawMode(false); } catch {}
    out.write(cursor(true) + alt(false));
    console.error(e);
    process.exit(1);
  };
  process.on("uncaughtException", bail);
  process.on("unhandledRejection", bail);

  out.write(alt(true) + cursor(false) + home + clearDown);
  refresh();
  const timer = setInterval(refresh, 2000);
  timer.unref();
};
