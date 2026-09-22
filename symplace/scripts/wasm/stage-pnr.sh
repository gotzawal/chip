#!/usr/bin/env bash
set -eu
# 이 저장소의 위치. env.sh 가 없으면 직접 넣어라.
: "${ALIGN_SRC:=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
source "${ALIGN_ENV:-$ALIGN_SRC/env.sh}" >/dev/null 2>&1
S=$ALIGN_SRC/scripts/wasm
W=$S/pnr
rm -rf "$W"; mkdir -p "$W"
python3 "$S/retag-wheel.py" ~/pnrwasm/dist/*pyemscripten*.whl emscripten_3_1_58_wasm32
cp ~/pnrwasm/dist/*emscripten_3_1_58*.whl "$W/"
# PDK 도 같이 (ReadPDKJSON 시험용)
cp ${ALIGN_REPO:-$ALIGN_SRC/ALIGN-public}/pdks/FinFET14nm_Mock_PDK/layers.json "$W/"
cd "$W" && ls *.whl > list.txt && cat list.txt && du -h *.whl | cut -f1
