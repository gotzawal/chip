#!/usr/bin/env bash
# lp_solve 5.5.2.11 (ALIGN 이 고정한 판) 을 clang 으로 wasm32-wasi 에 빌드하고, 시험 구동기(drv.c)를
# 링크한다. 전역 배선의 ILP 를 기준 휠(emscripten 3.1.58) 의 lp_solve 와 같은 답으로 푸는지 보려는 것이다.
#
#   ./build.sh                     -> ~/.cache/symplace/lpsolve-wasi/lptest.wasm
#   python3 check.py lps.jsonl ref.jsonl   (lps.jsonl: ../harness.cpp 가 DUMP= 로 쓴 것,
#                                           ref.jsonl: ../wasm_lp.mjs 가 기준 휠로 푼 것)
#
# 필요한 것: clang 18 (wasm32 대상), wasm-ld, apt 의 wasi-libc 와 libclang-rt-18-dev-wasm32.
# wasm32 의 long double 은 binary128 이라 기준(emscripten)과 같다 — x86-64 네이티브(80 비트)와 다르다.
set -eu
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
W=${LPSOLVE_WASI:-$HOME/.cache/symplace/lpsolve-wasi}
mkdir -p "$W/obj" && cd "$W"

TGZ=lp_solve_5.5.2.11_source.tar.gz
[ -f "$TGZ" ] || curl -sSL -o "$TGZ" "https://sourceforge.net/projects/lpsolve/files/lpsolve/5.5.2.11/$TGZ/download"
echo "a829a8d9c60ff81dc72ff52363703886  $TGZ" | md5sum -c - >/dev/null   # ALIGN thirdparty/lpsolve.cmake 의 MD5
[ -d lp_solve_5.5 ] || tar xzf "$TGZ"
LP=$W/lp_solve_5.5

# ALIGN thirdparty/CMakeLists.lpsolve 의 목록에서 LP 파일 읽기(lp_rlp.c, yacc_read.c)만 뺀다.
# 둘은 setjmp 가 있어야 하고 ALIGN 은 부르지 않는다. lp_lib.c 가 찾는 이름은 stubs.c 가 채운다.
FILES="lp_MDO.c shared/commonlib.c shared/mmio.c shared/myblas.c ini.c fortify.c colamd/colamd.c
       lp_crash.c bfp/bfp_LUSOL/lp_LUSOL.c bfp/bfp_LUSOL/LUSOL/lusol.c lp_Hash.c lp_lib.c lp_wlp.c
       lp_matrix.c lp_mipbb.c lp_MPS.c lp_params.c lp_presolve.c lp_price.c lp_pricePSE.c lp_report.c
       lp_scale.c lp_simplex.c lp_SOS.c lp_utils.c"
# 기준 빌드(symplace/scripts/wasm/build-pnr-wasm.sh)와 같은 정의. 다른 것:
#   shim/dlfcn.h        wasm 에는 dlopen 이 없다 — myblas.h 가 LoadableBlasLib 를 늘 켜므로 실패하는
#                       dlopen 을 준다. 기준도 BLAS 적재에 실패하고 내장 BLAS 를 쓴다 (PLAN-route.md 2 절).
#   _WASI_EMULATED_SIGNAL  lp_lib.c 의 #include <signal.h>
#   -ffp-contract=off   곱셈-덧셈 합치기 금지 (wasm 에는 FMA 가 없지만 분명히 해 둔다)
CFLAGS="--target=wasm32-wasi --sysroot=/usr -isystem $HERE/shim -isystem /usr/include/wasm32-wasi
        -O2 -ffp-contract=off -D_WASI_EMULATED_SIGNAL
        -I$LP -I$LP/shared -I$LP/bfp -I$LP/bfp/bfp_LUSOL -I$LP/bfp/bfp_LUSOL/LUSOL -I$LP/colamd
        -DYY_NEVER_INTERACTIVE -DPARSER_LP -DINVERSE_ACTIVE=INVERSE_LUSOL -DRoleIsExternalInvEngine
        -DLoadInverseLib=0 -DLoadLanguageLib=0"
OBJS=""
for c in $FILES; do
  o="obj/$(basename "${c%.c}").o"
  # shellcheck disable=SC2086
  clang $CFLAGS -w -c "$LP/$c" -o "$o"
  OBJS="$OBJS $o"
done
# shellcheck disable=SC2086
clang $CFLAGS -c "$HERE/drv.c" -o obj/drv.o
# shellcheck disable=SC2086
clang $CFLAGS -c "$HERE/stubs.c" -o obj/stubs.o
# shellcheck disable=SC2086
wasm-ld -o lptest.wasm /usr/lib/wasm32-wasi/crt1-command.o obj/drv.o obj/stubs.o $OBJS \
  -L/usr/lib/wasm32-wasi -lc -lm -lwasi-emulated-signal \
  /usr/lib/llvm-18/lib/clang/18/lib/wasi/libclang_rt.builtins-wasm32.a --gc-sections --strip-all
ls -l "$W/lptest.wasm" | awk '{print "  " $9, $5, "bytes"}'
