#!/usr/bin/env bash
# alignroute 를 wasm 으로 빌드해 src/route/alignroute.wasm 에 둔다 (페이지와 node 시험이 같은 파일을 쓴다).
#   symplace/alignroute/build.sh          릴리스 (LTO)
#   symplace/alignroute/build.sh --dev    결과는 같고 빌드만 빠르다 (개발 중)
# lp_solve 소스가 없으면 먼저 fetch-lpsolve.sh 를 돌린다.
set -euo pipefail
cd "$(dirname "$0")"
[ -f "${LPSOLVE_SRC:-$HOME/.cache/symplace/lpsolve-wasi/lp_solve_5.5}/lp_lib.c" ] || ./fetch-lpsolve.sh
prof=release
[ "${1:-}" = "--dev" ] && prof=fast
cargo build --profile "$prof" --target wasm32-wasip1 --lib
cp "target/wasm32-wasip1/$prof/alignroute.wasm" ../../src/route/alignroute.wasm
ls -l ../../src/route/alignroute.wasm | awk '{print $5, $9}'
