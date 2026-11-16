#!/usr/bin/env bash
# Rewrites a worktree's summary, the text in the cockpit's ticket panel: cuts the worktree's Claude
# chats down to what was said (with its ticket, commits and previous summary) and has Claude write
# where the work stands from that, headless (the worktree-summary skill, `claude -p`), saving it as
# summary.json in the worktree's artifact folder (lib/summary.js). One run at a time per
# worktree: while one runs, another exits at once. Started by the panel when there is no summary yet,
# and by its refresh button.
#
# Usage: summary.sh <worktree>
set -euo pipefail

SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
TARGET=$(cd "${1:?usage: $0 <worktree>}" && git rev-parse --show-toplevel)
LIB="$SCRIPTS/lib/summary.js"

if [ "$(node "$LIB" status "$TARGET" | jq -r .running)" = "true" ]; then
  echo "A summary of $TARGET is already being written"
  exit 0
fi
FOLDER=$(node "$SCRIPTS/lib/artifacts.js" where "$TARGET" | jq -r .folder)
mkdir -p "$FOLDER"
echo $$ >"$FOLDER/summary.running"
trap 'rm -f "$FOLDER/summary.running"' EXIT

cd "$TARGET"
branch=$(git branch --show-current)
base=main
DIGEST="$FOLDER/summary-digest.md"
{
  echo "# Worktree"
  echo
  echo "Branch: ${branch:-(detached)}"
  echo
    echo "# Commits on this branch (vs $base)"
  echo
  git log --oneline -30 "$base..HEAD" 2>/dev/null || true
  echo
  node "$LIB" digest "$TARGET"
} >"$DIGEST"

# Only Read: the digest holds everything it needs. No transcript of its own, or the next digest would include it.
# The skill comes from this harness, loaded as the plugin studio.
summary=$(claude -p "/studio:worktree-summary $DIGEST" --plugin-dir "$(dirname "$SCRIPTS")" --no-session-persistence --allowedTools Read </dev/null)
printf '%s\n' "$summary" | node "$LIB" write "$TARGET"
echo "✅ Wrote the summary of $TARGET"
