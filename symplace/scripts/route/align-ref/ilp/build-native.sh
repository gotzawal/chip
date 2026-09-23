#!/usr/bin/env bash
# harness.cpp 를 네이티브로 빌드한다 (lp_solve 5.5.2.11 을 같이 — 소스는 wasi/build.sh 가 받아 둔 것).
# -DREALXP=__float128: lp_solve 의 long double 누산을 binary128 로 — 기준 wasm 과 비트까지 같아진다.
#
#   ./build-native.sh                       -> ~/.cache/symplace/lpsolve-wasi/native/harness
#   DUMP=lps.jsonl .../harness 1 12 400     씨앗 1..399, 넷 12 개짜리 합성 ILP 를 lps.jsonl 에 덧붙인다
set -eu
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
W=${LPSOLVE_WASI:-$HOME/.cache/symplace/lpsolve-wasi}
LP=$W/lp_solve_5.5
[ -d "$LP" ] || "$HERE/wasi/build.sh"
mkdir -p "$W/native" && cd "$W/native"
FILES="lp_MDO.c shared/commonlib.c shared/mmio.c shared/myblas.c ini.c fortify.c colamd/colamd.c
       lp_rlp.c lp_crash.c bfp/bfp_LUSOL/lp_LUSOL.c bfp/bfp_LUSOL/LUSOL/lusol.c lp_Hash.c lp_lib.c
       lp_wlp.c lp_matrix.c lp_mipbb.c lp_MPS.c lp_params.c lp_presolve.c lp_price.c lp_pricePSE.c
       lp_report.c lp_scale.c lp_simplex.c lp_SOS.c lp_utils.c yacc_read.c"
INC="-I$LP -I$LP/shared -I$LP/bfp -I$LP/bfp/bfp_LUSOL -I$LP/bfp/bfp_LUSOL/LUSOL -I$LP/colamd"
DEFS="-DYY_NEVER_INTERACTIVE -DPARSER_LP -DINVERSE_ACTIVE=INVERSE_LUSOL -DRoleIsExternalInvEngine
      -DLoadInverseLib=0 -DLoadLanguageLib=0 -DREALXP=__float128"
OBJS=""
for c in $FILES; do
  o="$(basename "${c%.c}").o"
  # shellcheck disable=SC2086
  gcc -O2 -ffp-contract=off -w $INC $DEFS -c "$LP/$c" -o "$o"
  OBJS="$OBJS $o"
done
# shellcheck disable=SC2086
g++ -O2 -std=c++14 -ffp-contract=off -w $INC $DEFS "$HERE/harness.cpp" $OBJS -o harness -lm -ldl
echo "  $W/native/harness"
