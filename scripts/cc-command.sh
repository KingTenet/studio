#!/usr/bin/env bash
# Lets Claude run a Claude Code slash command on the user's behalf in its own herdr pane.
#
#   cc-command.sh rename <title>   queue `/rename <title>` (run by Claude through Bash)
#   cc-command.sh flush            Stop hook: type the queued commands into the pane
#
# Claude can't run slash commands itself, and its pane is busy while its turn runs, so a command
# is queued per pane and the Stop hook types it in (herdr send-text + enter) once the turn ends.
# Only the commands below are allowed.
set -euo pipefail

usage() { echo "usage: $(basename "$0") rename <title> | flush" >&2; exit 2; }

pending_file() { echo "${TMPDIR:-/tmp}/cc-command/${HERDR_PANE_ID//[^A-Za-z0-9_-]/_}"; }

cmd="${1:-}"; shift || true
case "$cmd" in
  rename)
    title="$*"
    [ -n "$title" ] || usage
    case "$title" in *$'\n'*|*$'\r'*) echo "The title must be one line." >&2; exit 2 ;; esac
    if [ -z "${HERDR_PANE_ID:-}" ]; then
      echo "Not running in a herdr pane, so it can't be typed in. Ask the user to run: /rename $title" >&2
      exit 1
    fi
    file=$(pending_file)
    mkdir -p "$(dirname "$file")"
    printf '/rename %s\n' "$title" >>"$file"
    echo "Queued: /rename $title (runs when this turn ends)"
    ;;
  flush)
    cat >/dev/null 2>&1 || true   # the hook's JSON input isn't needed
    [ -n "${HERDR_PANE_ID:-}" ] || exit 0
    file=$(pending_file)
    [ -f "$file" ] || exit 0
    lines="$file.sending.$$"
    mv "$file" "$lines"
    # Detached, so the hook returns and Claude Code gets back to its prompt before the text arrives.
    nohup bash -c '
      sleep 1
      while IFS= read -r line; do
        herdr pane send-text "$1" "$line" >/dev/null
        herdr pane send-keys "$1" enter >/dev/null
        sleep 0.5
      done <"$2"
      rm -f "$2"
    ' _ "$HERDR_PANE_ID" "$lines" >/dev/null 2>&1 &
    ;;
  *) usage ;;
esac
