#!/usr/bin/env bash
# 메모리 패치의 효과를 직접 재본다 (patches/README.md 의 표를 재현).
#
#   사용법:  ./scripts/measure-memory.sh [예제 ...]
#
# 패치본과 원본(.orig)을 번갈아 끼우며 배선 단계의 peak RSS 를 잰다.
# setup.sh 가 원본을 *.orig 로 남겨두었어야 하고, 잴 예제는 align-baseline.sh 가
# $ALIGN_WORK/<예제> 에 앞단·배치까지 돌려 두었어야 한다 (배선 단계만 다시 돈다).
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck disable=SC1091
source "$ROOT/env.sh" >/dev/null
SP=$(python -c 'import align,os;print(os.path.dirname(align.__file__))')

for f in placer router; do
  [ -f "$SP/pnr/$f.py.orig" ] || { echo "원본이 없다: $SP/pnr/$f.py.orig"; exit 1; }
  [ -f "$SP/pnr/$f.py.patched" ] || cp -a "$SP/pnr/$f.py" "$SP/pnr/$f.py.patched"
done
use() { for f in placer router; do cp -f "$SP/pnr/$f.py.$1" "$SP/pnr/$f.py"; done; }
trap 'use patched' EXIT

EX=("$@")
[ ${#EX[@]} -eq 0 ] && EX=(telescopic_ota high_speed_comparator cascode_current_mirror_ota)

one() {  # $1 = 예제
  local e="$1" OUT=$ALIGN_WORK/$e
  [ -d "$OUT/3_pnr" ] || { printf "  %-28s ALIGN 출력 없음 (align-baseline.sh 를 먼저)\n" "$e"; return; }
  cd "$OUT" || return
  rm -f "$OUT"/*.gds "$OUT"/3_pnr/*.errors 2>/dev/null
  local t0 hwm=0 wrap real
  t0=$(date +%s)
  timeout -s KILL 900 schematic2layout.py "$ALIGN_EXAMPLES/$e" -p "$ALIGN_PDK" \
      -w "$OUT" --flow_start 3_pnr:route > mem.log 2>&1 &
  wrap=$!; real=""
  for _ in $(seq 1 100); do real=$(pgrep -P $wrap 2>/dev/null | head -1); [ -n "$real" ] && break; sleep 0.05; done
  while kill -0 $wrap 2>/dev/null; do
    v=$(awk '/^VmHWM/{print $2}' "/proc/${real:-$wrap}/status" 2>/dev/null)
    [ -n "${v:-}" ] && [ "$v" -gt "$hwm" ] && hwm=$v
    sleep 0.2
  done
  wait $wrap 2>/dev/null
  local gds err
  gds=$(ls "$OUT"/*.gds 2>/dev/null | grep -v python | head -1)
  err=$(cat "$OUT"/3_pnr/*.errors 2>/dev/null | grep -c . || echo 0)
  printf "  %-28s peak %7s MB  %3ss  GDS %6s  DRC %s\n" \
    "$e" "$((hwm / 1024))" "$(( $(date +%s) - t0 ))" \
    "$([ -n "$gds" ] && du -h "$gds" | cut -f1 || echo 없음)" "$err"
}

echo "=== 패치 전 (원본) ==="
use orig;    for e in "${EX[@]}"; do one "$e"; done
echo "=== 패치 후 ==="
use patched; for e in "${EX[@]}"; do one "$e"; done
