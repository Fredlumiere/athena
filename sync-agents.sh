#!/bin/sh
# sync-agents.sh — Sync Claude Code agents between ~/.claude/commands/ and project
#
# Usage:
#   ./sync-agents.sh              Bidirectional sync (default)
#   ./sync-agents.sh push         Push local agents into project (overwrite)
#   ./sync-agents.sh pull         Pull project agents into local (overwrite)
#   ./sync-agents.sh status       Show diff summary
#   ./sync-agents.sh install      Install git post-checkout hook
#
# Flags:
#   --dry-run                     Show what would happen without making changes
#
# Portable: works on macOS and Linux (POSIX sh compatible)

set -e

# ─── Config ────────────────────────────────────────────────────────────────────

LOCAL_DIR="$HOME/.claude/commands"
PROJECT_DIR=".claude/commands"
BACKUP_DIR="$HOME/.claude/commands/backups"
DRY_RUN=false

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
DIM='\033[0;90m'
RESET='\033[0m'

# ─── Parse args ────────────────────────────────────────────────────────────────

CMD="sync"
for arg in "$@"; do
  case "$arg" in
    push|pull|status|install) CMD="$arg" ;;
    --dry-run) DRY_RUN=true ;;
    -h|--help)
      sed -n '2,14p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      printf "${RED}Unknown argument: %s${RESET}\n" "$arg"
      exit 1
      ;;
  esac
done

# ─── Helpers ───────────────────────────────────────────────────────────────────

log_add()    { printf "${GREEN}  + %s${RESET}\n" "$1"; }
log_update() { printf "${YELLOW}  ~ %s${RESET}\n" "$1"; }
log_skip()   { printf "${DIM}  = %s${RESET}\n" "$1"; }
log_backup() { printf "${BLUE}  ↳ backed up to %s${RESET}\n" "$1"; }

file_mtime() {
  # Returns mtime as epoch seconds (works on macOS + Linux)
  if stat -f %m "$1" >/dev/null 2>&1; then
    stat -f %m "$1"  # macOS
  else
    stat -c %Y "$1"  # Linux
  fi
}

ensure_dirs() {
  mkdir -p "$LOCAL_DIR" "$PROJECT_DIR" "$BACKUP_DIR"
}

backup_file() {
  src="$1"
  name="$(basename "$src")"
  ts="$(date +%Y%m%d_%H%M%S)"
  dest="$BACKUP_DIR/${name%.md}_${ts}.md"
  if [ "$DRY_RUN" = true ]; then
    log_backup "$dest (dry-run)"
  else
    cp "$src" "$dest"
    log_backup "$dest"
  fi
}

copy_file() {
  src="$1"
  dest="$2"
  if [ "$DRY_RUN" = true ]; then
    printf "${DIM}    (dry-run) would copy %s → %s${RESET}\n" "$src" "$dest"
  else
    cp "$src" "$dest"
  fi
}

# ─── Status ────────────────────────────────────────────────────────────────────

do_status() {
  ensure_dirs
  printf "\n${BLUE}Agent sync status:${RESET}\n"
  printf "${DIM}  Local:   %s${RESET}\n" "$LOCAL_DIR"
  printf "${DIM}  Project: %s${RESET}\n\n" "$PROJECT_DIR"

  local_only=0
  project_only=0
  same=0
  differ=0

  # Check local agents
  for f in "$LOCAL_DIR"/*.md "$LOCAL_DIR"/*.sh; do
    [ -e "$f" ] || continue
    name="$(basename "$f")"
    if [ -e "$PROJECT_DIR/$name" ]; then
      if diff -q "$f" "$PROJECT_DIR/$name" >/dev/null 2>&1; then
        log_skip "$name (identical)"
        same=$((same + 1))
      else
        printf "${YELLOW}  ≠ %s (differs)${RESET}\n" "$name"
        differ=$((differ + 1))
      fi
    else
      printf "${GREEN}  → %s (local only)${RESET}\n" "$name"
      local_only=$((local_only + 1))
    fi
  done

  # Check project-only agents
  for f in "$PROJECT_DIR"/*.md "$PROJECT_DIR"/*.sh; do
    [ -e "$f" ] || continue
    name="$(basename "$f")"
    if [ ! -e "$LOCAL_DIR/$name" ]; then
      printf "${BLUE}  ← %s (project only)${RESET}\n" "$name"
      project_only=$((project_only + 1))
    fi
  done

  printf "\n${DIM}  Summary: %d identical, %d differ, %d local-only, %d project-only${RESET}\n\n" \
    "$same" "$differ" "$local_only" "$project_only"
}

# ─── Push ──────────────────────────────────────────────────────────────────────

do_push() {
  ensure_dirs
  printf "\n${BLUE}Pushing local → project${RESET}"
  [ "$DRY_RUN" = true ] && printf " ${DIM}(dry-run)${RESET}"
  printf "\n\n"

  added=0
  updated=0
  skipped=0

  for f in "$LOCAL_DIR"/*.md "$LOCAL_DIR"/*.sh; do
    [ -e "$f" ] || continue
    name="$(basename "$f")"
    if [ -e "$PROJECT_DIR/$name" ]; then
      if diff -q "$f" "$PROJECT_DIR/$name" >/dev/null 2>&1; then
        log_skip "$name"
        skipped=$((skipped + 1))
      else
        backup_file "$PROJECT_DIR/$name"
        copy_file "$f" "$PROJECT_DIR/$name"
        log_update "$name"
        updated=$((updated + 1))
      fi
    else
      copy_file "$f" "$PROJECT_DIR/$name"
      log_add "$name"
      added=$((added + 1))
    fi
  done

  printf "\n${DIM}  Done: %d added, %d updated, %d skipped${RESET}\n\n" "$added" "$updated" "$skipped"
}

# ─── Pull ──────────────────────────────────────────────────────────────────────

do_pull() {
  ensure_dirs
  printf "\n${BLUE}Pulling project → local${RESET}"
  [ "$DRY_RUN" = true ] && printf " ${DIM}(dry-run)${RESET}"
  printf "\n\n"

  added=0
  updated=0
  skipped=0

  for f in "$PROJECT_DIR"/*.md "$PROJECT_DIR"/*.sh; do
    [ -e "$f" ] || continue
    name="$(basename "$f")"
    if [ -e "$LOCAL_DIR/$name" ]; then
      if diff -q "$f" "$LOCAL_DIR/$name" >/dev/null 2>&1; then
        log_skip "$name"
        skipped=$((skipped + 1))
      else
        backup_file "$LOCAL_DIR/$name"
        copy_file "$f" "$LOCAL_DIR/$name"
        log_update "$name"
        updated=$((updated + 1))
      fi
    else
      copy_file "$f" "$LOCAL_DIR/$name"
      log_add "$name"
      added=$((added + 1))
    fi
  done

  printf "\n${DIM}  Done: %d added, %d updated, %d skipped${RESET}\n\n" "$added" "$updated" "$skipped"
}

# ─── Bidirectional Sync ───────────────────────────────────────────────────────

do_sync() {
  ensure_dirs
  printf "\n${BLUE}Bidirectional sync${RESET}"
  [ "$DRY_RUN" = true ] && printf " ${DIM}(dry-run)${RESET}"
  printf "\n\n"

  added=0
  updated=0
  skipped=0

  # All unique filenames from both dirs
  all_files=""
  for f in "$LOCAL_DIR"/*.md "$LOCAL_DIR"/*.sh "$PROJECT_DIR"/*.md "$PROJECT_DIR"/*.sh; do
    [ -e "$f" ] || continue
    name="$(basename "$f")"
    case "$all_files" in
      *" $name "*|*" $name") ;;  # already in list
      "$name "*) ;;
      "$name") ;;
      *) all_files="$all_files $name" ;;
    esac
  done

  for name in $all_files; do
    local_file="$LOCAL_DIR/$name"
    project_file="$PROJECT_DIR/$name"

    if [ -e "$local_file" ] && [ ! -e "$project_file" ]; then
      # Local only → copy to project
      copy_file "$local_file" "$project_file"
      log_add "$name → project"
      added=$((added + 1))
    elif [ ! -e "$local_file" ] && [ -e "$project_file" ]; then
      # Project only → copy to local
      copy_file "$project_file" "$local_file"
      log_add "$name → local"
      added=$((added + 1))
    elif diff -q "$local_file" "$project_file" >/dev/null 2>&1; then
      # Identical
      log_skip "$name"
      skipped=$((skipped + 1))
    else
      # Both exist, differ — keep newer
      local_mtime="$(file_mtime "$local_file")"
      project_mtime="$(file_mtime "$project_file")"
      if [ "$local_mtime" -gt "$project_mtime" ]; then
        backup_file "$project_file"
        copy_file "$local_file" "$project_file"
        log_update "$name (local is newer → project)"
      else
        backup_file "$local_file"
        copy_file "$project_file" "$local_file"
        log_update "$name (project is newer → local)"
      fi
      updated=$((updated + 1))
    fi
  done

  printf "\n${DIM}  Done: %d added, %d updated, %d skipped${RESET}\n\n" "$added" "$updated" "$skipped"
}

# ─── Install git hook ─────────────────────────────────────────────────────────

do_install() {
  hook_dir=".git/hooks"
  hook_file="$hook_dir/post-checkout"

  if [ ! -d "$hook_dir" ]; then
    printf "${RED}Not a git repository${RESET}\n"
    exit 1
  fi

  marker="# sync-agents-reminder"

  if [ -e "$hook_file" ] && grep -q "$marker" "$hook_file" 2>/dev/null; then
    printf "${DIM}Hook already installed${RESET}\n"
    return
  fi

  if [ "$DRY_RUN" = true ]; then
    printf "${DIM}(dry-run) Would install post-checkout hook${RESET}\n"
    return
  fi

  cat >> "$hook_file" << 'HOOK'
# sync-agents-reminder
if [ -f "./sync-agents.sh" ]; then
  printf "\033[0;33m[sync-agents]\033[0m Run ./sync-agents.sh to sync your Claude agents\n"
fi
HOOK
  chmod +x "$hook_file"
  printf "${GREEN}Installed post-checkout hook${RESET}\n"
}

# ─── Main ──────────────────────────────────────────────────────────────────────

case "$CMD" in
  status)  do_status ;;
  push)    do_push ;;
  pull)    do_pull ;;
  sync)    do_sync ;;
  install) do_install ;;
esac

# Git integration (skip for status/install/dry-run)
if [ "$CMD" != "status" ] && [ "$CMD" != "install" ] && [ "$DRY_RUN" = false ]; then
  if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    changed="$(git diff --name-only -- .claude/commands/ 2>/dev/null | wc -l | tr -d ' ')"
    untracked="$(git ls-files --others --exclude-standard -- .claude/commands/ 2>/dev/null | wc -l | tr -d ' ')"
    total=$((changed + untracked))
    if [ "$total" -gt 0 ]; then
      printf "${YELLOW}  %d file(s) changed in .claude/commands/${RESET}\n" "$total"
      printf "  Stage and commit? [y/N] "
      read -r answer
      if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
        git add .claude/commands/
        git commit -m "sync: update Claude Code agents"
        printf "${GREEN}  Committed!${RESET}\n"
      fi
    fi
  fi
fi
