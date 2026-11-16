#!/usr/bin/env bash
# Screenshots a page of the app with headless Chrome, for the look skill: Claude then Reads the PNG to see
# the page as it is. The shot goes in $STUDIO_HOME/looks (the newest 20 are kept), and its path is printed.
#
# Usage: look.sh <path>   # a page of the app, such as /todo
set -euo pipefail

PAGE="${1:-/}"
case "$PAGE" in
  /*) ;;
  *) PAGE="/$PAGE" ;;
esac
STUDIO_HOME="${STUDIO_HOME:-$HOME/.studio}"
PORT=$(jq -r '.appPort // 4001' "$STUDIO_HOME/config.json" 2>/dev/null || echo 4001)
URL="http://localhost:$PORT$PAGE"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if ! curl -s -o /dev/null --max-time 5 "http://localhost:$PORT/"; then
  echo "The app isn't answering at http://localhost:$PORT, so there's nothing to look at. Run studio up to start it." >&2
  exit 1
fi
if [ ! -x "$CHROME" ]; then
  echo "Google Chrome isn't installed, and it's what takes the screenshot." >&2
  exit 1
fi

LOOKS="$STUDIO_HOME/looks"
mkdir -p "$LOOKS"
SHOT="$LOOKS/$(date +%Y-%m-%dT%H-%M-%S)-$(printf %s "$PAGE" | tr -c 'A-Za-z0-9' '-' | cut -c1-40).png"
# Its own profile, so it never touches the Chrome you have open.
PROFILE=$(mktemp -d)
trap 'rm -rf "$PROFILE"' EXIT
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$PROFILE" --window-size=1280,800 \
  --virtual-time-budget=5000 --screenshot="$SHOT" "$URL" >/dev/null 2>&1 || true
if [ ! -s "$SHOT" ]; then
  echo "Chrome didn't manage to take a screenshot of $URL." >&2
  exit 1
fi
ls -t "$LOOKS"/*.png | tail -n +21 | while read -r old; do rm -f "$old"; done
echo "$SHOT"
