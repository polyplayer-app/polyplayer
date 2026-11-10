#!/bin/bash
# Все автотесты PolyPlayer. Нужны: node, npm ci в корне репозитория, playwright с chromium, ffmpeg, xvfb-run (для Electron).
cd "$(dirname "$0")"
[ -d media ] || ./make-media.sh
mkdir -p out
fails=0
for t in ui hotkeys midnight missing sched-edit choose robust app freeze e2e-electron; do
  printf '%-14s ' "$t"
  if env -u NODE_OPTIONS timeout 300 node "$t.js" > "out/$t.log" 2>&1 && grep -q "ALL PASSED" "out/$t.log"; then echo ok; else echo "FAIL (out/$t.log)"; fails=$((fails+1)); fi
done
[ $fails -eq 0 ] && echo "ALL PASSED" || { echo "$fails FAILED"; exit 1; }
