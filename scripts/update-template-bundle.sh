#!/usr/bin/env bash
# Rebuilds template/app.bundle, the starter app that install.sh creates her app from, out of a template repo:
# its main branch and every tag (v1, v2 and their messages), as one git bundle. Run it again whenever the
# template changes, then commit the new bundle.
#
# Usage: scripts/update-template-bundle.sh <template repo>   # e.g. ~/Coding/studio-template
set -euo pipefail

[ $# -eq 1 ] || { echo "usage: scripts/update-template-bundle.sh <template repo>" >&2; exit 2; }
TEMPLATE="$1"
STUDIO_DIR="$(cd "$(dirname "$(realpath "$0")")/.." && pwd)"
BUNDLE="$STUDIO_DIR/template/app.bundle"

git -C "$TEMPLATE" rev-parse --verify --quiet main >/dev/null || { echo "$TEMPLATE has no main branch." >&2; exit 1; }
[ -n "$(git -C "$TEMPLATE" tag --list 'v*')" ] || { echo "$TEMPLATE has no version tags (v1, v2…)." >&2; exit 1; }

mkdir -p "$(dirname "$BUNDLE")"
tmp="$BUNDLE.tmp"
git -C "$TEMPLATE" bundle create --quiet "$tmp" main --tags
git bundle verify --quiet "$tmp" 2>/dev/null || { rm -f "$tmp"; echo "The new bundle didn't verify." >&2; exit 1; }
mv "$tmp" "$BUNDLE"
echo "Wrote $BUNDLE:"
git bundle list-heads "$BUNDLE"
