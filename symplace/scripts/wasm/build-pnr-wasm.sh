#!/usr/bin/env bash
# 배선용 축소 PnR 모듈을 Pyodide 0.27 용으로 빌드한다.
#
# ALIGN 의 CMake 를 쓰지 않는다. 거기서 superlu / boost / ilpif 가 딸려오는데
# ilpif 는 미리 빌드된 x86-64 솔버 바이너리라 wasm 이 없다 (placer 전용).
# 대신 필요한 소스만 setuptools Extension 으로 직접 나열한다.
#
# lp_solve 는 C 라 따로 빌드한다. setuptools 는 extra_compile_args 를 언어와
# 무관하게 다 붙여서, -std=c++14 가 .c 파일에 가면 거부당한다:
#   error: invalid argument '-std=c++14' not allowed with 'C'
set -eu
# 이 저장소의 위치. env.sh 가 없으면 직접 넣어라.
: "${ALIGN_SRC:=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
source "${ALIGN_ENV:-$ALIGN_SRC/env.sh}" >/dev/null 2>&1
S=$ALIGN_SRC/scripts/wasm
SRC=${ALIGN_REPO:-$ALIGN_SRC/ALIGN-public}/PlaceRouteHierFlow
INC=~/s2/inc
LP=~/s3/lp_solve_5.5
XB=$(pyodide config get emsdk_dir 2>/dev/null || echo "")
[ -n "$XB" ] || XB=$(ls -d ~/.cache/pyodide-build/.pyodide-xbuildenv-*/0.27.8/emsdk | head -1)
D=~/pnrwasm; rm -rf "$D"; mkdir -p "$D/src" "$D/lpobj"; cd "$D"

echo "== 축소 바인딩 생성 =="
python3 "$S/make-reduced-binding.py" "$SRC/PnR-pybind11.cpp" "$D/src/PnR-reduced.cpp"

echo
echo "== lp_solve 를 xbuildenv 의 emcc 로 먼저 빌드 =="
echo "  emsdk: $XB"
# shellcheck disable=SC1091
source "$XB/emsdk_env.sh" >/dev/null 2>&1
emcc --version | head -1 | sed 's/^/  /'
LIST=$(sed -n '/add_library(lpsolve55 SHARED/,/)/p' "$SRC/thirdparty/CMakeLists.lpsolve" \
       | grep -oE '[A-Za-z_/]+\.c')
ok=0; fail=0
for c in $LIST; do
  [ -f "$LP/$c" ] || continue
  o="$D/lpobj/$(basename "${c%.c}").o"
  if emcc -O2 -fPIC -fexceptions -c "$LP/$c" -o "$o" \
      -I"$LP" -I"$LP/shared" -I"$LP/bfp" -I"$LP/bfp/bfp_LUSOL" \
      -I"$LP/bfp/bfp_LUSOL/LUSOL" -I"$LP/colamd" \
      -DYY_NEVER_INTERACTIVE -DPARSER_LP -DINVERSE_ACTIVE=INVERSE_LUSOL \
      -DRoleIsExternalInvEngine -DLoadInverseLib=0 -DLoadLanguageLib=0 \
      > "$o.err" 2>&1; then ok=$((ok+1)); else fail=$((fail+1)); echo "  FAIL $c"; head -3 "$o.err" | sed 's/^/      /'; fi
done
echo "  lp_solve: 성공 $ok / 실패 $fail"
[ $fail -eq 0 ] || exit 1

echo
echo "== setup.py 생성 =="
# placer 를 같이 빌드하려면 boost 헤더(그래프 2개만 쓴다)와 ILPSolverIf 헤더가 필요하다.
# 둘 다 네이티브 빌드가 이미 받아둔 것을 재사용한다.
export ILP_STUB="$S/ilpstub.cpp"
BOOST_INC=$(find ~/pnrbuild/_deps -maxdepth 2 -type d -name boost-src | head -1)
# 디렉터리 이름으로 찾으면 -build 쪽(헤더가 없다)을 먼저 집는다. 파일로 찾는다.
ILPIF_INC=$(dirname "$(find ~/pnrbuild/_deps -name ILPSolverIf.h | head -1)")
export BOOST_INC ILPIF_INC
echo "  boost 헤더 : ${BOOST_INC:-없음}"
echo "  ilpif 헤더 : ${ILPIF_INC:-없음}"
[ -n "$BOOST_INC" ] && [ -n "$ILPIF_INC" ] || { echo "  헤더를 못 찾았다"; exit 1; }
python3 - "$SRC" "$INC" "$LP" "$D" <<'PY'
import glob
import io
import os
import sys

SRC, INC, LP, D = sys.argv[1:5]
srcs = [os.path.join(D, "src", "PnR-reduced.cpp")]
srcs += sorted(f for f in glob.glob(SRC + "/PnRDB/*.cpp") if "unit_test" not in f)
srcs += sorted(f for f in glob.glob(SRC + "/router/*.cpp") if "unit_test" not in f)
# placer: router.py 가 우리 배치를 DB 에 채워 넣을 때 쓴다 (탐색은 안 한다)
# Preadfile.cpp 는 뺀다. PnRDB/readfile.cpp 와 get_true_word 등을 중복 정의하는데,
# ALIGN 은 모듈별 라이브러리로 나눠 빌드해서 안 부딪힌다. 우리는 하나로 합치므로
# 링크에서 duplicate symbol 이 난다. Preadfile.h 는 자기 자신만 include 하는
# 죽은 코드라 빼도 된다.
srcs += sorted(f for f in glob.glob(SRC + "/placer/*.cpp")
               if "unit_test" not in f
               and not f.endswith("/main.cpp")
               and not f.endswith("/Preadfile.cpp"))
srcs += [os.environ["ILP_STUB"]]
objs = sorted(glob.glob(os.path.join(D, "lpobj", "*.o")))
print("  C++ %d 개, lp_solve 오브젝트 %d 개" % (len(srcs), len(objs)))

incs = [SRC, SRC + "/router", SRC + "/placer", INC, LP, LP + "/shared", LP + "/bfp",
        LP + "/bfp/bfp_LUSOL", LP + "/bfp/bfp_LUSOL/LUSOL", LP + "/colamd",
        os.environ["BOOST_INC"], os.environ["ILPIF_INC"]]

setup = '''from setuptools import setup, Extension
import pybind11

ext = Extension(
    "PnR",
    sources=%r,
    include_dirs=%r + [pybind11.get_include()],
    # lp_solve 는 C 라 미리 빌드해 오브젝트로 넘긴다 (-std=c++14 가 .c 에 가면 거부된다)
    extra_objects=%r,
    define_macros=[("SPDLOG_HEADER_ONLY", "1")],
    extra_compile_args=["-std=c++14", "-fexceptions", "-Wno-everything"],
    extra_link_args=["-fexceptions"],
)
setup(name="PnR", version="0.9.8", ext_modules=[ext])
''' % (srcs, incs, objs)
io.open(os.path.join(D, "setup.py"), "w", encoding="utf8").write(setup)
io.open(os.path.join(D, "pyproject.toml"), "w", encoding="utf8").write(
    '[build-system]\nrequires = ["setuptools>=64", "pybind11>=2.10"]\n'
    'build-backend = "setuptools.build_meta"\n\n'
    '[project]\nname = "PnR"\nversion = "0.9.8"\n')
PY

echo
echo "== pyodide build (오래 걸린다) =="
pyodide build > ~/pnrbuild.log 2>&1 && rc=0 || rc=1
if [ $rc -ne 0 ]; then
  echo "  실패:"
  grep -nE 'error:|fatal error|No such file' ~/pnrbuild.log | head -10 | sed 's/^/    /'
  exit 1
fi
ls -lh dist/*.whl | awk '{print "  휠:", $9, $5}'
echo "PNR_BUILD_OK"
