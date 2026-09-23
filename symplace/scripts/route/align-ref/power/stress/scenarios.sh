#!/usr/bin/env bash
# 전원 격자·전원 배선(모드 2·3) 막기 시험 덤프를 다시 뜬다 -> ~/.cache/symplace/tap-stress/<예제>/<시험>/
# (예제마다 우리 배치, 도형은 Nets[0].path_metal 에 RouteWork(2) 바로 앞에 끼운다: tap_stress.py)
#
#   obst     M6 한 줄 + 왼아래가 같은 M5 둘   격자 꼭짓점이 꺼진다 (5 개)
#   split    가로로 전체를 덮는 M5            VDD/GND 격자가 쪼개져 가장 큰 덩이만 남는다
#   m6bug    좁은 M6 (x 범위에 격자 x 없음)   가로층 되돌림 버릇(newLLy)으로 한 줄이 통째로 꺼진다
#   label3   M3 (핀 위 두 칸)                 가운데 토막 늘리기 label 3 — 세로층 ExtendY_PN(P=0)
#   label2   M3 (핀 아래 두 칸)               label 2
#   pinfail  M3 로 VDD 핀을 덮는다            출발점이 없어 그 핀은 못 잇는다
#   dedupe   왼아래가 같은 M3 둘              Findset 이 같은 모서리 접점을 하나만 남긴다 (길이 바뀐다)
#
# 대조: node symplace/web/placer/test/alignroute.mjs --tap=$HOME/.cache/symplace/tap-stress --stage=2,23
set -euo pipefail
cd "$(dirname "$0")/../../../../../.."
ST=symplace/scripts/route/align-ref/power/stress/stress.mjs
OUT=${STRESS_OUT:-$HOME/.cache/symplace/tap-stress}
run() {  # 예제 시험 도형
  mkdir -p "$OUT/$1"
  node "$ST" "$1" "$OUT/$1/$2" "$3" > "$OUT/$1/$2.log" 2>&1
  mv "$OUT/$1/$2.log" "$OUT/$1/$2/stress.log"
  echo "$3" > "$OUT/$1/$2/shapes.json"
  echo "$1/$2: $(grep '^ok' "$OUT/$1/$2/stress.log")"
}
C=cascode_current_mirror_ota
run $C obst '[["M6",5,3000,8000,7000,8128],["M5",4,6848,12500,6976,13800],["M5",4,6848,12500,6976,15000]]'
run $C split '[["M5",4,0,10300,12800,11800]]'
run $C m6bug '[["M6",5,1000,8000,1100,8128]]'
run $C label3 '[["M3",2,4600,1480,4680,1544]]'
run $C label2 '[["M3",2,4600,808,4680,872]]'
run $C pinfail '[["M3",2,6360,5136,6440,8304]]'
run $C dedupe '[["M3",2,4600,500,4680,600],["M3",2,4600,500,4680,1008]]'
run high_speed_comparator m6bug '[["M6",5,1000,10016,1100,10144]]'
