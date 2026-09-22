#!/usr/bin/env bash
# JS 배치기 -> ALIGN 배선 -> GDS -> DRC 를 여러 예제에 대해 돌리고,
# ALIGN 자신의 배치로도 같은 흐름을 돌려 **기준선과 나란히** 보고한다.
#
# 기준선을 같이 재지 않으면 "DRC 에러 4건"이 우리 탓인지 알 수 없다.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# 환경은 꾸러미면 env.sh, 소스 트리면 align-env.sh 다 (둘 다 같은 깊이).
for e in "$ROOT/env.sh" "$ROOT/align-env.sh"; do
  [ -f "$e" ] && { . "$e" >/dev/null 2>&1; break; }
done
SPIKES=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
EX=("$@")
[ ${#EX[@]} -eq 0 ] && EX=(telescopic_ota current_mirror_ota five_transistor_ota)

err_of() {
  local d=$1 tot=0
  shopt -s nullglob
  for f in "$d"/3_pnr/*.errors "$d"/*.errors; do
    tot=$((tot + $(grep -c . "$f" 2>/dev/null || echo 0)))
  done
  echo "$tot"
}
kinds_of() {
  shopt -s nullglob
  cat "$1"/3_pnr/*.errors "$1"/*.errors 2>/dev/null \
    | sed 's/(.*//' | sort | uniq -c | tr '\n' ' '
}
gds_of() {
  local g
  g=$(ls "$1"/*.gds 2>/dev/null | grep -v python | head -1)
  [ -n "${g:-}" ] && du -h "$g" | cut -f1 || echo "-"
}

for e in "${EX[@]}"; do
  echo "=================================================================="
  echo "### $e"
  # 1) 우리 배치 내보내기
  ( cd "$ROOT/web/placer" && node emit.mjs "$e" --batch 96 ) || { echo "  emit 실패"; continue; }
  # 2) 우리 배치로 배선
  bash "$ROOT/web/spikes/route-js.sh" "$e" 900 2>&1 | sed -n '/\[3\/5\]/,$p' | sed 's/^/  /'
  # 3) ALIGN 자신으로 배선 (기준선)
  bash "$ROOT/web/spikes/route-align.sh" "$e" 900 >/dev/null 2>&1

  J=$ALIGN_WORK/${e}_js
  B=$ALIGN_WORK/${e}_base
  echo "  ------------------------------------------------------------"
  printf "  %-12s GDS %-6s DRC %-4s %s\n" "ALIGN 자신" "$(gds_of "$B")" "$(err_of "$B")" "$(kinds_of "$B")"
  printf "  %-12s GDS %-6s DRC %-4s %s\n" "우리 배치" "$(gds_of "$J")" "$(err_of "$J")" "$(kinds_of "$J")"
done
echo "=================================================================="
echo "DRC_ALL_DONE"
