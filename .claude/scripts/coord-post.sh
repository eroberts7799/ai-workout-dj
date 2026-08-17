#!/bin/bash
# AWDJ cross-session coordination: post a one-line status note to this
# session's mailbox so the other session sees it on its next prompt.
# Usage: bash .claude/scripts/coord-post.sh "landed X to main"
COORD_DIR="$HOME/.awdj-coord"
mkdir -p "$COORD_DIR"
case "$PWD" in
  *ai-workout-dj-design*) ME="design" ;;
  *)                      ME="main" ;;
esac
[ -n "$1" ] || { echo "usage: coord-post.sh \"message\"" >&2; exit 1; }
echo "[$(date '+%m-%d %H:%M')] $1" >> "$COORD_DIR/$ME.md"
echo "posted to $ME mailbox"
