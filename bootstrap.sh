#!/bin/bash
# Sets up Studio on a Mac from nothing, with one line in Terminal:
#
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/KingTenet/studio/main/bootstrap.sh)"
#
# (add ` -- --app my-app` to make an app too: everything after `--` goes to install.sh). It gets git if this Mac has
# none (Homebrew's installer brings Apple's command-line tools, and Homebrew is needed next anyway), copies Studio into
# ~/Studio/studio (or updates the copy there), then runs its install.sh. No GitHub account is needed for this part:
# install.sh logs into GitHub later, in the browser.
#
# Run as `bash -c "$(curl …)"`, not `curl … | bash`: install.sh asks questions, and through a pipe it would read the
# rest of this script instead of the answers. Everything is in main(), called on the last line, so a download cut off
# part way runs nothing.
#
# Environment: STUDIO_REPO_URL (where Studio is copied from), STUDIO_DIR (where to, default ~/Studio/studio),
# STUDIO_HOMEBREW_INSTALL_URL (Homebrew's installer).
set -euo pipefail

main() {
  local repo="${STUDIO_REPO_URL:-https://github.com/KingTenet/studio.git}"
  local dir="${STUDIO_DIR:-$HOME/Studio/studio}"
  local homebrew="${STUDIO_HOMEBREW_INSTALL_URL:-https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh}"

  # Until Apple's command-line tools are installed, git on a Mac only offers to install them.
  has_git() { xcode-select -p >/dev/null 2>&1; }

  if ! has_git; then
    echo "==> Homebrew, and Apple's command-line tools with it (this Mac has no git yet)"
    echo "    It asks for this Mac's password (nothing shows as you type)."
    /bin/bash -c "$(curl -fsSL "$homebrew")"
    has_git || { echo "✗ This Mac still has no git. Run: xcode-select --install, then this again." >&2; exit 1; }
  fi

  if [ -d "$dir/.git" ]; then
    echo "==> Updating Studio in $dir"
    GIT_TERMINAL_PROMPT=0 git -C "$dir" pull --ff-only --quiet || echo "    Couldn't update it, so setting up the version that's there."
  elif [ -e "$dir" ]; then
    echo "✗ $dir is there already but isn't a copy of Studio. Move it out of the way, then run this again." >&2
    exit 1
  else
    echo "==> Copying Studio into $dir"
    mkdir -p "$(dirname "$dir")"
    GIT_TERMINAL_PROMPT=0 git clone --quiet "$repo" "$dir"
  fi

  exec "$dir/install.sh" ${@+"$@"}
}

main ${@+"$@"}
