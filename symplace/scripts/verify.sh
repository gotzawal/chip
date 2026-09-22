#!/usr/bin/env bash
# 끝에서 끝까지 확인한다: ALIGN 앞단 -> 우리 배치기 -> ALIGN 배선 -> GDS/DRC.
#
#   사용법:  ./scripts/verify.sh [예제 ...]
#   예:      ./scripts/verify.sh telescopic_ota
#
# 이건 **파이썬** 배치기(gpuplace) 경로다. 그쪽은 ALIGN 의 place 단계가 만든
# 구조(인스턴스 목록, 템플릿 선택)를 읽어 좌표만 덮어쓰므로 place 를 건너뛸 수 없다.
#
# JS 배치기(web/placer)는 다르다. 1_topology + 2_primitives 만 읽고 변이·반전·
# 영역을 직접 고른다:  cd web/placer && node test/place.mjs
#
# SA 반복은 ALIGN 기본값(10000)을 쓴다. 줄이면 place 가 79s -> 19s 로 빨라지지만
# 거기서 고르는 것이 좌표만이 아니다 — primitive 변이도 고른다. SA=10 으로 재보니
# 크기가 다른 변이(폭 420 vs 588)를 골라 DIFFERENT WIDTH DRC 가 2 건 났다.
# (ALIGN 단독은 SA=10 에서도 0 건이다. 우리 배치와 겹쳐야 드러난다.)
#   SA=10000  면적 1.00x  HPWL 0.99x  bbox 1440x11760  DRC 0
#   SA=10     면적 1.00x  HPWL 0.61x  bbox 1840x11760  DRC 2   <- HPWL 이 좋아 보이는 건
#                                                                 기준선이 나빠진 탓이다
# 굳이 줄이려면 SA=... 로 덮어쓰되, DRC 를 꼭 확인해라.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck disable=SC1091
source "$ROOT/env.sh" >/dev/null

BATCH=${BATCH:-1024}
ITERS=${ITERS:-1200}
SA=${SA:-10000}

EX=("$@")
[ ${#EX[@]} -eq 0 ] && EX=(five_transistor_ota current_mirror_ota telescopic_ota
                           high_speed_comparator cascode_current_mirror_ota)

for e in "${EX[@]}"; do
  echo "=================================================================="
  echo "### $e"
  OUT=$ALIGN_WORK/$e
  if [ ! -d "$OUT/3_pnr/Results" ] || \
     [ -z "$(ls "$OUT"/3_pnr/Results/*.scaled_placement_verilog.json 2>/dev/null)" ]; then
    echo "  [1/3] ALIGN 앞단 + place (SA=$SA)"
    rm -rf "$OUT"; mkdir -p "$OUT"; ( cd "$OUT" &&
      timeout -s KILL 900 schematic2layout.py "$ALIGN_EXAMPLES/$e" -p "$ALIGN_PDK" \
        -w "$OUT" --flow_stop 3_pnr:place --placer_sa_iterations "$SA" > front.log 2>&1 ) \
      || { echo "  앞단 실패 — $OUT/front.log 를 봐라"; continue; }
  else
    echo "  [1/3] ALIGN 앞단 — 이미 있음 (다시 돌리려면 $OUT 를 지워라)"
  fi

  echo "  [2/3] 우리 배치기 (시작점 $BATCH x $ITERS)"
  ( cd "$ROOT" && python -m gpuplace.m2 "$e" --batch "$BATCH" --iters "$ITERS" \
      --n-legal 16 --emit 2>&1 | grep -E '블록|최선 \(|배선용 출력|배선 격자' )

  OURS=$ALIGN_WORK/${e}_ours
  if [ ! -d "$OURS" ]; then echo "  배치 출력 없음 — 배선 생략"; continue; fi

  echo "  [3/3] ALIGN 배선"
  ( cd "$OURS" && timeout -s KILL 900 schematic2layout.py "$ALIGN_EXAMPLES/$e" \
      -p "$ALIGN_PDK" -w "$OURS" --flow_start 3_pnr:route > route.log 2>&1 ) && rc=0 || rc=$?

  gds=$(ls "$OURS"/*.gds 2>/dev/null | grep -v python | head -1)
  err=$(cat "$OURS"/3_pnr/*.errors 2>/dev/null | grep -c . || echo 0)
  if [ -n "$gds" ]; then
    echo "  배선 OK   GDS $(du -h "$gds" | cut -f1)   DRC/LVS 에러 $err"
  else
    echo "  배선 실패 (rc=$rc)"; tail -3 "$OURS/route.log" | sed 's/^/    | /'
  fi
done
echo "=================================================================="
