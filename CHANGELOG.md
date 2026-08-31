# Changelog

Notable changes, newest first. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html), with the pre-1.0
caveat that minor versions carry the breaking changes.

Reconstructed from git history, so entries before this file existed describe
what shipped rather than what was written down at the time.

## [Unreleased]

Nothing yet.

## [0.10.1] — 2026-08-31

### Added
- A test suite (`npm test`) covering the `.env` parser, all six port-table
  parsers, ecosystem detection, name hygiene and branch reading. Node's
  builtin test runner only — still zero dependencies.
- CI on every push and pull request: the suite on Ubuntu and macOS across
  Node 18, 20 and 22, plus a smoke job that installs the real npm tarball and
  checks each security gate over HTTP.
- `STACKDECK_DEBUG=1` prints errors the daemon otherwise swallows, each
  labelled with the operation that swallowed it. See **Debugging** in the
  README, and include it in bug reports.
- `CHANGELOG.md`, `SECURITY.md`, `CONTRIBUTING.md` and issue templates.

### Changed
- Scanning your project roots no longer freezes the board. It was fully
  synchronous, so on a large or network-mounted projects tree the whole
  daemon stopped answering — logs, ports, start and kill — for the length of
  a scan. Measured on 400 projects: the board went from serving 2 requests
  during a scan to 22–28.
- WSL2 audited and documented. Every path that needs a macOS tool already
  fell back to one WSL2 has, so it is expected to work; `*.localhost`
  proxying there is untested and the README says so rather than claiming it.
- The project list is cached for 5 minutes instead of 30 seconds. Every
  change you make through Stackdeck already refreshes it immediately; the
  Projects panel's ↻ refresh is there for a repo you cloned elsewhere.

### Fixed
- A branch name shaped like a command-line option can no longer reach `git`
  as one. `--end-of-options` now separates every branch operand, and the
  worktree-name sanitizer refuses anything starting with a dash.
- `stackdeck` and the TUI's `o` key now open the board on WSL2, through
  `wslview` or `explorer.exe`. `xdg-open` is usually absent there and opens
  nothing when present, because the browser is on the Windows side.
- The "prove it never talks to the internet" command in the README and on the
  landing page selected the wrong process: `pgrep -f 'stackdeck|server.js'`
  also matches editor helper processes, and `head -1` picked the lowest pid.
  It now finds the daemon by the port it listens on.
- Two locals that shadowed module-level maps (`adopted` in `startWorktree`,
  `procs` in `detectProcs`) renamed. Both were latent, and both are the
  collision that killed the TUI on launch in 0.10.0.

## [0.10.0] — 2026-08-31

### Added
- The port table outside the browser, where the question actually gets asked:
  `stackdeck ports [query]` filters over port, pid, process and command, and
  `stackdeck kill <pid>` has the same guardrails as the panel.
- `p` in the TUI as a second view, sharing the board's navigation, filter and
  split pane. `x` arms and a second `x` kills, naming the target first and
  saying outright when it is an operating-system process; any other key
  disarms. Enter fills the log pane with cwd, parent and sibling ports.
- MCP gets `list_ports`, `whats_on_port` and `kill_pid`. `whats_on_port` is
  the one that matters: an agent that can start services but cannot see why a
  port is taken will retry a start that can never bind.

### Fixed
- The TUI died on launch: `render()` already had a local `view`, so the new
  board/ports `view` was shadowed and read in its temporal dead zone.

## [0.9.2] — 2026-08-31

### Fixed
- A long service name no longer paints over its status badge.
- Stale claims removed from the docs.

## [0.9.1] — 2026-08-31

### Changed
- The Ports panel stops hiding what it cannot see: a port held by root or
  another user now gets a row saying so instead of vanishing from the list.
- Processes that ship with the OS are marked as such, so you know before you
  kill one that macOS will bring it straight back.

## [0.9.0] — 2026-08-31

### Added
- Ports panel: every listening port on the machine, what is holding it, how
  long it has been up, and a way to end it — not just the ports of services
  you configured. This is the answer to "what the hell has :3000?".

## [0.8.3] — 2026-08-30

### Added
- A landing page, a `curl | sh` installer, and a Homebrew formula.

## [0.8.2] — 2026-08-29

### Fixed
- The service editor no longer silently discards what you typed when
  something else refreshed underneath it.

## [0.8.1] — 2026-08-28

### Changed
- README says plainly that `npx stackdeck` installs nothing on your PATH.

## [0.8.0] — 2026-08-28

### Added
- `stackdeck tui` — the same board, in the terminal.

## [0.7.3] — 2026-08-26

### Changed
- Documented that nothing leaves your machine, with the `lsof` command that
  proves it.

## [0.7.2] — 2026-08-26

### Changed
- README cut to half its length.

## [0.7.1] — 2026-08-26

### Changed
- Running a branch in a worktree now takes the service's real port when the
  main copy is stopped, so the rest of your stack reaches it at the address
  it already expects. It only moves to the next free port when both are up.

## [0.7.0] — 2026-08-26

### Added
- Worktrees made by other tools are adopted rather than fought over. Coding
  agents create worktrees constantly (Claude Code puts them under
  `.claude/worktrees`), and git refuses to check the same branch out twice —
  so Stackdeck runs the branch where it already lives.

### Fixed
- A service that ignores `$PORT` (Vite reads `vite.config`, Next reads `-p`)
  is now corrected to the port it actually bound, so the board and the proxy
  agree with reality.

## [0.6.2] — 2026-08-25

### Changed
- Documented that the 431 large-header trap applies to your own services too,
  with the fix.

## [0.6.1] — 2026-08-25

### Changed
- Multi-process detection merges the two halves of a repo: app processes from
  the Procfile or workspace, databases and brokers from `docker-compose`.
  Compose usually covers the infrastructure while the app runs on the host,
  and both belong on the board.

## [0.6.0] — 2026-08-25

### Added
- **Start on demand**: visiting `<service>.localhost` boots a stopped service
  and holds the request until it is ready. Opt-in per service, because the
  proxy is unauthenticated.
- **Idle stop**: stop a service again after N minutes with no requests.

## [0.5.1] — 2026-08-24

### Fixed
- `$HOME` is never printed expanded — worktree banners and dev-tool commands
  show `~`, because log panes end up in screenshots and screen shares.

## [0.5.0] — 2026-08-24

### Changed
- The version comes from `package.json`, so `npm version` is the single
  source of truth, and the macOS app bundle carries it too.

### Added
- Publishing to npm on version tags via trusted publishing (OIDC) — no
  tokens, no OTP.

## [0.4.0] — 2026-08-23

### Added
- Themes as a first-class feature: presets, plus a custom editor that derives
  every token from a few knobs and works light or dark.
- Settings rebuilt as a proper panel with one consistent save model.

### Changed
- Accessibility and rendering overhaul of the board, and a motion pass with
  pending states on every action.
- Killing an external process is honest about supervised daemons: it
  escalates politely and tells you when launchd or `brew services` restarted
  it, rather than letting the row quietly turn green again.

### Fixed
- Command inference no longer mutilates URLs in `package.json`. Stripping
  `//` comments broke every `https://` in a valid manifest.

## [0.3.0] and earlier — 2026-08-21 to 2026-08-22

The first two days. Not individually tagged, so grouped here rather than
guessed at.

### Added
- The board itself: finds the projects in your folders, works out how to run
  each one, and gives you Start, Kill, live logs and a branch dropdown.
- Command inference across the ecosystems — Makefile, justfile, Taskfile,
  npm/pnpm/yarn/bun, Deno, uv/poetry/pipenv/pdm, Django, Cargo, Go, Zig,
  Swift, .NET, Gradle, Maven, Rails, Rack, Laravel, Composer, Phoenix,
  Flutter, Dart, Stack, and `docker compose` as the last resort.
- **Worktree instances**: run another branch of a service in parallel, in its
  own checkout, on its own port.
- `*.localhost` reverse proxy, so services are reachable by name.
- Dependency-ordered startup (`dependsOn`), readiness checks (`readyWhen`),
  and `restart: on-failure` with backoff.
- An MCP server over stdio, for AI agents.
- Auto-loading `.env`, service sections, project categories with
  drag-and-drop, and a folder browser for picking scan roots.
- Dev tools section: Postgres, MySQL, Redis, Mongo and friends run as
  ordinary foreground services — no daemons, no Docker required.
- A per-install auth token on the API, after external review.
- Adoption of services a previous daemon started, so restarting Stackdeck
  does not orphan your dev servers.
- Repos nested one level inside container folders are discovered too.

### Changed
- Renamed from DevBoard to Stackdeck, with a logo and a macOS app icon.
- State moved to XDG paths, with a one-time migration from the old locations.

[Unreleased]: https://github.com/beingmechon/stackdeck/compare/v0.10.1...HEAD
[0.10.1]: https://github.com/beingmechon/stackdeck/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/beingmechon/stackdeck/compare/v0.9.2...v0.10.0
[0.9.2]: https://github.com/beingmechon/stackdeck/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/beingmechon/stackdeck/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/beingmechon/stackdeck/compare/v0.8.3...v0.9.0
[0.8.3]: https://github.com/beingmechon/stackdeck/compare/v0.8.2...v0.8.3
[0.8.2]: https://github.com/beingmechon/stackdeck/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/beingmechon/stackdeck/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/beingmechon/stackdeck/compare/v0.7.3...v0.8.0
[0.7.3]: https://github.com/beingmechon/stackdeck/compare/v0.7.2...v0.7.3
[0.7.2]: https://github.com/beingmechon/stackdeck/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/beingmechon/stackdeck/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/beingmechon/stackdeck/compare/v0.6.2...v0.7.0
[0.6.2]: https://github.com/beingmechon/stackdeck/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/beingmechon/stackdeck/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/beingmechon/stackdeck/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/beingmechon/stackdeck/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/beingmechon/stackdeck/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/beingmechon/stackdeck/releases/tag/v0.4.0
