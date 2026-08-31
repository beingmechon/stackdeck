<img src="logo-wordmark.svg" alt="Stackdeck" height="52">

[![CI](https://github.com/beingmechon/stackdeck/actions/workflows/ci.yml/badge.svg)](https://github.com/beingmechon/stackdeck/actions/workflows/ci.yml)

**Your agent made four worktrees. Something has to run them.**

<img src="https://beingmechon.github.io/stackdeck/demo.gif" alt="Live logs with filtering, then running a second branch of orders-api in a parallel worktree on its own port, then switching the whole board to a light theme" width="100%">

Making the worktree is the easy part. The hour after is the problem: four
branches, four dev servers, ports you didn't choose, and no idea which are up
or what they're printing. Stackdeck starts them, keeps them running, streams
their logs, shows every port on the machine, and hands all of it to your agent
over MCP.

It works on the rest of your projects folder too — scans your roots, works out
how to run each repo across ~15 ecosystems, boards them all. One Node process,
one HTML page, no dependencies, bound to 127.0.0.1, never talks to the internet.

## Install

```bash
npm i -g stackdeck                                                 # npm
brew install beingmechon/tap/stackdeck                             # Homebrew
curl -fsSL https://beingmechon.github.io/stackdeck/install.sh | sh  # no npm needed
```

```bash
stackdeck        # starts the daemon, opens http://localhost:8899
stackdeck tui    # the same board, in your terminal
```

Point it at your projects folder in settings, then press **configure** on any
project. `npx stackdeck` runs it without installing anything.

Node 18.13+, macOS or Linux — [WSL2 included, with caveats](#notes);
Windows-native is out of scope. The curl installer unpacks into `~/.local`
after checking the tarball against the hash npm recorded at publish time
([read it first](docs/install.sh)); undo with `… | sh -s -- --uninstall`.

```
 stackdeck  5 running · 12 stopped
 ─────────────────────────────────────────────────────────────────────
 Shop  2/3 up
  ● api                   :3001   71760   pnpm run dev
    ● ⧉ feature/rate-limits :3002   71874   worktree
  ○ studio                :5173           pnpm run dev
 ─────────────────────────────────────────────────────────────────────
 ↑↓ move  s start  x kill  r restart  ⏎ logs  / filter  p ports  o open  q quit
```

## What it does once the worktree exists

**It runs them, and keeps running them.** Every branch gets its own row, log
stream and `branch.service.localhost` address, so two branches of one API can
be open in two tabs. `restart: on-failure` backs off exponentially. `dependsOn`
starts a stack in order, waiting for each piece to be *ready* — a log regex, an
HTTP check, or its port opening — not merely spawned. *Start on demand* boots a
stopped service when you open `api.localhost` and holds the request until it
answers; *idle stop* shuts it down again, so twenty services cost nothing until
you open one.

**Your agent can drive all of it.** `stackdeck mcp` puts the board on MCP.
Starting returns only once the service is actually serving, so an agent never
guesses with a sleep loop — the one thing every integration otherwise
reimplements. [Setup below](#using-it-from-an-agent).

**Every port on the machine, not just yours.** Which service owns it, the full
command line, its directory and parent, and a two-step kill — how you find the
dev server from three weeks ago squatting `:3000`. In the browser, the TUI
(`p`), and the terminal:

```bash
stackdeck ports 3000     # who has it, since when, and from which directory
stackdeck kill 54211     # only pids holding a port; never root, never sudo
```

<details>
<summary><b>Everything else</b> — the full feature list</summary>

- **Worktrees that don't cost a gigabyte** — a branch symlinks `node_modules`,
  `target`, `.venv` and friends back at your main checkout instead of copying,
  picked from the ecosystems the repo actually is. Never anything git tracks,
  never over something already there; linked names go into `.git/info/exclude`
  so the worktree stays clean. `linkDirs: [...]` overrides, `false` disables.
- **A branch can have its own database** — `isolateDb` copies the dev Postgres
  database per worktree (`CREATE DATABASE … TEMPLATE`) and rewrites the URL, so
  an agent's migration can't corrupt your main checkout's data. Dropped with
  the worktree, and only ever a name Stackdeck recorded creating.
- **Honest status** — running state comes from pid *and* port. Services you
  started elsewhere show as `external`; killing something a supervisor restarts
  says so rather than pretending; killing the daemon leaves your services up
  for a restarted one to re-adopt.
- **Crash handling** — unexpected exits get a badge and a browser notification.
- **Sections you arrange** — drag services (or move by keyboard) into groups,
  with *start all* / *stop all*, collapse and hide.
- ***.localhost domains** — a built-in reverse proxy, WebSockets included.
  Browsers resolve `*.localhost` natively: no /etc/hosts, no PAC file.
- **Port conflicts, handled** — if something holds the port, Start names the
  pid and offers to evict it.
- **Ecosystem detection** — a run command per project across ~15: Makefile and
  just targets, npm/pnpm/yarn/bun, Deno, Python with uv/poetry/pipenv/pdm,
  Django, cargo, go, zig, swift, dotnet, gradle, maven, Rails, Rack, Laravel,
  composer, mix, flutter, stack, and `docker compose` last. A monorepo becomes
  a section of services in one click.
- **Databases without Docker** — Postgres, MySQL, MongoDB, Redis,
  Elasticsearch, RabbitMQ, NATS, MinIO, Temporal, ClickHouse and friends,
  detected on your machine and run as ordinary services with streamed logs.
- **A terminal board too** — `stackdeck tui`: navigate, start, kill, restart,
  filter, stream logs in a split pane, `p` for the port table. Same daemon, so
  the browser stays in sync.
- **CLI** — `stackdeck status|start|stop|restart|logs|ports|kill`.
- **Themes** — calm, playful, austere, or a custom one built from sliders.

Keyboard-operable throughout, WCAG AA contrast, respects reduced motion.
</details>

## Using it from an agent

MCP is an open standard, so this works with any client that speaks it. Point
yours at:

```json
{
  "mcpServers": {
    "stackdeck": { "command": "npx", "args": ["-y", "stackdeck", "mcp"] }
  }
}
```

Most clients read that from a project `.mcp.json` or their own settings file;
several have a CLI shortcut that writes it — check your client's docs. `npx`
needs nothing installed, and `stackdeck mcp` starts the daemon itself.

Eleven tools: `list_services`, `start_service`, `stop_service`,
`restart_service`, `get_logs`, `list_ports`, `whats_on_port`, `kill_pid`,
`list_worktrees`, `start_worktree`, `stop_worktree`.

**Agent instructions.** Tool schemas say what an agent *can* call; they can't
say that `start_service` already waits, so a sleep loop after it is wrong, or
that it must not delete a worktree another agent is working in.
[`skills/stackdeck/SKILL.md`](skills/stackdeck/SKILL.md) says those things. It
is in the `SKILL.md` format some agents load automatically —
`cp -r "$(npm root -g)/stackdeck/skills/stackdeck" <your-skills-dir>/` — and
anything else can read it as plain Markdown.

<details>
<summary>Non-default port or state directory</summary>

```json
{
  "mcpServers": {
    "stackdeck": {
      "command": "npx", "args": ["-y", "stackdeck", "mcp"],
      "env": { "STACKDECK_PORT": "9000", "STACKDECK_HOME": "~/.config/stackdeck" }
    }
  }
}
```
</details>

## It never talks to the internet

No telemetry, analytics, update checks, accounts or CDN. The page loads no
external fonts, scripts or images — icon and logo are inline. The daemon
listens on 127.0.0.1 and the only connections it opens are to loopback ports of
services you configured. It all works on a plane. Check it while it's running:

```bash
lsof -nP -a -p "$(lsof -ti tcp:8899 -sTCP:LISTEN)" -i
# only 127.0.0.1:<port> (LISTEN), plus loopback connections to your services
```

Ask by the port, not by name — `pgrep -f server.js` also matches your editor's
helpers. Without `lsof`: `ss -tnp | grep "pid=$(pgrep -f 'node.*server\.js')"`.

The one exception is a URL you type: `readyWhen: { "http": "…" }` fetches
exactly that address, normally your own `http://localhost:…`.

## Reference

<details>
<summary><b>Configuration</b> — one JSON file, all of it editable from the UI</summary>

`~/.config/stackdeck/config.json` (or `$STACKDECK_HOME/config.json`); logs sit
next to it.

```jsonc
{
  "port": 8899,
  "projectRoots": ["~/Projects", "~/work"],   // folders to scan
  "categoryOrder": ["Products", "Tools"],     // order of project categories
  "groups": ["Stack A"],                      // your service sections
  "theme": "playful",                         // or austere / custom
  // Set from the UI, listed so they are discoverable rather than folklore:
  "excludes": ["~/Projects/scratch"],         // folders the scan skips
  "projectCategories": { "web": "Products" }, // project name -> category
  "hiddenGroups": [], "hiddenCategories": [], // collapsed out of the board
  "themeTokens": { "hue": 75, "radius": 7 },  // only when theme is "custom"
  "services": [
    {
      "name": "api",
      "dir": "~/Projects/my-app",
      "command": "pnpm run dev",
      "port": 3001,                            // status detection + api.localhost
      "env": { "DEBUG": "1" },
      "group": "Stack A",
      "dependsOn": ["db"],                     // started (and ready) first
      "readyWhen": { "log": "Listening on" },  // or { "http": "…" }; default: port opens
      "linkDirs": ["node_modules"],            // symlink into a worktree instead
                                               // of copying; omit to detect,
                                               // false to disable
      "isolateDb": true,                       // worktree gets its own copy of
                                               // the Postgres database
      "envFile": ".env.local",                 // env file to auto-load; false for none
      "hidden": true,                          // keep it off the board
      "restart": "on-failure",                 // exponential backoff, 5 tries
      "onDemand": true,                        // boot when api.localhost is visited
      "idleAfter": 30                          // stop again after 30 idle minutes
    }
  ]
}
```
</details>

<details>
<summary><b>Security model</b> — it runs shell commands, so this matters</summary>

Nothing leaves your machine, but the daemon runs shell commands on it, so the
local surface matters.

**localhost is not a security boundary**, so the API is gated by a per-install
secret (`<state dir>/secret`, mode 0600). The page gets the token by being
served from disk by the daemon; the CLI reads it as the same user. Every
`/api/*` call without it gets a 401 — only `/api/ping` is open. State files are
0600 in a 0700 directory.

Layered on top: binds 127.0.0.1 only, pins the `Host` header (DNS-rebinding
defence), accepts only `application/json` POSTs (a cross-origin JSON POST
forces a preflight that is never answered; `text/plain` sneak-POSTs are
rejected), rejects foreign `Origin` headers, validates names, ports, dirs and
env server-side, caps bodies at 1MB, limits the folder browser to your home and
configured roots. Config writes are atomic; a corrupt config is set aside,
never fatal. Branch names reach `git` after `--end-of-options`, so one shaped
like a flag cannot become one. **Do not port-forward the daemon off your
machine.**

**Known limitation, stated plainly:** the token is substituted into the HTML
when the daemon serves the page, so it is in the DOM. Any browser extension
with host access to localhost can read it, and would then have the same API
access you do. The alternatives — an httpOnly cookie, or a second fetch —
each trade this for a different problem on a tool serving one page to one user,
so this is accepted rather than solved.

The `*.localhost` proxy is unauthenticated by design — your browser needs it —
and forwards only to ports of services you configured. That makes those
reachable at guessable names from any site you visit (same-origin still blocks
reading responses), roughly the exposure a guessable port already had. It is
also why *start on demand* is opt-in: with it on, any page you visit could
start that service.
</details>

<details>
<summary><b id="notes">Notes that will save you a debugging session</b></summary>

- Services spawn through a **non-login** shell using the PATH of your login
  shell, resolved once at daemon start — so nvm/homebrew/uv tools are found
  even when the daemon was launched from the GUI.
- **A service that logs "Ready" but shows "this page isn't working"** is almost
  always the localhost cookie jar: browsers hoard cookies for `localhost`
  across every dev app you've run, and Node's 16KB header limit rejects the
  request before your code sees it (`curl` succeeds because it sends none). Set
  `{"NODE_OPTIONS": "--max-http-header-size=131072"}` in the service's env, or
  clear cookies for localhost.
- **`$PORT` is a request, not a guarantee.** Vite reads `vite.config`, Next
  reads `-p`. If a worktree instance ignores the injected port, the board tells
  you where it actually bound. Make it obey with `--port ${PORT:-5173}` (Vite)
  or `-p ${PORT:-3000}` (Next).
- Kill stops the whole process group; stragglers get SIGKILL after 5s.
- **Unix only** (bash, process groups, lsof/ss). The `.env` loader is
  deliberately minimal: flat `KEY=value`, quotes and `#` comments, no
  interpolation, no multiline values.
- **WSL2**: expected to work, not yet confirmed by anyone running it. WSL2 is
  Linux and every path needing a macOS tool already falls back — `lsof` and
  `netstat` are usually absent there, `ss` covers both. WSL forwards 127.0.0.1
  binds to Windows, so the board should be at `localhost:8899` in your Windows
  browser. Two caveats: `stackdeck` opens the browser via `wslview` or
  `explorer.exe` and prints the URL if neither exists, and **`*.localhost`
  proxying is untested under WSL2** — binding `:80` needs root inside the
  distro, so it falls back to `:8880`. Reports welcome either way.
- **macOS app**: `./scripts/macos-app.sh` builds `~/Applications/Stackdeck.app`.
  Linux: run `stackdeck`, or add a systemd user unit for `node server.js`.
</details>

## Debugging

Stackdeck swallows a lot of errors on purpose — a missing `.env`, an `lsof`
that isn't installed, a pid that died between two lines. `STACKDECK_DEBUG=1`
prints every one with the operation that swallowed it:

```bash
STACKDECK_DEBUG=1 stackdeck daemon
# [stackdeck:which:postgres] Command failed: bash -c command -v postgres
# [stackdeck:parseEnvFile:/home/you/api/.env] ENOENT: no such file or directory
```

Same behaviour, same exit codes, just louder. **Put this in any bug report** —
it is the most useful thing for working out what happened on a machine that
isn't mine.

## How this relates to other tools

Creating an isolated worktree is table stakes now. [workz][workz] does it as a
Rust CLI: symlinks `node_modules`, copies your `.env`, installs dependencies,
and with `--isolated` hands out unique ports, database names and a
`COMPOSE_PROJECT_NAME`. Then it exits, which is right for a setup tool.
Conductor, Claude Squad and Agent Deck work the same problem from other angles;
check each for yourself rather than taking my summary of it.

Stackdeck is the half after setup: it starts what is in the worktree,
supervises it, restarts it when it crashes, streams its logs, says which ports
are taken machine-wide, and exposes that to an agent over MCP. A different job,
not a better one.

**They compose.** Stackdeck finds worktrees through `git worktree list`, so it
adopts whatever created them, wherever they are. Provision with
`workz --isolated`, run the result with Stackdeck; neither needs to know the
other exists. Its heavy-directory symlinking overlaps with what workz does — if
workz got there first, Stackdeck leaves what it finds alone.

Further back, a spiritual successor to
[hotel](https://github.com/typicode/hotel), which did the `*.localhost` proxy
well and has been unmaintained since 2019. Also nearby: Foreman and Overmind
(one Procfile, no UI), Docker Compose (containers, not your host), Laravel Herd
and DBngin (excellent, macOS and PHP-shaped).

[workz]: https://github.com/rohansx/workz

## Status

Early — ten days old, one maintainer, version numbers moving fast. A solid
daily driver, but treat the shape as still settling before 1.0.

`server.js` and `index.html` are two files you can read in an evening, which is
the point for something that runs shell commands. The parsers and detectors
have a test suite ([`test/`](test/)) running on Ubuntu and macOS across Node
18, 20 and 22; the UI and the process-management path do not, and get exercised
by use. See [CONTRIBUTING.md](CONTRIBUTING.md) and
[CHANGELOG.md](CHANGELOG.md).

## License

MIT
