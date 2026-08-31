---
name: stackdeck
description: Run, supervise and inspect local dev services through Stackdeck's MCP server. Use when you need to start or restart a dev server, read its logs, find out what is holding a port, or run a git branch in its own worktree on its own port. Also use when a service "started" but requests to it fail, or when a start fails to bind.
---

# Stackdeck

Stackdeck runs local dev services and keeps watching them. Its MCP server
exposes the same board a human sees, so you can start things, read their
logs, and find out what is holding a port — without shelling out to `npm run
dev &` and losing the output.

## When to reach for it

- You need a dev server running to test a change.
- A service is up but requests fail, and you need its logs.
- A start failed to bind, and you need to know what already has the port.
- You are working on a branch and want it running **beside** the main
  checkout rather than instead of it.

If Stackdeck's tools are not available, fall back to running the command
yourself — but say so, because the user then has an untracked process.

## Start things with `start_service`, not a shell

```
start_service { name: "api" }
```

**It already waits until the service is serving.** Do not add a sleep loop
after it; that is the single most common mistake here. The reply tells you
which happened:

- `ready: true` — the service is answering. Make your request.
- `ready: false` with `notReady` — it spawned but never became ready in
  time. **It is still running**; read `get_logs` to find out why rather than
  starting it again.

`waitForReady: false` returns as soon as the process spawns, and
`timeoutSeconds` (1–600, default 60) changes how long it waits. Use the
default unless the service is genuinely slow to boot.

Dependencies start first and in order, so `start_service { name: "api" }`
brings up its database too if one is configured.

## When a start fails to bind, ask before retrying

```
whats_on_port { port: 3000 }
```

A start that could not take its port will never succeed on retry. Find out
what is there first. The answer distinguishes:

- **a Stackdeck service** — stop it with `stop_service`, not `kill_pid`.
  Killing it behind the board's back fires a crash notification and may
  trigger an on-failure restart of something you deliberately stopped.
- **another user's process** (usually root) — you cannot touch it, and
  Stackdeck will not use sudo. Tell the user.
- **an OS process** — say so before suggesting a kill. macOS hands `:5000`
  and `:7000` to AirPlay, and launchd brings those straight back.
- **something of the user's** — `kill_pid` works, but ask first unless they
  already told you to clear the port.

## Run a branch in parallel with `start_worktree`

```
start_worktree { name: "api", branch: "feature/checkout" }
```

That branch runs in its own git worktree, beside the main checkout, on its
own port — so the main copy keeps running. Heavy directories
(`node_modules`, `target`, `.venv`) are symlinked from the main checkout
rather than copied, so a second worktree costs a checkout, not a gigabyte.
Like `start_service`, it waits until the branch is actually serving.

The reply carries `key` (the `service@branch` form) and `port`. Use the key
with `stop_worktree`.

If a worktree for that branch already exists — including one you or another
agent made — Stackdeck runs **that** one rather than fighting git over it.

### Do not clean up worktrees you did not create

`list_worktrees { name: "api" }` reports every worktree of a repo, wherever
it lives, with `createdByStackdeck` and `removable`. Only ever remove one
where `removable` is true. Another agent's worktree is its working
directory; deleting it destroys work that cannot be recovered. When in
doubt, leave it and say what you found.

## Read logs before forming a theory

```
get_logs { name: "api", lines: 100 }
```

Stackdeck captures stdout and stderr from the moment a service starts, so
the failure is usually already there. Read it before restarting anything —
a restart discards the state that explains the problem.

## The rest

- `list_services` — what exists, what is up, on which port and branch, and
  whether the working tree is dirty.
- `list_ports` — every listening port on the machine, not just configured
  services. Takes an optional `query` filter.
- `stop_service` / `restart_service` — by name.

## Things that will bite you

- **"Started" is not "serving."** That distinction is why `start_service`
  waits by default. Do not turn it off and then immediately make a request.
- **`$PORT` is a request, not a guarantee.** Vite reads `vite.config`, Next
  reads `-p`. Stackdeck reports the port a service *actually* bound, so
  trust `list_services` over the port you asked for.
- **Killing the daemon does not kill your services.** They are detached on
  purpose. A restarted daemon re-adopts them.
- **Stackdeck never uses sudo.** A port held by root is visible but not
  actionable. Say so rather than suggesting `sudo kill`.
