#!/usr/bin/env bash
# Install the SEO agent team into ~/.claude so it is available in every project.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${CLAUDE_HOME:-$HOME/.claude}"
MODE="${1:-install}"

agents=("$SRC"/.claude/agents/*.md)
commands=("$SRC"/.claude/commands/*.md)

case "$MODE" in
  --check)
    echo "Would install into $DEST"
    echo "  ${#agents[@]} agents  -> $DEST/agents/"
    echo "  ${#commands[@]} commands -> $DEST/commands/"
    conflicts=0
    for f in "${agents[@]}" "${commands[@]}"; do
      sub=$(basename "$(dirname "$f")")
      t="$DEST/$sub/$(basename "$f")"
      if [ -f "$t" ] && ! cmp -s "$f" "$t"; then echo "  CONFLICT (would overwrite): $sub/$(basename "$f")"; conflicts=$((conflicts+1)); fi
    done
    [ "$conflicts" -eq 0 ] && echo "No conflicts." || echo "$conflicts existing file(s) differ and would be replaced."
    exit 0
    ;;
  --uninstall)
    n=0
    for f in "${agents[@]}" "${commands[@]}"; do
      sub=$(basename "$(dirname "$f")")
      t="$DEST/$sub/$(basename "$f")"
      [ -f "$t" ] && rm "$t" && n=$((n+1))
    done
    echo "Removed $n file(s) from $DEST"
    exit 0
    ;;
  install) ;;
  *) echo "usage: ./install.sh [--check|--uninstall]"; exit 1 ;;
esac

mkdir -p "$DEST/agents" "$DEST/commands"
cp "${agents[@]}" "$DEST/agents/"
cp "${commands[@]}" "$DEST/commands/"

echo "Installed into $DEST"
echo "  ${#agents[@]} agents"
echo "  ${#commands[@]} commands"
echo
echo "Agents are now available in every project. The tools they call"
echo "(tools/serp.mjs, tools/memory.mjs, tools/guard.mjs) live in this repo and"
echo "are referenced by relative path, so run engagements from:"
echo "  $SRC"
