# Homebrew formula for Stackdeck.
#
# This file is the source of truth; scripts/brew-release.sh copies it into the
# tap repo (beingmechon/homebrew-tap) with the version and sha256 of a release.
#
#   brew install beingmechon/tap/stackdeck
class Stackdeck < Formula
  desc "Control panel for your local dev services: start, stop, branch, watch logs"
  homepage "https://github.com/beingmechon/stackdeck"
  url "https://registry.npmjs.org/stackdeck/-/stackdeck-0.10.2.tgz"
  sha256 "db597036ee4cee4b636dd6c1ed1ab2a9f27e657eb503659904898b0cc4a7d264"
  license "MIT"

  depends_on "node"

  # Stackdeck has no runtime dependencies, so there is nothing to build or
  # resolve: the tarball is the program. Copy it in and point one wrapper at it.
  def install
    libexec.install Dir["*"]
    chmod 0755, libexec/"bin/stackdeck.js"
    (bin/"stackdeck").write_env_script libexec/"bin/stackdeck.js",
                                       PATH: "#{Formula["node"].opt_bin}:$PATH"
  end

  def caveats
    <<~EOS
      Start the board:      stackdeck
      Or stay in the term:  stackdeck tui

      Config and logs live in ~/.config/stackdeck. The daemon binds 127.0.0.1
      and never talks to the internet.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/stackdeck --version")
    assert_match "control panel", shell_output("#{bin}/stackdeck help")
  end
end
