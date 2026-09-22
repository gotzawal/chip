#!/usr/bin/env bash
# 앞단 출력(1_topology + 2_primitives)을 배치기 쪽으로 옮긴다.
# 변이 선택을 직접 하려면 place 단계 출력이 아니라 이쪽을 읽어야 한다.
set -eu
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# 환경은 꾸러미면 env.sh, 소스 트리면 align-env.sh 다 (둘 다 같은 깊이).
for e in "$ROOT/env.sh" "$ROOT/align-env.sh"; do
  [ -f "$e" ] && { . "$e" >/dev/null 2>&1; break; }
done
SPIKES=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DST=$ROOT/web/placer/fixtures/design
for W in "$@"; do
  name=$(basename "$W")
  [ -d "$W/2_primitives" ] || { echo "건너뜀 $W"; continue; }
  mkdir -p "$DST/$name"
  rm -f "$DST/$name"/*.json
  cp "$W"/1_topology/*.verilog.json "$DST/$name/" 2>/dev/null || true
  # *.gds.json 은 배선/GDS 단계의 기하라 배치기가 안 읽는다. 크기의 대부분이라 뺀다.
  for f in "$W"/2_primitives/*.json; do
    case "$f" in *.gds.json) continue;; esac
    cp "$f" "$DST/$name/"
  done

  # 대조용 place 결과. **최상위 모듈의 것**을 골라야 한다.
  # 그냥 head -1 을 쓰면 알파벳 순서로 하위 모듈이 집힌다 — cascode 에서
  # CASCODED_CMC_NMOS_...(하위, 4 블록)가 잡혀 기준선 면적이 13.6 배로 틀렸다.
  TOP=$(basename "$(ls "$W"/1_topology/*.verilog.json | head -1)" .verilog.json)
  p=$(ls "$W"/3_pnr/Results/"$TOP"_*.scaled_placement_verilog.json 2>/dev/null | head -1) || true
  if [ -n "${p:-}" ]; then
    cp "$p" "$DST/$name/__align_place__.json"
    echo "$name: top=$TOP  대조=$(basename "$p")  파일 $(ls "$DST/$name" | wc -l) 개"
  else
    echo "$name: top=$TOP  대조 없음  파일 $(ls "$DST/$name" | wc -l) 개"
  fi
done
