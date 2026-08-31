# Stackdeck

Zero runtime and dev dependencies. Node builtins only. Never add to
`package.json` — not a bundler, not a linter, not a test framework, not
TypeScript. If something seems to need one, stop and explain why instead of
adding it.

`server.js` and `index.html` stay as single files. "Readable in an evening" is
a feature, not an accident — it is what makes a tool that runs shell commands
reasonable to trust.

Unix-only by design (bash, process groups, `lsof`/`ss`). WSL2 is Linux and is
expected to work; Windows-native is out of scope.

Run `npm test` before finishing any task.

Match the existing comment voice: direct, concrete, explains WHY not what. A
comment that restates the line below it is worse than no comment.

Errors that are deliberately swallowed go through `swallow("label", e)` with a
label specific enough to find the call site from a user's paste. It only
prints under `STACKDECK_DEBUG=1`.

User-facing copy names no AI vendor. Say "coding agents", not a product. MCP
is an open standard: document the client config, not one client's CLI command.
The exception is the README's comparison section, where naming a competitor is
the point.

The positioning lives in four places and drifts every time one is edited
alone: README.md's lead, and `docs/index.html`'s `<h1>`, `<title>` and meta
descriptions, and `package.json`'s `description`. Change one, change all.

After any change to behaviour or feature set, sweep for stale details before
finishing — README, landing page, CHANGELOG, CONTRIBUTING, SECURITY, this
file, `package.json` (description, keywords, `files`), the issue templates,
the Homebrew formula, and `bin/` usage text. Run any claim the docs make
rather than assuming it still holds.
