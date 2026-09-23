#!/usr/bin/env bash
# ALIGN 원본 C++ 전역+상세 배선기(RouteWork 4, 5)를 네이티브로 빌드한다 — alignroute/src/dr 의 차분 시험 기준 (oracle5).
#
#   ./build-oracle.sh            -> ~/.cache/symplace/dr-oracle/oracle5
#   DR_TRACE=1 oracle5 <토큰>    SortPinsOrder 뒤 순서, 연결마다 꺼진 꼭짓점·출발·도착·A* 경로를 stderr 로
#                                 (trace.patch — Rust 쪽도 네이티브 빌드에서 DR_TRACE 로 같은 줄을 낸다)
#
# 원본은 $ALIGN_REPO/PlaceRouteHierFlow/router 를 고치지 않고 쓴다 (GcellDetailRouter.cpp 만 복사해 trace.patch).
# lp_solve 는 alignroute 네이티브 빌드(cargo build --release)가 만든 liblpsolve.a 를 쓴다.
# 기준 wasm 은 emscripten libc++ 18 — std::sort 가 같도록 clang++ -stdlib=libc++ (18) 로 빌드한다.
set -eu
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
AR=$(cd "$HERE/../../../../alignroute" && pwd)
R=${ALIGN_REPO:-$(cd "$AR/.." && pwd)/ALIGN-public}/PlaceRouteHierFlow/router   # env.sh 와 같은 기본값
LP=${LPSOLVE_SRC:-$HOME/.cache/symplace/lpsolve-wasi/lp_solve_5.5}
OUT=${DR_ORACLE_DIR:-$HOME/.cache/symplace/dr-oracle}
[ -f "$R/GcellDetailRouter.cpp" ] || { echo "ALIGN 원본이 없다: $R (ALIGN_REPO 를 맞춰라)"; exit 1; }
LIB=$(ls -d "$AR"/target/release/build/alignroute-*/out/liblpsolve.a 2>/dev/null | head -1)
[ -n "$LIB" ] || { echo "liblpsolve.a 가 없다 — 먼저 (cd $AR && cargo build --release)"; exit 1; }
mkdir -p "$OUT/run"
cd "$OUT"
cp "$R/GcellDetailRouter.cpp" GcellDetailRouter_tr.cpp
patch -s GcellDetailRouter_tr.cpp "$HERE/trace.patch"
INC="-I$HERE/stub -I$R -I$LP -I$LP/shared -I$LP/bfp -I$LP/bfp/bfp_LUSOL -I$LP/bfp/bfp_LUSOL/LUSOL -I$LP/colamd"
DEFS="-DYY_NEVER_INTERACTIVE -DPARSER_LP -DINVERSE_ACTIVE=INVERSE_LUSOL -DRoleIsExternalInvEngine -DLoadInverseLib=0 -DLoadLanguageLib=0 -DREALXP=__float128 -DNDEBUG"
# shellcheck disable=SC2086
CXX="clang++ -stdlib=libc++ -O1 -g -std=c++17 -ffp-contract=off -w $INC $DEFS"
pids=()
$CXX -Dget_variables=oracle_get_variables -c "$R/GcellGlobalRouter.cpp" -o GcellGlobalRouter.o & pids+=($!)
for f in GlobalGrid GlobalGraph RawRouter Grid A_star Graph; do
  $CXX -c "$R/$f.cpp" -o $f.o & pids+=($!)
done
$CXX -c GcellDetailRouter_tr.cpp -o GcellDetailRouter.o & pids+=($!)
$CXX -c "$HERE/oracle5.cpp" -o oracle5.o & pids+=($!)
for p in "${pids[@]}"; do wait "$p"; done
clang++ -stdlib=libc++ -o oracle5 oracle5.o GcellGlobalRouter.o GlobalGrid.o GlobalGraph.o RawRouter.o GcellDetailRouter.o Grid.o A_star.o Graph.o \
  "$LIB" -lm -ldl -lquadmath
echo "$OUT/oracle5"
