#!/bin/bash
# Все автотесты PolyPlayer. Нужны: node, npm ci в корне репозитория, playwright с chromium, ffmpeg, xvfb-run (для Electron).
cd "$(dirname "$0")"
[ -d media ] || ./make-media.sh
mkdir -p out
fails=0
# бюджет горячих документов (байты): CLAUDE.md ≤ 6000, STATUS.md ≤ 12000
for f in CLAUDE.md:6000 STATUS.md:12000; do n=${f%%:*}; l=${f##*:}; sz=$(wc -c < "../$n"); [ "$sz" -le "$l" ] || { echo "$n: $sz байт > $l — перенесите лишнее в dev/"; fails=$((fails+1)); }; done
for t in ui hotkeys midnight missing sched-edit choose robust app freeze e2e-electron; do
  printf '%-14s ' "$t"
  if env -u NODE_OPTIONS timeout 300 node "$t.js" > "out/$t.log" 2>&1 && grep -q "ALL PASSED" "out/$t.log"; then echo ok; else echo "FAIL (out/$t.log)"; fails=$((fails+1)); fi
done
[ $fails -eq 0 ] && echo "ALL PASSED" || { echo "$fails FAILED"; exit 1; }
