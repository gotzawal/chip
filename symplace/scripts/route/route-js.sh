#!/usr/bin/env bash
# JS 배치기의 결과로 ALIGN 배선 -> GDS -> DRC 까지 간다.
#
#   route-js.sh <예제> [예산초]
#
# 흐름:
#   1. ALIGN 앞단 + place 를 한 번 돌려 작업 디렉터리를 만든다 (이미 있으면 건너뜀)
#   2. 그걸 <예제>_js 로 복사
#   3. 우리 좌표를 __placer_dump__.json 에 심는다
#   4. --flow_start 3_pnr:route 로 배선만 다시 돌린다
#   5. GDS 와 DRC 에러 수를 보고한다
set -u
EX=${1:?예제 이름}
BUDGET=${2:-900}
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# 환경은 꾸러미면 env.sh, 소스 트리면 align-env.sh 다 (둘 다 같은 깊이).
for e in "$ROOT/env.sh" "$ROOT/align-env.sh"; do
  [ -f "$e" ] && { . "$e" >/dev/null 2>&1; break; }
done
SPIKES=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

SRC=$ALIGN_WORK/$EX
DST=$ALIGN_WORK/${EX}_js
PLACE=$ROOT/web/placer/out/$EX.place.json

[ -f "$PLACE" ] || { echo "배치 결과가 없다: $PLACE"; echo "  node emit.mjs $EX 를 먼저 돌려라"; exit 1; }

# 1) 기준 작업 디렉터리
if [ ! -f "$SRC/3_pnr/__placer_dump__.json" ]; then
  echo "[1/5] ALIGN 앞단 + place (기준 디렉터리 만들기)"
  rm -rf "$SRC"; mkdir -p "$SRC"
  ( cd "$SRC" && timeout -s KILL 1800 schematic2layout.py "$ALIGN_EXAMPLES/$EX" \
      -p "$ALIGN_PDK" -w "$SRC" --flow_stop 3_pnr:place > front.log 2>&1 ) \
    || { echo "  실패 — $SRC/front.log"; tail -5 "$SRC/front.log"; exit 1; }
else
  echo "[1/5] 기준 디렉터리 이미 있음"
fi

# 2) 복사
echo "[2/5] $DST 로 복사"
rm -rf "$DST"; mkdir -p "$DST"
for sub in 1_topology 2_primitives 3_pnr; do
  [ -d "$SRC/$sub" ] && cp -a "$SRC/$sub" "$DST/$sub"
done

# 3) 주입
echo "[3/5] 우리 좌표 심기"
python3 "$ROOT/web/spikes/inject-js.py" "$PLACE" "$DST" || exit 1

# 4) 배선
echo "[4/5] ALIGN 배선 (예산 ${BUDGET}s)"
start=$(date +%s)
( cd "$DST" && timeout -s KILL "$BUDGET" schematic2layout.py "$ALIGN_EXAMPLES/$EX" \
    -p "$ALIGN_PDK" -w "$DST" --flow_start 3_pnr:route > route.log 2>&1 ) && rc=0 || rc=$?
el=$(( $(date +%s) - start ))

# 5) 결과
echo "[5/5] 결과 (rc=$rc, ${el}s)"
gds=$(ls "$DST"/*.gds 2>/dev/null | grep -v python | head -1)
if [ -n "${gds:-}" ]; then
  echo "  GDS  $(basename "$gds")  $(du -h "$gds" | cut -f1)"
else
  echo "  GDS 없음"
fi
echo "  --- DRC/LVS ---"
shopt -s nullglob
found=0
for f in "$DST"/3_pnr/*.errors "$DST"/*.errors; do
  n=$(grep -c . "$f" 2>/dev/null || echo 0)
  echo "    $(basename "$f")  에러 $n"
  [ "$n" -gt 0 ] && head -4 "$f" | sed 's/^/      | /'
  found=1
done
[ "$found" = 0 ] && echo "    .errors 파일 없음"
echo "  --- route.log 끝 ---"
tail -6 "$DST/route.log" 2>/dev/null | sed 's/^/    | /'
