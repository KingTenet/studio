#!/usr/bin/env bash
# Stops Claude Code sessions that have sat idle in herdr, leaving `claude --resume <id>` typed at the
# pane's prompt, and logs them for the index's Resume button. Details: lib/claude-reaper.js.
#
# Usage: claude-reaper.sh watch [--dry-run]   # every 60s; the infra stack's Reaper tab runs this
#        claude-reaper.sh once [--dry-run] [--only <pane>]   # one pass, treating idle panes as past the limit
#        claude-reaper.sh list [n]            # the last n stopped/closed sessions
#        claude-reaper.sh resume <worktree> [session]   # bring back a stopped session
#        claude-reaper.sh start <worktree> [--message <text>]   # a fresh session, in a new claude tab; --message is its first prompt
#        claude-reaper.sh stop <pane> [--dismiss]   # stop that pane's session now, resumably; --dismiss also drops its ⏸ chip
set -euo pipefail
exec node "$(dirname "$0")/lib/claude-reaper.js" "$@"
