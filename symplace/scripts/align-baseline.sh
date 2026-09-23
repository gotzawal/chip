#!/usr/bin/env bash
# 네이티브 ALIGN 으로 예제 하나를 끝까지 돌리고(앞단 -> 배치 -> 배선), 그 결과를 저장소의 **비교 기준선**으로 담는다.
#
#   사용법:  ./scripts/align-baseline.sh <예제> [--label "이름표"]
#   예:      ./scripts/align-baseline.sh switched_capacitor_filter --label "Switched-Capacitor Filter"
#
# 하는 일
#   1. schematic2layout.py $ALIGN_EXAMPLES/<예제> -w $ALIGN_WORK/<예제>     (결과가 있으면 건너뛴다)
#   2. node web/placer/pack-example.mjs $ALIGN_WORK/<예제> <예제> --label ...
#        -> data/<예제>.json (앞단 출력 + ALIGN 배치), data/<예제>.leaves.json (리프 도형), data/index.json,
#           routed/<예제>.align.json + routed/index.json (ALIGN 배선 기하와 DRC/LVS 문구)
#   3. netlists/<예제>.sp (+ .const.json) 복사 — 페이지의 "회로 올리기"에 그대로 넣어 볼 수 있게
#
# 네이티브 ALIGN 은 여기서 **기준선을 만들 때만** 쓴다. 페이지의 배치는 우리 배치기(src/*.mjs), 배선은 ALIGN 배선기를
# 옮긴 것(symplace/alignroute)이다. ALIGN 배선 단계의 메모리는 setup.sh 가 적용한 패치(patches/)로 1.5 GB 안쪽이다.
#
# ALIGN 의 배치 담금질(SA) 반복은 기본값(10000)을 쓴다. 줄이면 빨라지지만 다른 변이를 골라 기준선이 나빠지고
# DRC 가 늘 수 있다 (telescopic_ota: SA=10 이면 HPWL 0.61x 처럼 보이지만 기준선이 나빠진 것이고 DRC 2 건).
set -eu
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SITE=$(cd "$ROOT/.." && pwd)
# shellcheck disable=SC1091
source "$ROOT/env.sh" >/dev/null
e=${1:?예제 이름을 줘라 (예: telescopic_ota)}; shift
OUT=$ALIGN_WORK/$e

if [ -z "$(ls "$OUT"/3_pnr/*_0.json 2>/dev/null)" ]; then
  echo "  [1/3] ALIGN 앞단 + 배치 + 배선  -> $OUT  (로그 $OUT/align.log)"
  rm -rf "$OUT"; mkdir -p "$OUT"
  ( cd "$OUT" && timeout -s KILL 1800 schematic2layout.py "$ALIGN_EXAMPLES/$e" -p "$ALIGN_PDK" \
      -w "$OUT" --placer_sa_iterations "${SA:-10000}" > align.log 2>&1 ) \
    || { echo "  ALIGN 실패 — $OUT/align.log 를 봐라"; exit 1; }
else
  echo "  [1/3] ALIGN 결과 있음 — $OUT (다시 돌리려면 지워라)"
fi

echo "  [2/3] 예제 파일 묶기"
node "$ROOT/web/placer/pack-example.mjs" "$OUT" "$e" "$@"

echo "  [3/3] 넷리스트 복사"
mkdir -p "$SITE/netlists"
cp "$ALIGN_EXAMPLES/$e/$e.sp" "$SITE/netlists/$e.sp"
if [ -f "$ALIGN_EXAMPLES/$e/$e.const.json" ]; then
  cp "$ALIGN_EXAMPLES/$e/$e.const.json" "$SITE/netlists/$e.const.json"
else
  echo "  (제약 파일 없음 — $e.const.json)"
fi
echo "끝. 확인:  node symplace/web/placer/test/leaves.mjs && node symplace/web/placer/test/place.mjs $e && node symplace/scripts/route/node/newroute.mjs $e"
