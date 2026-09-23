#!/usr/bin/env bash
# 브라우저 배선 경로(frontworker.mjs)를 node 에서 그대로 돌리기 위한 준비물을 받는다.
#
# Pyodide CDN(cdn.jsdelivr.net)이 막힌 환경에서도 된다. 코어는 npm 꾸러미
# (pyodide@0.27.8 — CDN 의 full/ 과 같은 파일)에 있고, 앞단이 쓰는 파이썬
# 꾸러미는 전부 순수 파이썬 휠이라 PyPI 에서 받으면 된다.
#
#   ./setup.sh            -> 캐시 디렉터리 경로를 찍는다
#
# 받는 곳은 저장소 밖이다 (PYODIDE_CACHE, 기본 ~/.cache/symplace/pyodide-0.27.8).
set -eu
V=0.27.8
C=${PYODIDE_CACHE:-$HOME/.cache/symplace/pyodide-$V}
mkdir -p "$C/whl"

if [ ! -f "$C/package/pyodide.mjs" ]; then
  ( cd "$C" && npm pack "pyodide@$V" >/dev/null 2>&1 && tar xzf "pyodide-$V.tgz" && rm -f "pyodide-$V.tgz" )
fi

# 브라우저 워커가 micropip 으로 까는 것과 같은 판을 고정한다.
# typing_extensions 는 pydantic 1.10 의 의존성이고, 판은 Pyodide 0.27.8 lock 의 것이다.
pip download --quiet --no-deps --only-binary=:all: --python-version 3.12 --platform any \
  -d "$C/whl" "networkx==3.4.2" "pydantic==1.10.13" "typing_extensions==4.11.0" \
  "python-gdsii==0.2.3"

echo "$C"
