#!/usr/bin/env bash
# libz3 를 Pyodide 가 dlopen 할 수 있는 wasm side module 로 빌드한다.
#
# 왜 필요한가:
#   ALIGN 의 align/schema/checker.py 첫 줄이 `import z3` 이고,
#   ConstraintDB.append() 가 제약마다 verify() 를 부른다 (끌 플래그 없음).
#   z3 없이는 `import align.schema` 자체가 실패한다.
#   Pyodide 에는 z3-solver 휠이 없다. 직접 빌드해야 한다.
#
# 네 번 헛짚고 얻은 설정이다. 각 줄의 이유가 아래에 있다.
#
#   사용법:  ./scripts/build-z3-pyodide.sh [출력디렉터리]
#   결과:    <출력>/libz3.so  (약 17MB)  +  <출력>/py/*.py
set -eu
OUT=${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/web/z3}
WORK=${Z3_WORK:-$HOME/z3build}
EMSDK=${EMSDK_DIR:-$HOME/emsdk}

# --- Pyodide 가 고정한 것들 ---------------------------------------------
# Pyodide 0.28.3 에서 확인한 값:
#   platform emscripten-4.0.9-wasm32, python 3.13.2
#   pyodide.asm.wasm 이 env.__cpp_exception / env.__c_longjmp 태그를 import
#   -> 본체가 -fwasm-exceptions 로 빌드됨. side module 도 같아야 한다.
EM_VER=${EM_VER:-4.0.9}
# z3 파이썬 바인딩(z3core.py)은 심볼 서명을 버전에 묶어 두므로,
# pip 의 z3-solver 와 **같은 버전**을 빌드해야 그 파일들을 그대로 쓸 수 있다.
Z3_TAG=${Z3_TAG:-z3-5.1.0}

say() { printf "\n\033[1m== %s\033[0m\n" "$*"; }

say "1. emscripten $EM_VER"
if [ ! -d "$EMSDK" ]; then
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$EMSDK"
fi
( cd "$EMSDK" && ./emsdk install "$EM_VER" && ./emsdk activate "$EM_VER" )
# shellcheck disable=SC1091
source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1
emcc --version | head -1 | sed 's/^/  /'

say "2. z3 $Z3_TAG"
mkdir -p "$WORK"; cd "$WORK"
[ -d z3 ] || git clone -q https://github.com/Z3Prover/z3.git z3
( cd z3 && git fetch -q --tags --depth 1 origin "$Z3_TAG" 2>/dev/null || true
  git checkout -q "$Z3_TAG" )
echo "  $(cd z3 && git describe --tags)"

say "3. configure"
# Z3_SINGLE_THREADED: pthread 를 쓰면 SharedArrayBuffer 와 COOP/COEP 헤더가
#   필요해진다. 상류 npm 빌드는 pthread 를 쓰지만 우리는 끈다.
# -fPIC: side module 은 위치 독립이어야 한다.
# -fwasm-exceptions + -sSUPPORT_LONGJMP=wasm: Pyodide 본체와 예외 ABI 를 맞춘다.
#   -fexceptions(JS 기반)로 빌드하면 적재 시 "cannot resolve symbol invoke_vi" 로 막힌다.
rm -rf build-wasm
emcmake cmake -S z3 -B build-wasm -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DZ3_SINGLE_THREADED=ON -DZ3_BUILD_LIBZ3_SHARED=ON \
  -DZ3_INCLUDE_GIT_HASH=OFF -DZ3_INCLUDE_GIT_DESCRIBE=OFF \
  -DZ3_BUILD_TEST_EXECUTABLES=OFF -DZ3_ENABLE_EXAMPLE_TARGETS=OFF \
  -DZ3_BUILD_DOCUMENTATION=OFF \
  -DCMAKE_CXX_FLAGS="-Os -fPIC -fwasm-exceptions -sSUPPORT_LONGJMP=wasm" \
  -DCMAKE_C_FLAGS="-Os -fPIC -fwasm-exceptions -sSUPPORT_LONGJMP=wasm" \
  > cfg.log 2>&1 || { echo "configure 실패"; tail -20 cfg.log; exit 1; }
echo "  OK"

say "4. 컴파일 (840여 파일, 5~15분)"
ninja -C build-wasm -j"$(nproc)" libz3 > build.log 2>&1 \
  || { echo "빌드 실패"; grep -E 'error:|FAILED' build.log | tail -8; exit 1; }
echo "  $(grep -oE '^\[[0-9]+/[0-9]+\]' build.log | tail -1)"

say "5. side module 링크"
# 주의 1: emscripten CMake 는 shared 를 안 만든다. libz3.a(정적)가 나온다.
# 주의 2: -Wl,--whole-archive 로 그 .a 를 넘기면 아무것도 안 들어간다(3.8K).
#         오브젝트를 직접 넘겨야 한다.
# 주의 3: SIDE_MODULE=2 는 EXPORTED_FUNCTIONS 에 적은 것만 내보내므로
#         아무것도 안 적으면 링커가 전부 걷어낸다. 1 을 써야 한다.
mkdir -p "$OUT"
find build-wasm -name '*.o' > objs.rsp
echo "  오브젝트 $(wc -l < objs.rsp) 개"
emcc -Os -fwasm-exceptions -sSUPPORT_LONGJMP=wasm \
     -sSIDE_MODULE=1 -sERROR_ON_UNDEFINED_SYMBOLS=0 \
     @objs.rsp -o "$OUT/libz3.so" > link.log 2>&1 \
  || { echo "링크 실패"; grep -i error link.log | head -8; exit 1; }
n=$("$EMSDK"/upstream/bin/llvm-nm --defined-only "$OUT/libz3.so" 2>/dev/null | grep -c ' Z3_' || echo 0)
echo "  libz3.so $(du -h "$OUT/libz3.so" | cut -f1)   Z3_* 심볼 $n"
[ "${n:-0}" -gt 100 ] || { echo "  심볼이 너무 적다 — SIDE_MODULE 설정을 확인해라"; exit 1; }

say "6. 파이썬 바인딩 (pip 의 것을 그대로)"
mkdir -p "$OUT/py"
SP=$(python -c 'import z3, os; print(os.path.dirname(z3.__file__))' 2>/dev/null) || {
  echo "  pip 의 z3-solver 가 없다. align venv 를 activate 했는지 확인해라."; exit 1; }
cp "$SP"/*.py "$OUT/py/"
echo "  $(ls "$OUT/py" | wc -l) 개  ($(python -c 'import z3; print(z3.get_version_string())'))"

say "끝"
cat <<'NOTE'
브라우저에서 쓰는 법 — 반드시 Web Worker 에서 해야 한다.
메인 스레드는 8MB 넘는 wasm 을 동기 컴파일할 수 없다 (RangeError).

  py.FS.mkdirTree("/z3lib");
  py.FS.writeFile("/z3lib/libz3.so", new Uint8Array(await (await fetch("libz3.so")).arrayBuffer()));
  await py._module.loadDynamicLibrary("/z3lib/libz3.so", { global: true, nodelete: true });
  py.FS.mkdirTree("/zpy/z3");   // py/*.py 를 여기에
  py.runPython("import sys, os; sys.path.insert(0,'/zpy'); os.environ['Z3_LIBRARY_PATH']='/z3lib'");
  py.runPython("import z3");
NOTE
