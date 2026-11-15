#!/bin/sh
# Run the original MS-DOS Teratron (old-tron/compiled) in DOSBox Staging.
#
#   npm run original               the game
#   npm run original -- SETUP.EXE  its sound set-up
#
# Needs DOSBox Staging (`brew install dosbox-staging`). Your own DOSBox configuration
# applies; the game's folder is mounted as C: and stays open at the prompt afterwards.

set -e
DIR="$(cd "$(dirname "$0")/../old-tron/compiled" && pwd)"
PROGRAM="${1:-TRON.EXE}"

if command -v dosbox-staging >/dev/null 2>&1; then
  DOSBOX=dosbox-staging
elif command -v dosbox >/dev/null 2>&1; then
  DOSBOX=dosbox
else
  echo "DOSBox Staging not found: brew install dosbox-staging" >&2
  exit 1
fi

exec "$DOSBOX" -c "mount c \"$DIR\"" -c "c:" -c "$PROGRAM"
