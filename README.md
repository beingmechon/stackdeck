# Stackdeck

**Your projects folder, as a control panel.**

A browser dashboard for the services you run every day in local development.
Stackdeck scans your projects folder, figures out how to run each repo, and
gives you Start / Kill / restart buttons, live logs, and a **git branch
dropdown** that checks out the branch before launching. Zero dependencies —
one Node process, one HTML page, binds to 127.0.0.1.

*Spiritual successor to [hotel](https://github.com/typicode/hotel)
(unmaintained since 2019), with the git-awareness of
[portree](https://github.com/fairy-pitta/portree) and the multi-project scope
neither has.*

## Quick start

```bash
git clone https://github.com/bharanishraj/stackdeck && cd stackdeck
node bin/stackdeck.js         # starts the daemon, opens http://localhost:8899
```

Or link it onto your PATH:

```bash
npm link                     # then: stackdeck | stackdeck status | stackdeck logs api
```

## What it does

- **Discovers your projects** — scans your project roots (default `~/Projects`),
  detects git repos + current branch, and infers a run command per repo
  (pnpm/npm/yarn scripts, Makefile targets, Python entrypoints with uv
  detection, docker-compose, cargo, go).
- **Services** — a project you've promoted to a runnable recipe: directory +
  command + port + env. Start / Kill / restart from the browser or CLI, live
  ANSI-colored logs (also on disk), status by pid *and* port — services
  started outside Stackdeck show as `external` and can be killed too.
- **Git-aware** — a branch dropdown per service; picking a branch runs
  `git checkout` before start, refused while the tree is dirty. Dirty repos
  are badged.
- **Organize the board** — drag rows between your own sections, per-section
  *start all* / *stop all*, collapse/expand, hide/unhide anything, categorize
  the project list.
- **CLI parity** — `stackdeck status|start|stop|restart|logs <name>` talks to
  the same daemon.
- **Dev tools** — detects databases and brokers installed on your machine
  (PostgreSQL, MySQL/MariaDB, MongoDB, Redis/Valkey, Elasticsearch/OpenSearch,
  RabbitMQ, NATS, MinIO, Temporal, ClickHouse, Mailpit, Memcached) and
  one-click configures them as ordinary foreground services — managed child,
  streamed logs, clean kill. Data directories are resolved from standard
  locations (or self-initialized under `~/.local/share/stackdeck/`); no Docker,
  no launchd/systemd indirection.

## Configuration

Everything lives in one JSON file — `~/.config/stackdeck/config.json`
(or `$STACKDECK_HOME/config.json`); logs sit next to it. Every field is
editable from the UI; the interesting ones:

```jsonc
{
  "port": 8899,
  "projectRoots": ["~/Projects", "~/work"],   // folders to scan
  "categoryOrder": ["Products", "Tools"],     // display order of project categories
  "projectCategories": { "my-repo": "Products" },
  "groups": ["Stack A"],                      // your service sections
  "services": [
    {
      "name": "api",
      "dir": "~/Projects/my-app",
      "command": "pnpm run dev",
      "port": 3001,                            // for status detection
      "env": { "DEBUG": "1" },
      "group": "Stack A"
    }
  ]
}
```

## Security model

The daemon executes shell commands by design, so it defends its HTTP surface:
it binds to 127.0.0.1 only, pins the `Host` header (DNS-rebinding defense),
accepts only `application/json` POSTs (a cross-origin JSON POST forces a CORS
preflight, which is never answered; `text/plain` sneak-POSTs are rejected),
and rejects any browser `Origin` that isn't its own. Service and section
names are validated server-side. Do not port-forward it off your machine.

## Notes that will save you a debugging session

- Services spawn through a **non-login** shell with the PATH of your login
  shell resolved once at daemon start — so nvm/homebrew/uv tools are found
  even when the daemon was launched from a GUI, and profile files can't
  reorder your toolchain per-spawn.
- The HTTP server accepts headers up to 256KB, because browsers hoard
  localhost cookies across every dev app you've ever run, and Node's 16KB
  default silently breaks localhost apps (431s / dropped connections).
- Kill stops the whole process group; stragglers get SIGKILL after 5s.

## macOS app (optional)

```bash
./scripts/macos-app.sh    # builds ~/Applications/Stackdeck.app from this checkout
```

Double-click to start the daemon and open the board. Linux users: `stackdeck`
in a terminal, or add a systemd user unit for `node server.js`.

## Status

Early. Solid daily driver, small codebase (~1 file each side), no tests yet.
Issues and PRs welcome.

## License

MIT
