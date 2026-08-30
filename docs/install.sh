#!/bin/sh
# Stackdeck installer.
#
#   curl -fsSL https://beingmechon.github.io/stackdeck/install.sh | sh
#
# Installs into ~/.local (no sudo, no npm) and symlinks the `stackdeck` command.
# Stackdeck has zero runtime dependencies, so "install" really is just: unpack a
# 78KB tarball and make one symlink. Node 18.13+ is the only requirement, and
# it is required because Stackdeck *is* a Node program.
#
# Environment:
#   STACKDECK_VERSION   pin a version (default: latest on npm)
#   STACKDECK_PREFIX    install root  (default: $HOME/.local)
#
# Uninstall:  curl -fsSL <this url> | sh -s -- --uninstall
set -eu

PREFIX="${STACKDECK_PREFIX:-$HOME/.local}"
LIBDIR="$PREFIX/lib/stackdeck"
BINLINK="$PREFIX/bin/stackdeck"

bold=""; dim=""; red=""; off=""
if [ -t 1 ] && [ "${NO_COLOR:-}" = "" ]; then
  bold="$(printf '\033[1m')"; dim="$(printf '\033[2m')"
  red="$(printf '\033[31m')"; off="$(printf '\033[0m')"
fi

say()  { printf '%s\n' "$*"; }
die()  { printf '%serror:%s %s\n' "$red" "$off" "$*" >&2; exit 1; }

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$BINLINK"
  rm -rf "$LIBDIR"
  say "removed $LIBDIR and $BINLINK"
  say "${dim}config and logs are untouched in ~/.config/stackdeck (delete by hand if you want them gone)${off}"
  exit 0
fi

# --- node ---------------------------------------------------------------
# Resolve node the same way a login shell would; installers piped into `sh`
# inherit a minimal PATH on some systems.
NODE="$(command -v node || true)"
[ -n "$NODE" ] || die "node is not on your PATH.
Stackdeck is a Node program and needs Node 18.13 or newer.
  macOS:  brew install node
  Linux:  https://nodejs.org  (or your distro's nodejs package)"

"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number);
  if (a<18 || (a===18 && b<13)) { console.error(process.versions.node); process.exit(1); }' \
  || die "node $("$NODE" -v) is too old — Stackdeck needs 18.13 or newer."

case "$(uname -s)" in
  Darwin|Linux|*BSD) ;;
  *) die "Stackdeck is Unix only (it uses process groups, lsof/ss, and a POSIX shell)." ;;
esac

# --- download -----------------------------------------------------------
# Resolving and fetching in node rather than curl+grep: the registry response is
# JSON, and node can verify the publisher's sha512 integrity hash without
# dragging in jq or openssl. Prints "<version> <tarball path>".
TMP="$(mktemp -d "${TMPDIR:-/tmp}/stackdeck.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT INT TERM

say "${dim}resolving stackdeck…${off}"
FETCHED="$(STACKDECK_TMP="$TMP" "$NODE" -e '
const fs = require("fs"), crypto = require("crypto"), path = require("path");
const want = process.env.STACKDECK_VERSION;
const tmp = process.env.STACKDECK_TMP;
const url = `https://registry.npmjs.org/stackdeck/${want || "latest"}`;
(async () => {
  const meta = await fetch(url).then((r) => {
    if (!r.ok) throw new Error(`registry said ${r.status} for ${want || "latest"}`);
    return r.json();
  });
  const buf = Buffer.from(await fetch(meta.dist.tarball).then((r) => {
    if (!r.ok) throw new Error(`download failed: ${r.status}`);
    return r.arrayBuffer();
  }));
  // The tarball must be exactly what the publish attested to; a mismatch means
  // something between npm and this machine altered it, so refuse rather than run it.
  const [algo, expect] = String(meta.dist.integrity || "").split("-");
  if (!algo || !expect) throw new Error("registry returned no integrity hash");
  const got = crypto.createHash(algo).update(buf).digest("base64");
  if (got !== expect) throw new Error(`integrity mismatch (${algo}) — refusing to install`);
  const out = path.join(tmp, "stackdeck.tgz");
  fs.writeFileSync(out, buf);
  process.stdout.write(`${meta.version} ${out}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
')" || die "could not download stackdeck — see the line above."

VERSION="${FETCHED%% *}"
TARBALL="${FETCHED#* }"

# --- install ------------------------------------------------------------
# Unpack beside the target and swap, so a failure halfway through leaves the
# existing install intact instead of a half-written directory.
mkdir -p "$TMP/stage" "$PREFIX/bin" "$PREFIX/lib"
tar -xzf "$TARBALL" -C "$TMP/stage"   # npm tarballs put everything under package/
[ -f "$TMP/stage/package/server.js" ] || die "tarball did not contain server.js"

rm -rf "$LIBDIR.old"
if [ -d "$LIBDIR" ]; then mv "$LIBDIR" "$LIBDIR.old"; fi
mv "$TMP/stage/package" "$LIBDIR"
rm -rf "$LIBDIR.old"
chmod +x "$LIBDIR/bin/stackdeck.js"

ln -sf "$LIBDIR/bin/stackdeck.js" "$BINLINK"

say ""
say "${bold}stackdeck $VERSION${off} → $LIBDIR"

case ":$PATH:" in
  *":$PREFIX/bin:"*)
    say ""
    say "  stackdeck        ${dim}start the daemon and open the board${off}"
    say "  stackdeck tui    ${dim}the same board in your terminal${off}"
    ;;
  *)
    rc="$HOME/.profile"
    case "${SHELL:-}" in *zsh) rc="$HOME/.zshrc" ;; *bash) rc="$HOME/.bashrc" ;; esac
    say ""
    say "$PREFIX/bin is not on your PATH. Add it:"
    say ""
    say "  echo 'export PATH=\"$PREFIX/bin:\$PATH\"' >> $rc && exec \$SHELL"
    say ""
    say "Or run it in full: $BINLINK"
    ;;
esac
say ""
