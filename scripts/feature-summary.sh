#!/usr/bin/env bash
# Prints what the feature being built does, in plain words: the entry Keep adds to the app's FEATURES.md and shows
# before she confirms. Claude writes it headless (the feature-summary skill, `claude -p`) from a digest of the
# feature: its name, its checkpoints with what she asked for, the changes, and FEATURES.md so far (lib/feature.js).
# Keep runs it (STUDIO_SUMMARY_CMD stands in for it), and falls back to the checkpoints' labels if it fails or is slow.
#
# Usage: feature-summary.sh <app>
set -euo pipefail

SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
APP=$(cd "${1:?usage: $0 <app>}" && pwd)

DIGEST=$(node "$SCRIPTS/lib/feature.js" digest "$APP")

cd "$APP"
# Only Read: the digest holds everything it needs. No transcript of its own, so it never shows among her chats.
# The skill comes from this harness, loaded as the plugin studio.
claude -p "/studio:feature-summary $DIGEST" --plugin-dir "$(dirname "$SCRIPTS")" --no-session-persistence --allowedTools Read </dev/null
