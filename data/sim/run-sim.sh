#!/usr/bin/env bash
# Run one headless land-use simulation from the private CLI bundle copy and
# sample its memory every 10 s.
#   run-sim.sh <region> <startYear> <endYear> <seed> <tag>
# Writes runs/<tag>/{stdout.log, mem.log, time.txt, run.ccsr, *.json}.
set -uo pipefail

REPO=/Users/dantec/Developer/citycompass
SIM="$REPO/.scratch/urbanly-film/data/sim"
REGION="$1"; START="$2"; END="$3"; SEED="$4"; TAG="$5"
OUT="$SIM/runs/$TAG"
mkdir -p "$OUT"
cd "$REPO"

ENTRY="$SIM/dist-cli/simulate/index.js"

(
  while true; do
    line=$(ps -Awwo pid,rss,command | rg -F "$ENTRY" | rg -v " rg " | awk '{s+=$2} END {printf "%.0f", s/1024}')
    swap=$(sysctl -n vm.swapusage | awk '{print $6}')
    free=$(memory_pressure 2>/dev/null | awk -F': ' '/free percentage/ {print $2}')
    echo "$(date +%H:%M:%S) rss_mb=${line:-0} swap_used=$swap sys_free=$free"
    sleep 10
  done
) > "$OUT/mem.log" 2>&1 &
SAMPLER=$!

echo "start $(date '+%Y-%m-%d %H:%M:%S')" > "$OUT/time.txt"
CARPINCHO_WASM_DIR="$REPO/public/carpincho-wasm" \
/usr/bin/time -l node --max-semi-space-size=128 "$ENTRY" \
  --data-path "./public/$REGION" \
  --model land-use \
  --start-year "$START" --end-year "$END" \
  --seed "$SEED" \
  --accessibility-api-url wasm \
  --output-dir "$OUT" \
  --export-run "$OUT/run.ccsr" \
  > "$OUT/stdout.log" 2> "$OUT/stderr.log"
STATUS=$?
echo "end $(date '+%Y-%m-%d %H:%M:%S') exit=$STATUS" >> "$OUT/time.txt"
kill "$SAMPLER" 2>/dev/null
# /usr/bin/time -l writes its report to stderr, at the end.
tail -25 "$OUT/stderr.log" >> "$OUT/time.txt"
exit $STATUS
