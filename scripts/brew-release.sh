#!/bin/sh
# Point the Homebrew formula at a published npm release.
#
#   ./scripts/brew-release.sh            # latest on npm
#   ./scripts/brew-release.sh 0.11.2     # a specific version
#
# Rewrites packaging/homebrew/stackdeck.rb with that version's tarball URL and
# sha256, and copies it into the tap checkout if one is present. The formula is
# generated from what npm actually serves, never from local files, so the hash
# can only ever describe the artifact users will really download.
#
#   STACKDECK_TAP   path to a beingmechon/homebrew-tap checkout
#                   (default: ../homebrew-tap next to this repo)
set -eu

cd "$(dirname "$0")/.."
FORMULA="packaging/homebrew/stackdeck.rb"
TAP="${STACKDECK_TAP:-../homebrew-tap}"
WANT="${1:-latest}"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/sdbrew.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT INT TERM

INFO="$(STACKDECK_TMP="$TMP" node -e '
const fs = require("fs"), path = require("path");
const want = process.argv[1];
(async () => {
  const meta = await fetch(`https://registry.npmjs.org/stackdeck/${want}`).then((r) => {
    if (!r.ok) throw new Error(`registry said ${r.status} for ${want}`);
    return r.json();
  });
  const buf = Buffer.from(await fetch(meta.dist.tarball).then((r) => r.arrayBuffer()));
  const out = path.join(process.env.STACKDECK_TMP, "t.tgz");
  fs.writeFileSync(out, buf);
  process.stdout.write(`${meta.version} ${meta.dist.tarball} ${out}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
' "$WANT")"

VERSION="${INFO%% *}"
rest="${INFO#* }"
URL="${rest%% *}"
TGZ="${rest#* }"
SHA="$(shasum -a 256 "$TGZ" | cut -d' ' -f1)"

# Node rather than sed -i: BSD and GNU sed disagree about -i, and this runs on both.
node -e '
const fs = require("fs");
const [file, url, sha] = process.argv.slice(1);
const src = fs.readFileSync(file, "utf8")
  .replace(/^(\s*url\s+)".*"$/m, `$1"${url}"`)
  .replace(/^(\s*sha256\s+)".*"$/m, `$1"${sha}"`);
fs.writeFileSync(file, src);
' "$FORMULA" "$URL" "$SHA"

echo "stackdeck $VERSION"
echo "  url    $URL"
echo "  sha256 $SHA"
echo "  wrote  $FORMULA"

if [ -d "$TAP/.git" ]; then
  mkdir -p "$TAP/Formula"
  cp "$FORMULA" "$TAP/Formula/stackdeck.rb"
  echo "  copied to $TAP/Formula/stackdeck.rb"
  echo ""
  echo "Next:"
  echo "  cd $TAP && git add -A && git commit -m 'stackdeck $VERSION' && git push"
else
  echo ""
  echo "No tap checkout at $TAP — copy Formula/stackdeck.rb there by hand,"
  echo "or set STACKDECK_TAP=/path/to/homebrew-tap."
fi
