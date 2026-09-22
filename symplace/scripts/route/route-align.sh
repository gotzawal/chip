#!/usr/bin/env bash
# ALIGN 자신의 배치로 배선을 돌려 DRC 기준선을 만든다.
# 우리 것과 같은 조건이어야 비교가 된다 (같은 대안 0, 같은 흐름).
set -u
EX=${1:?예제}
BUDGET=${2:-900}
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# 환경은 꾸러미면 env.sh, 소스 트리면 align-env.sh 다 (둘 다 같은 깊이).
for e in "$ROOT/env.sh" "$ROOT/align-env.sh"; do
  [ -f "$e" ] && { . "$e" >/dev/null 2>&1; break; }
done
SPIKES=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

SRC=$ALIGN_WORK/$EX
DST=$ALIGN_WORK/${EX}_base
[ -f "$SRC/3_pnr/__placer_dump__.json" ] || { echo "기준 디렉터리가 없다: $SRC"; exit 1; }

echo "[1/3] $DST 로 복사"
rm -rf "$DST"; mkdir -p "$DST"
for sub in 1_topology 2_primitives 3_pnr; do
  [ -d "$SRC/$sub" ] && cp -a "$SRC/$sub" "$DST/$sub"
done
# place 에서 끊으면 gui 단계가 쓰는 이 파일이 없다. 우리 쪽과 똑같이 넣어준다.
echo '[0]' > "$DST/3_pnr/__placements_to_run__.json"

echo "[2/3] ALIGN 배선 (예산 ${BUDGET}s)"
start=$(date +%s)
( cd "$DST" && timeout -s KILL "$BUDGET" schematic2layout.py "$ALIGN_EXAMPLES/$EX" \
    -p "$ALIGN_PDK" -w "$DST" --flow_start 3_pnr:route > route.log 2>&1 ) && rc=0 || rc=$?
echo "[3/3] rc=$rc  $(( $(date +%s) - start ))s"
gds=$(ls "$DST"/*.gds 2>/dev/null | grep -v python | head -1)
[ -n "${gds:-}" ] && echo "  GDS $(basename "$gds") $(du -h "$gds" | cut -f1)" || echo "  GDS 없음"
shopt -s nullglob
for f in "$DST"/3_pnr/*.errors "$DST"/*.errors; do
  echo "  $(basename "$f")  에러 $(grep -c . "$f" 2>/dev/null || echo 0)"
done
tail -4 "$DST/route.log" | sed 's/^/    | /'
