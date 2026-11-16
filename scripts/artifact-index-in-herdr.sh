#!/usr/bin/env bash
# Runs the artifact-index skill for the app in an "Artifacts" tab of its herdr workspace: Claude
# rewrites and publishes the app's artifact index, or with --consolidate first proposes merging
# overlapping artifacts. An open Artifacts tab with Claude still running in it is focused instead; one
# left at its shell (a finished or reaped run) is reused. Started by the cockpit's Artifacts buttons;
# returns as soon as the tab is running it.
#
# Usage: artifact-index-in-herdr.sh [--consolidate] <app folder>
set -euo pipefail

SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
MODE=""
if [ "${1:-}" = "--consolidate" ]; then
  MODE=" consolidate"
  shift
fi
TARGET=$(cd "${1:?usage: $0 [--consolidate] <app folder>}" && git rev-parse --show-toplevel)
LABEL="Artifacts"

ws="${HERDR_WORKSPACE:-$("$SCRIPTS/worktree-workspace.sh" "$TARGET")}"
existing=$(herdr tab list --workspace "$ws" | jq -r --arg label "$LABEL" '.result.tabs[] | select(.label == $label) | .tab_id' | head -n1)
if [ -n "$existing" ]; then
  herdr tab focus "$existing" >/dev/null
  pane=$(herdr pane list | jq -r --arg tab "$existing" '.result.panes[] | select(.tab_id == $tab) | .pane_id' | head -n1)
  if [ -z "$pane" ] || herdr pane list | jq -e --arg pane "$pane" '.result.panes[] | select(.pane_id == $pane and .agent != null)' >/dev/null; then
    echo "Claude is still running in the $LABEL tab ($existing); focused it"
    exit 0
  fi
  # A reaped session leaves `claude --resume <id>` typed at the prompt; clear it so it doesn't prefix the new command.
  herdr pane send-keys "$pane" ctrl+u >/dev/null
else
  pane=$(herdr tab create --workspace "$ws" --cwd "$TARGET" --label "$LABEL" | jq -r '.result.root_pane.pane_id')
fi
herdr pane run "$pane" "claude --permission-mode auto '/artifact-index$MODE'"
echo "✅ Claude is ${MODE:+consolidating and }rebuilding the artifact index in the $LABEL tab ($pane)"
