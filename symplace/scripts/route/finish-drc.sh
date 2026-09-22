#!/usr/bin/env bash
# 남은 DRC 를 순서대로 닫는다 (동시에 돌리면 WSL 이 버겁다).
#   1. cascode 기준선
#   2. hsc 우리 배치 배선
#   3. hsc 기준선
#   4. 표
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# 환경은 꾸러미면 env.sh, 소스 트리면 align-env.sh 다 (둘 다 같은 깊이).
for e in "$ROOT/env.sh" "$ROOT/align-env.sh"; do
  [ -f "$e" ] && { . "$e" >/dev/null 2>&1; break; }
done
SPIKES=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

S=$SPIKES

echo "### 1/3 cascode 기준선"
bash "$S/route-align.sh" cascode_current_mirror_ota 1200 2>&1 | tail -5

echo
echo "### 2/3 hsc 우리 배치"
bash "$S/route-js.sh" high_speed_comparator 1200 2>&1 | sed -n '/\[4\/5\]/,$p' | head -14

echo
echo "### 3/3 hsc 기준선"
bash "$S/route-align.sh" high_speed_comparator 1200 2>&1 | tail -5

echo
echo "=================================================================="
bash "$S/drc-sum.sh"
echo "FINISH_DRC_DONE"
