<img src="logo-wordmark.svg" alt="Stackdeck" height="52">

[![CI](https://github.com/beingmechon/stackdeck/actions/workflows/ci.yml/badge.svg)](https://github.com/beingmechon/stackdeck/actions/workflows/ci.yml)

**Your agent made four worktrees. Something has to run them.**

<img src="https://beingmechon.github.io/stackdeck/demo.gif" alt="Live logs with filtering, then running a second branch of orders-api in a parallel worktree on its own port, then switching the whole board to a light theme" width="100%">

Making the worktree is the easy part, and by now several tools do it well. The
part nobody covers is the hour after: four branches, four dev servers, ports
you didn't choose, and no idea which are up or what they're printing. Stackdeck
starts them, keeps them running, streams their logs, tells you every port on
the machine, and hands all of it to your agent over MCP.

It works on the rest of your projects folder too — it scans your roots, works
out how to run each repo across ~15 ecosystems, and puts them on one board with
Start, Kill and live logs. One Node process, one HTML page, no dependencies,
bound to 127.0.0.1, and it never talks to the internet.

## Install

```bash
npm i -g stackdeck                                                 # npm
brew install beingmechon/tap/stackdeck                             # Homebrew
curl -fsSL https://beingmechon.github.io/stackdeck/install.sh | sh  # no npm needed
```

Node 18.13+, macOS or Linux — including **WSL2**, which is expected to work
but has not been confirmed by anyone running it (`*.localhost` proxying there
is untested; [details below](#notes)). Windows-native is out of scope.

The curl installer unpacks into `~/.local` after checking the tarball against
the hash npm recorded at publish time; read it first at
[docs/install.sh](docs/install.sh), or undo it with
`curl -fsSL <same url> | sh -s -- --uninstall`.

```bash
stackdeck        # starts the daemon, opens http://localhost:8899
stackdeck tui    # the same board, in your terminal
```

Point it at your projects folder in settings, then press **configure** on any
project to put it on the board.

Just looking? `npx stackdeck` runs it without installing anything, and leaves
no `stackdeck` command on your PATH afterwards.

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

**It runs them, and keeps running them.** Every branch gets its own row, its
own log stream and its own `branch.service.localhost` address, so two branches
of one API can be open in two tabs. `restart: on-failure` backs off
exponentially; `dependsOn` starts a stack in order and waits for each piece to
be *ready* rather than merely spawned. Turn on *start on demand* and opening
`api.localhost` boots a stopped service and holds the request until it answers;
*idle stop* shuts it down again, so twenty configured services cost nothing
until you open one.

**Your agent can drive all of it.** `stackdeck mcp` exposes the board over MCP:
list and start and stop services, run a branch in a worktree, read logs, see
what is holding a port. `start_service` and `start_worktree` return only once
the thing is actually serving, so an agent never has to guess with a sleep
loop — the single most common thing every integration reimplements.

**Every port on the machine, not just yours.** The Ports panel lists
everything listening — which service owns it, the full command line, its
directory and parent, and a two-step kill. It is how you find the dev server
from three weeks ago squatting `:3000`. In the browser, in the TUI (`p`), and
in the terminal:

```bash
stackdeck ports 3000     # who has it, since when, and from which directory
stackdeck kill 54211     # only pids holding a port; never root, never sudo
```

## Using it from an agent

The board is also an MCP server, so a coding agent can start services, read
their logs and see what is holding a port — instead of running `npm run dev &`
and losing the output. MCP is an open standard; this works with any client
that speaks it.

Point your client at:

```json
{
  "mcpServers": {
    "stackdeck": { "command": "npx", "args": ["-y", "stackdeck", "mcp"] }
  }
}
```

Most clients read that from a project-level `.mcp.json` or from their own
settings file, and several have a CLI shortcut that writes it for you — check
your client's docs for where it wants to be told.

`npx` needs nothing installed globally, and `stackdeck mcp` starts the daemon
itself if it isn't already up. On a non-default port or state directory, pass
them through:

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

Eleven tools: `list_services`, `start_service`, `stop_service`,
`restart_service`, `get_logs`, `list_ports`, `whats_on_port`, `kill_pid`,
`list_worktrees`, `start_worktree`, `stop_worktree`.

**Agent instructions.** Tool schemas say what an agent *can* call; they can't
say that `start_service` already waits for the service to be serving, so a
sleep loop after it is wrong, or that it must not delete a worktree another
agent is working in. [`skills/stackdeck/SKILL.md`](skills/stackdeck/SKILL.md)
says those things.

It is written in the `SKILL.md` format — YAML frontmatter, then prose — which
some agents load automatically from a skills directory:

```bash
cp -r "$(npm root -g)/stackdeck/skills/stackdeck" <your-agent-skills-dir>/
```

Anything else can read it as a plain Markdown file: paste it into your agent's
instructions, or point the agent at the path.

## It never talks to the internet

No telemetry, no analytics, no update checks, no accounts, no CDN. The page
loads no external fonts, scripts, or images — the icon and logo are inline.
The daemon listens on 127.0.0.1 and the only connections it opens are to
loopback ports of services you configured. Nothing you do here leaves the
machine, and it all works on a plane.

Verify it yourself in one command while it's running:

```bash
lsof -nP -a -p "$(lsof -ti tcp:8899 -sTCP:LISTEN)" -i
# only 127.0.0.1:<port> (LISTEN), plus loopback connections to your services
```

(Ask it by the port it listens on, not by name — `pgrep -f server.js` also
matches your editor's helper processes. On a distro without `lsof`, the same
answer comes from `ss -tnp | grep "pid=$(pgrep -f 'node.*server\.js')"`.)

The single exception is a URL you type: `readyWhen: { "http": "…" }` fetches
exactly that address to decide when a service is ready. Point it at your own
service (it normally is `http://localhost:…`) and there is nothing else.

## Everything else

- **Sections you arrange** — drag services (or move them by keyboard) into
  your own groups, with *start all* / *stop all*, collapse, and hide.
- **Stacks that start in order** — `dependsOn` waits for each dependency to be
  *ready*: a log-line regex, an HTTP check, or its port opening.
- **Honest status** — running state comes from pid *and* port. Services you
  started elsewhere show as `external`, killing something a supervisor
  restarts says so rather than pretending, and killing the daemon leaves your
  services running for a restarted one to re-adopt.
- **Crash handling** — `restart: on-failure` backs off exponentially; unexpected
  exits get a badge and a browser notification.
- ***.localhost domains** — a built-in reverse proxy, WebSockets included.
  Browsers resolve `*.localhost` natively: no /etc/hosts, no PAC file.
- **Worktrees that don't cost a gigabyte** — a branch running in its own
  worktree symlinks `node_modules`, `target`, `.venv` and friends back at your
  main checkout rather than copying them, picked from the ecosystems the repo
  actually is. Never anything git tracks, never over something already there,
  and the linked names go into `.git/info/exclude` so the worktree stays clean.
  Override with `linkDirs: [...]`, or turn it off with `linkDirs: false`.
- **Port conflicts, handled** — if something else holds the port, Start names
  the pid and offers to evict it.
- **Ecosystem detection** — a run command inferred per project across ~15 of
  them: Makefile and just targets, npm/pnpm/yarn/bun, Deno, Python with
  uv/poetry/pipenv/pdm, Django, cargo, go, zig, swift, dotnet, gradle, maven,
  Rails, Rack, Laravel, composer, mix, flutter, stack, and `docker compose`
  last. A monorepo becomes a section of services in one click.
- **Databases without Docker** — Postgres, MySQL, MongoDB, Redis,
  Elasticsearch, RabbitMQ, NATS, MinIO, Temporal, ClickHouse and friends,
  detected on your machine and run as ordinary services with streamed logs.
- **A terminal board too** — `stackdeck tui`: navigate, start, kill, restart,
  filter, stream logs in a split pane, plus `p` for the same port table. Same
  daemon, so the browser stays in sync.
- **CLI and MCP** — `stackdeck status|start|stop|restart|logs|ports|kill`, plus
  `stackdeck mcp` so coding agents can drive your dev environment themselves.
  `whats_on_port` stops an agent retrying a start that can never bind, and
  `list_worktrees` / `start_worktree` / `stop_worktree` let it run the branch
  it just made — including a worktree it created itself, anywhere on disk.
  Both start tools wait until the service is actually serving before they
  return, so an agent never has to guess with a sleep loop.
- **Themes** — calm, playful, austere, or a custom one built from a few
  sliders (a full light theme is one drag).

Keyboard-operable throughout, WCAG AA contrast, respects reduced motion.

<details>
<summary><b>Configuration</b> — one JSON file, all of it editable from the UI</summary>

Everything lives in `~/.config/stackdeck/config.json` (or
`$STACKDECK_HOME/config.json`); logs sit next to it.

```jsonc
{
  "port": 8899,
  "projectRoots": ["~/Projects", "~/work"],   // folders to scan
  "categoryOrder": ["Products", "Tools"],     // order of project categories
  "groups": ["Stack A"],                      // your service sections
  "theme": "playful",                         // or austere / custom
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
      "linkDirs": ["node_modules"],            // symlink these into a worktree
                                               // instead of copying; [] or omit
                                               // to detect, false to disable
      "restart": "on-failure",                 // exponential backoff, 5 tries
      "onDemand": true,                        // boot it when api.localhost is visited
      "idleAfter": 30                          // stop it again after 30 idle minutes
    }
  ]
}
```
</details>

<details>
<summary><b>Security model</b> — it runs shell commands, so this matters</summary>

Nothing leaves your machine (see [above](#it-never-talks-to-the-internet)) —
but the daemon runs shell commands on it, so the local surface matters.

**localhost is not a security boundary**, so the API is gated by a per-install
secret (`<state dir>/secret`, mode 0600). The page gets the token by being
served from disk by the daemon; the CLI reads it as the same user. Every
`/api/*` call without it gets a 401 — only `/api/ping` is open. State files
are 0600 in a 0700 directory.

Layered on top: binds 127.0.0.1 only, pins the `Host` header (DNS-rebinding
defense), accepts only `application/json` POSTs (a cross-origin JSON POST
forces a preflight that is never answered; `text/plain` sneak-POSTs are
rejected), rejects foreign `Origin` headers, validates names, ports, dirs and
env server-side, caps bodies at 1MB, and limits the folder browser to your
home and configured roots. Config writes are atomic; a corrupt config is set
aside, never fatal. **Do not port-forward the daemon off your machine.**

**Known limitation, stated plainly:** the token is substituted into the HTML
when the daemon serves the page, so it is present in the DOM. Any browser
extension with host access to localhost can read it, and would then have the
same access to the API that you do. The alternatives — an httpOnly cookie, or
a second fetch to collect the token — each trade this for a different problem
on a tool that only ever serves one page to one user, so this one is accepted
rather than solved. If you run extensions you do not trust, that is worth
knowing before you run this.

The `*.localhost` proxy is unauthenticated by design — your browser needs it —
and forwards only to ports of services you configured. It does make those
reachable at guessable names from any site you visit (same-origin still blocks
reading responses), which is roughly the exposure a guessable port already had.
That is also why *start on demand* is opt-in per service: with it on, any page
you visit could start that service.
</details>

<details>
<summary><b id="notes">Notes that will save you a debugging session</b></summary>

- Services spawn through a **non-login** shell using the PATH of your login
  shell, resolved once at daemon start — so nvm/homebrew/uv tools are found
  even when the daemon was launched from the GUI.
- **A service that logs "Ready" but shows "this page isn't working"** is
  almost always the localhost cookie jar: browsers hoard cookies for
  `localhost` across every dev app you've run, and Node's 16KB header limit
  rejects the request before your code sees it (`curl` succeeds because it
  sends no cookies). Set `{"NODE_OPTIONS": "--max-http-header-size=131072"}`
  in the service's env, or clear cookies for localhost.
- **`$PORT` is a request, not a guarantee.** Vite reads `vite.config`, Next
  reads `-p`. If a worktree instance ignores the port Stackdeck injects, the
  board tells you where it actually bound. Make it obey with
  `--port ${PORT:-5173}` (Vite) or `-p ${PORT:-3000}` (Next) in the command.
- Kill stops the whole process group; stragglers get SIGKILL after 5s.
- **Unix only** (bash, process groups, lsof/ss). The `.env` loader is
  deliberately minimal: flat `KEY=value`, quotes and `#` comments, no
  interpolation.
- **WSL2**: expected to work, not yet confirmed by anyone running it. WSL2 is
  Linux, and every path that depends on a macOS tool already falls back —
  `lsof` and `netstat` are usually absent there, and `ss` covers both. WSL
  forwards 127.0.0.1 binds to Windows, so the board should be at
  `localhost:8899` in your Windows browser. Two caveats: `stackdeck` opens
  the browser through `wslview` or `explorer.exe` and prints the URL if
  neither is there, and **`*.localhost` proxying is untested under WSL2** —
  binding `:80` needs root inside the distro, so it falls back to `:8880` and
  you would need `api.localhost:8880`. Reports welcome either way.
</details>

<details>
<summary><b>macOS app</b> — optional double-click launcher</summary>

```bash
./scripts/macos-app.sh    # builds ~/Applications/Stackdeck.app from this checkout
```

Linux: run `stackdeck`, or add a systemd user unit for `node server.js`.
</details>

## How this relates to other tools

Creating an isolated worktree is table stakes now. [workz][workz] does it as a
Rust CLI: symlinks `node_modules`, copies your `.env`, installs dependencies,
and with `--isolated` hands out unique ports, database names and a
`COMPOSE_PROJECT_NAME`. Then it exits, which is exactly right for a setup tool.
Conductor, Claude Squad and Agent Deck are working the same problem from other
angles; check each for yourself rather than taking my summary of it.

Stackdeck is the half that comes after setup. It starts what is in the
worktree, supervises it, restarts it when it crashes, streams its logs, says
which ports are taken across the whole machine, and exposes all of that to an
agent over MCP. Where those tools hand you a provisioned directory, Stackdeck
is what keeps watching it — a different job, not a better one.

**They compose.** Stackdeck finds worktrees through `git worktree list`, so it
adopts whatever created them, wherever they are — nested in the repo, a sibling
directory, a central cache. Provision with `workz --isolated`, run the result
with Stackdeck, and neither tool needs to know the other exists. Stackdeck also
symlinks heavy directories when it creates a worktree itself, which overlaps
with what workz does; if workz got there first, Stackdeck leaves what it finds
alone.

Further back, this is a spiritual successor to
[hotel](https://github.com/typicode/hotel), which did the `*.localhost` proxy
and the start-things-for-me part well and has been unmaintained since 2019.
Also in the neighbourhood: Foreman and Overmind (one Procfile, no UI), Docker
Compose (containers, not your host), and Laravel Herd or DBngin (excellent,
macOS and PHP-shaped).

[workz]: https://github.com/rohansx/workz

## Debugging

Stackdeck swallows a lot of errors on purpose — a missing `.env`, an `lsof`
that isn't installed, a pid that died between two lines. Any of those killing
the board would be worse than the board carrying on without them. The cost is
that when something doesn't work, nothing says why.

Set `STACKDECK_DEBUG=1` and every swallowed error prints with the name of the
operation that swallowed it:

```bash
STACKDECK_DEBUG=1 stackdeck daemon
```

```
[stackdeck:which:postgres] Command failed: bash -c command -v postgres
[stackdeck:parseEnvFile:/home/you/api/.env] ENOENT: no such file or directory
```

It changes nothing else — same behaviour, same exit codes, just louder. **Put
this output in any bug report**; it is the single most useful thing for
working out what happened on a machine that isn't mine.

## Status

Early — ten days old, one maintainer, and the version numbers move fast. It
is a solid daily driver and I use it every day, but treat the shape of things
as still settling before 1.0.

What that means concretely: `server.js` and `index.html` are two files you can
read in an evening, which is the point for something that runs shell commands.
The parsers and detectors have a test suite ([`test/`](test/)) that runs on
Ubuntu and macOS across Node 18, 20 and 22; the UI does not, and neither does
the process-management path — those get exercised by using it. Issues and PRs
welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) first, and
[CHANGELOG.md](CHANGELOG.md) for what changed.

## License

MIT
