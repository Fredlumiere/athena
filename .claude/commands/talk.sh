#!/bin/bash
# talk - Voice wrapper for Fred's Team leads
# Usage: talk <lead> <prompt>
# Example: talk meg "review the sprint"

set -euo pipefail

# Voice assignments for team leads
declare -A VOICES=(
  [meg]="Samantha"
  [joy]="Flo (English (US))"
  [ava]="Karen"
  [gil]="Daniel"
  [wes]="Reed (English (US))"
  [vic]="Ralph"
)

LEAD="${1:-}"
shift 2>/dev/null || true
PROMPT="$*"

if [[ -z "$LEAD" ]]; then
  echo "Fred's Team - Voice Mode"
  echo ""
  echo "Usage: talk <lead> <prompt>"
  echo ""
  echo "Team leads:"
  echo "  meg  - Engineering Manager    (Samantha)"
  echo "  joy  - Product Manager        (Flo)"
  echo "  ava  - Marketing Strategist   (Karen)"
  echo "  gil  - VP of Sales            (Daniel)"
  echo "  wes  - Head of CS             (Reed)"
  echo "  vic  - Head of Ops & Finance  (Ralph)"
  echo ""
  echo "Example: talk meg review the sprint backlog"
  exit 0
fi

LEAD_LOWER=$(echo "$LEAD" | tr '[:upper:]' '[:lower:]')

VOICE="${VOICES[$LEAD_LOWER]:-}"
if [[ -z "$VOICE" ]]; then
  echo "Unknown lead: $LEAD"
  echo "Available: meg, joy, ava, gil, wes, vic"
  exit 1
fi

if [[ -z "$PROMPT" ]]; then
  echo "No prompt provided."
  echo "Usage: talk $LEAD <prompt>"
  exit 1
fi

echo "[$LEAD_LOWER] Thinking..."
echo ""

# Run Claude Code in headless mode with the skill
RESPONSE=$(claude -p "/$LEAD_LOWER $PROMPT" 2>/dev/null)

# Print the response
echo "$RESPONSE"
echo ""

# Strip markdown formatting for cleaner speech
CLEAN=$(echo "$RESPONSE" | \
  sed 's/^#\+\s*//g' | \
  sed 's/\*\*//g' | \
  sed 's/\*//g' | \
  sed 's/`[^`]*`//g' | \
  sed 's/^[-*]\s*/. /g' | \
  sed 's/|[^|]*//g' | \
  sed '/^[[:space:]]*$/d' | \
  sed 's/^[[:space:]]*//' | \
  head -80)

# Speak it
say -v "$VOICE" -r 195 "$CLEAN"
