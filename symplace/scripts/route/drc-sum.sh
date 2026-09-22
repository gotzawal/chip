#!/usr/bin/env bash
# 이미 돌려둔 결과들의 DRC 를 표로 낸다.
#   <예제>_js   우리 배치로 배선한 것
#   <예제>_base ALIGN 자신의 배치로 배선한 것 (기준선)
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# 환경은 꾸러미면 env.sh, 소스 트리면 align-env.sh 다 (둘 다 같은 깊이).
for e in "$ROOT/env.sh" "$ROOT/align-env.sh"; do
  [ -f "$e" ] && { . "$e" >/dev/null 2>&1; break; }
done
SPIKES=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
EX=("$@")
[ ${#EX[@]} -eq 0 ] && EX=(telescopic_ota current_mirror_ota five_transistor_ota
                           high_speed_comparator cascode_current_mirror_ota)

cnt() {   # 디렉터리 -> 에러 줄 수 (파일이 여러 개여도 합)
  local d=$1
  local n
  n=$(cat "$d"/3_pnr/*.errors "$d"/*.errors 2>/dev/null | grep -c . || true)
  echo "${n:-0}"
}
kinds() {
  cat "$1"/3_pnr/*.errors "$1"/*.errors 2>/dev/null \
    | sed 's/ (.*//' | sort | uniq -c | awk '{printf "%s×%s ", $1, $2" "$3}'
}
gds() {
  local g
  g=$(ls "$1"/*.gds 2>/dev/null | grep -v python | head -1)
  if [ -n "${g:-}" ]; then du -h "$g" | cut -f1; else echo "-"; fi
}

printf "%-28s | %-16s | %-16s\n" "예제" "우리 배치" "ALIGN 자신"
printf "%-28s-+-%-16s-+-%-16s\n" "----------------------------" "----------------" "----------------"
for e in "${EX[@]}"; do
  J=$ALIGN_WORK/${e}_js
  B=$ALIGN_WORK/${e}_base
  jg="-"; je="-"; bg="-"; be="-"
  [ -d "$J" ] && { jg=$(gds "$J"); je=$(cnt "$J"); }
  [ -d "$B" ] && { bg=$(gds "$B"); be=$(cnt "$B"); }
  printf "%-28s | GDS %-5s DRC %-4s | GDS %-5s DRC %-4s\n" "$e" "$jg" "$je" "$bg" "$be"
  if [ -d "$J" ] && [ "${je:-0}" != "0" ]; then
    printf "%-28s |   %s\n" "" "$(kinds "$J")"
  fi
done
echo
echo "DRC 는 SHORT / OPEN / DIFFERENT WIDTH 등을 모두 센 줄 수다."
echo "기준선과 같은 수면 우리 배치 탓이 아니다."
