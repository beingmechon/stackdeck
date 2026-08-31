# Contributing

Thanks for looking. A few things are settled, and knowing them first will
save you writing a PR I have to close.

## Open an issue before you build a feature

Not out of process worship — this project has a fairly specific idea of what
it is, and I would rather talk about a feature for ten minutes than have you
spend an evening on something I am not going to merge.

Bug fixes need no discussion. Send them.

## Zero dependencies is not negotiable

Runtime, dev, build, test — none. Node builtins only. A PR that adds anything
to `package.json` gets closed, however good the package is.

This is the whole point of the project: it runs shell commands on your
machine, and "you can read all of it in an evening" is what makes that
reasonable to trust. Every dependency is code you did not read.

If you genuinely cannot do something without one, open an issue and make the
case. Do not open the PR.

## `server.js` and `index.html` stay single files

Same reason. Splitting them into modules would make the codebase more
conventional and less auditable. It is not an accident that they are big.

## Before you submit

```bash
npm test
```

Everything must pass. If you touched a parser or a detector, add a case — the
fixtures live in `test/fixtures/` and adding an ecosystem is usually one line
in `test/infer-command.test.js` plus a fixture directory.

CI runs the suite on Ubuntu and macOS across Node 18, 20 and 22, plus a smoke
job that installs the packed tarball and exercises the daemon over HTTP. If
you add a file the package needs, add it to the `files` array in
`package.json` — the smoke job exists to catch exactly that.

## Unix only, by design

Bash, process groups, `lsof`/`ss`. Windows-native support is out of scope;
WSL2 is Linux and is expected to work (see the README for the current state).

## Style

Match what is there. In particular the comments: they explain **why**, not
what, and they are the reason the file is readable at its size. A comment
that restates the line below it is worse than no comment.
