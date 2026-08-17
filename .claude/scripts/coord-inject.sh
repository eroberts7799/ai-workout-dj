#!/bin/bash
# AWDJ cross-session coordination: inject the OTHER session's recent notes
# into every prompt. Role is derived from the worktree path.
# UserPromptSubmit hook — stdout becomes model context.
COORD_DIR="$HOME/.awdj-coord"
case "$PWD" in
  *ai-workout-dj-design*) ME="design"; OTHER="main" ;;
  *)                      ME="main";   OTHER="design" ;;
esac
OTHER_FILE="$COORD_DIR/$OTHER.md"
[ -f "$OTHER_FILE" ] || exit 0
NOTES=$(tail -12 "$OTHER_FILE")
[ -n "$NOTES" ] || exit 0
echo "[awdj-coord] Latest notes from the $OTHER session (you are the $ME session; post your own updates with: bash .claude/scripts/coord-post.sh \"msg\"):"
echo "$NOTES"
exit 0
