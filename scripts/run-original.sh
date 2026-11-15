#!/bin/sh
# Run the original MS-DOS Teratron (old-tron/compiled) in DOSBox Staging.
#
#   npm run original               the game
#   npm run original -- SETUP.EXE  its sound set-up
#
# Needs DOSBox Staging (`brew install dosbox-staging`). The settings the game needs are
# in original.dosbox.conf, applied on top of your own; the game's folder is mounted as
# C: and stays open at the prompt afterwards.

set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="$HERE/../old-tron/compiled"
PROGRAM="${1:-TRON.EXE}"

if command -v dosbox-staging >/dev/null 2>&1; then
  DOSBOX=dosbox-staging
elif command -v dosbox >/dev/null 2>&1; then
  DOSBOX=dosbox
else
  echo "DOSBox Staging not found: brew install dosbox-staging" >&2
  exit 1
fi

cd "$DIR"
exec "$DOSBOX" --conf "$HERE/original.dosbox.conf" -c "mount c ." -c "c:" -c "$PROGRAM"
