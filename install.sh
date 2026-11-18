#!/usr/bin/env bash
# The studio's one-time setup on a Mac, run from a checkout of this repo (next to where your apps will go, e.g.
# ~/Studio/studio). It installs what the studio needs, logs into GitHub and Claude with your accounts,
# puts `studio` on your PATH and builds the cockpit. With --app it then makes that app with `studio new` (see
# bin/studio); without it, make one later with `studio new <name>`.
#
# Running it again is safe: every step that's already done is skipped, and your apps and config.json are never
# written over.
#
# Usage: ./install.sh [--app <name> [--collaborator <github user>]]
#   --app           an app to make: its folder in ~/Studio and its GitHub repo
#   --collaborator  a GitHub user to add to that app's repo, so they can help (they get an invitation)
#
# Environment: STUDIO_HOME (default ~/.studio), STUDIO_WHISPER_MODEL (default ~/.whisper/ggml-small.en.bin),
# STUDIO_WHISPER_MODEL_URL (where the model is downloaded from).
set -Eeuo pipefail

APP_NAME=""
COLLABORATOR=""
usage() { echo "usage: ./install.sh [--app <name>] [--collaborator <github user>]" >&2; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --app) [ $# -ge 2 ] || usage; APP_NAME=$2; shift 2 ;;
    --collaborator) [ $# -ge 2 ] || usage; COLLABORATOR=$2; shift 2 ;;
    *) usage ;;
  esac
done
[ -z "$COLLABORATOR" ] || [ -n "$APP_NAME" ] || { echo "--collaborator is added to an app's repo, so it needs --app too." >&2; exit 2; }
case "$APP_NAME" in
  *[!a-z0-9-]*|-*) echo "The app's name can only have lowercase letters, numbers and dashes, like my-app." >&2; exit 2 ;;
esac

STUDIO_DIR="$(cd "$(dirname "$(realpath "$0")")" && pwd)"
# pnpm can come from Corepack, which otherwise stops to ask before downloading it.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
STUDIO_HOME="${STUDIO_HOME:-$HOME/.studio}"
WHISPER_MODEL="${STUDIO_WHISPER_MODEL:-$HOME/.whisper/ggml-small.en.bin}"
WHISPER_MODEL_URL="${STUDIO_WHISPER_MODEL_URL:-https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin}"
CLAUDE_INSTALL_URL="${STUDIO_CLAUDE_INSTALL_URL:-https://claude.ai/install.sh}"
BIN_DIR="$HOME/.local/bin"
ZPROFILE="$HOME/.zprofile"

STEP=""
step() { STEP=$1; printf '\n==> %s\n' "$1"; }
ok() { echo "    ✓ $1"; }
fail() { echo >&2; echo "✗ Setup stopped while: $STEP." >&2; echo "  Fix what's shown above, then run ./install.sh again. Finished steps are skipped." >&2; exit 1; }
trap fail ERR
die() { echo "    $1" >&2; fail; }

# A line added to ~/.zprofile (read by every new Terminal window), unless it's already there.
add_to_zprofile() { grep -qsF "$1" "$ZPROFILE" || { printf '\n%s\n' "$1" >>"$ZPROFILE"; echo "    added to $ZPROFILE: $1"; }; }

# Homebrew can only add things for the account that owns it (on a shared Mac, maybe someone else's). A Homebrew that can't
# tell (no --prefix) counts as writable.
brew_writable() {
  local prefix
  prefix=$(brew --prefix 2>/dev/null) || return 0
  [ -w "$prefix/bin" ] && { [ ! -e "$prefix/var/homebrew/locks" ] || [ -w "$prefix/var/homebrew/locks" ]; }
}
brew_install() {
  brew_writable || die "Homebrew on this Mac belongs to another account ($(stat -f %Su "$(brew --prefix)")), so this one can't add $*. Ask that account to run: brew install $*"
  brew install --quiet "$@"
}

# Anthropic's own installer for Claude Code: it goes in ~/.local/bin, needs no admin rights and keeps itself up to date.
# CURL_HOME points curl (the installer's own downloads too) at a .curlrc; the retry uses one that asks for HTTP/1.1,
# because some security software drops HTTP/2 downloads part way.
install_claude() {
  local rc
  rc=$(mktemp -d)
  [ "${1:-}" = http1.1 ] && echo "http1.1" >"$rc/.curlrc"
  CURL_HOME="$rc" curl -fsSL "$CLAUDE_INSTALL_URL" | CURL_HOME="$rc" bash
}

node_ok() { command -v node >/dev/null && node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 23 || (a === 23 && b >= 8) || (a === 22 && b >= 16) ? 0 : 1)'; }

echo "Setting up Studio (from $STUDIO_DIR)."

# --- tools ----------------------------------------------------------------------------------------

step "Homebrew, which installs everything else"
if ! command -v brew >/dev/null; then
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    [ -x "$b" ] && eval "$("$b" shellenv)" && break
  done
fi
if command -v brew >/dev/null; then
  ok "already installed"
else
  echo "    It asks for this Mac's password (nothing shows as you type)."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    [ -x "$b" ] && eval "$("$b" shellenv)" && break
  done
  command -v brew >/dev/null || die "Homebrew didn't install."
fi
# New Terminal windows find what Homebrew installs (herdr, gh, node…) too, also when Homebrew was there already, as it
# is for a second account on a Mac.
add_to_zprofile "eval \"\$($(command -v brew) shellenv)\""

step "The tools the studio uses"
# Each formula, and the command that shows it's there.
# ffmpeg: whisper-server's --convert turns the cockpit's recordings into the WAV it reads with it, and exits without it.
for pair in herdr:herdr node:node pnpm:pnpm gh:gh whisper-cpp:whisper-server ffmpeg:ffmpeg jq:jq; do
  formula=${pair%%:*} cmd=${pair#*:}
  if command -v "$cmd" >/dev/null; then
    ok "$formula"
  else
    brew_install "$formula"
  fi
done
if ! node_ok; then
  echo "    Node $(node --version) is too old (the studio needs 22.16 or later), so it's being updated."
  brew_writable || die "Homebrew on this Mac belongs to another account ($(stat -f %Su "$(brew --prefix)")), so this one can't update Node. Ask that account to run: brew upgrade node"
  brew upgrade --quiet node 2>/dev/null || brew install --quiet node
  hash -r
  node_ok || die "Node is still $(node --version) at $(command -v node). Remove that one, or put Homebrew's first on the PATH."
fi
export PATH="$BIN_DIR:$PATH"
if command -v claude >/dev/null; then
  ok "Claude Code"
else
  install_claude || { echo "    The download dropped part way; trying again over HTTP/1.1."; install_claude http1.1; } ||
    die "Claude Code didn't install. Check the internet connection, then run ./install.sh again."
  command -v claude >/dev/null || die "Claude Code installed, but it isn't in $BIN_DIR."
  ok "Claude Code"
fi
# /look takes its screenshots with headless Chrome.
if [ -d "/Applications/Google Chrome.app" ]; then ok "Google Chrome"; else brew_install --cask google-chrome; fi

step "The speech-to-text model for dictation"
if [ -s "$WHISPER_MODEL" ]; then
  ok "already downloaded"
else
  mkdir -p "$(dirname "$WHISPER_MODEL")"
  echo "    Downloading about 470 MB…"
  curl -fL --progress-bar -o "$WHISPER_MODEL.part" "$WHISPER_MODEL_URL"
  mv "$WHISPER_MODEL.part" "$WHISPER_MODEL"
fi

# --- accounts -------------------------------------------------------------------------------------

step "Logging into GitHub (your account)"
if gh auth status >/dev/null 2>&1; then
  ok "already logged in"
else
  echo "    A browser page opens: log in there and enter the code shown here."
  gh auth login --hostname github.com --git-protocol https --web
fi
gh auth setup-git
OWNER=$(gh api user --jq .login)
ok "logged in as $OWNER"

step "Logging into Claude (your account)"
if claude auth status --json 2>/dev/null | jq -e '.loggedIn == true' >/dev/null; then
  ok "already logged in"
else
  echo "    A browser page opens: log in there with your Claude account."
  claude auth login --claudeai
fi

step "Letting herdr see what Claude is doing"
mkdir -p "$HOME/.claude"
if herdr integration status 2>/dev/null | grep -q '^claude: current'; then
  ok "already set up"
else
  herdr integration install claude
fi

step "Your name on the app's history"
for key in user.name user.email; do
  if [ -n "$(git config --global "$key" || true)" ]; then
    ok "$key is $(git config --global "$key")"
  else
    [ "$key" = user.name ] && prompt="Your name: " || prompt="Your email: "
    value=""
    while [ -z "$value" ]; do read -r -p "    $prompt" value || die "No answer given."; done
    git config --global "$key" "$value"
  fi
done

# --- the studio -----------------------------------------------------------------------------------

step "The studio command"
mkdir -p "$BIN_DIR"
ln -sfn "$STUDIO_DIR/bin/studio" "$BIN_DIR/studio"
add_to_zprofile 'export PATH="$HOME/.local/bin:$PATH"'
ok "$BIN_DIR/studio → $STUDIO_DIR/bin/studio"

step "Building the cockpit page"
pnpm --dir "$STUDIO_DIR/web" install --frozen-lockfile --silent
pnpm --dir "$STUDIO_DIR/web" --silent build >/dev/null
ok "built"

if [ -n "$APP_NAME" ]; then
  step "Your app, $APP_NAME"
  "$STUDIO_DIR/bin/studio" new "$APP_NAME" ${COLLABORATOR:+--collaborator "$COLLABORATOR"}
fi

trap - ERR
if [ -n "$APP_NAME" ]; then
  cat <<EOF

All set. To start the studio, type:

    studio up

The studio opens in the browser at http://localhost:4000.

To use $APP_NAME for real, on its own data, open $APP_NAME in ~/Applications (or put it in the Dock).
It runs the newest version you kept.
EOF
else
  cat <<EOF

All set. To make your app, type studio new and a name for it, for example:

    studio new my-app

The name can have lowercase letters, numbers and dashes. Then start the studio with:

    studio up

It opens in the browser at http://localhost:4000.
EOF
fi
