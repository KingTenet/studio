#!/usr/bin/env bash
# Prints the herdr workspace the app's tabs belong in: the workspace with the most panes whose
# cwd is inside the app's folder, or a new one labelled after the folder when there is none. With --existing it prints nothing instead of creating.
#
# Usage: worktree-workspace.sh [--existing] [app folder]    (default: the current folder's repo)
set -euo pipefail

EXISTING=false
if [ "${1:-}" = "--existing" ]; then
  EXISTING=true
  shift
fi
ROOT=$(cd "${1:-.}" && git rev-parse --show-toplevel)

id=$(herdr pane list | jq -r --arg root "$ROOT" '
  [.result.panes[] | select(.cwd == $root or (.cwd | startswith($root + "/")))]
  | group_by(.workspace_id) | sort_by(-length) | .[0][0].workspace_id // empty')
if [ -z "$id" ] && [ "$EXISTING" = false ]; then
  id=$(herdr workspace create --cwd "$ROOT" --label "$(basename "$ROOT")" --no-focus | jq -r '.result.workspace.workspace_id')
fi
echo "$id"
