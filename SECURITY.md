# Security

Stackdeck runs shell commands on your machine, so I take reports seriously.

## Supported versions

The latest release only. This is pre-1.0 and there are no maintenance
branches — fixes ship in the next version.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository:
**Security → Report a vulnerability**. That keeps the report private until
there is a fix.

Please do not open a public issue for something exploitable.

I am one person doing this in evenings. Expect an acknowledgement within a
week, best effort. If a week passes with no reply, an issue saying only "sent
a security report, no response" is a fair nudge — no details in it, please.

## Threat model, and what is out of scope

The daemon binds 127.0.0.1, executes the commands you configure, and gates
its API behind a per-install secret readable only by your user.

**Out of scope** — anything that already requires local shell access as the
same user. The daemon runs shell commands by design, and reads a secret your
user owns; an attacker who is already running as you does not need a
vulnerability in Stackdeck to do anything Stackdeck can do. That includes:

- Reading `<state dir>/secret` and calling the API with it.
- Editing `config.json` to run an arbitrary command.
- Anything requiring write access to a repository's `.git` directory.

**Also out of scope, because it is documented and accepted:**

- The auth token is substituted into the served page, so a browser extension
  with host access to localhost can read it from the DOM. See the security
  model in the README.
- The `*.localhost` proxy is unauthenticated. It forwards only to ports of
  services you configured, and *start on demand* is opt-in for exactly this
  reason.

**In scope** — anything that crosses one of those lines. For example: a way
to reach the API without the token, to escape the folder browser's
restriction to your home and configured roots, to make the daemon run a
command you did not configure, or to reach it from a web page you merely
visited (a Host or Origin check that can be bypassed).

## Maintainer TODO

- [ ] Enable private vulnerability reporting: **Settings → Code security →
      Private vulnerability reporting → Enable**. Until that is on, the link
      above does not exist and there is no private channel.
