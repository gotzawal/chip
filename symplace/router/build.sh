#!/usr/bin/env bash
# 배선기를 wasm 으로 빌드해 src/route/router.wasm 에 둔다 (페이지와 node 가 같은 파일을 쓴다).
#   symplace/router/build.sh
set -euo pipefail
cd "$(dirname "$0")"
cargo build --release --target wasm32-unknown-unknown --lib
cp target/wasm32-unknown-unknown/release/symroute.wasm ../../src/route/router.wasm
ls -l ../../src/route/router.wasm
