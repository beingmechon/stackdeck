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
