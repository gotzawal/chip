#!/usr/bin/env bash
# ALIGN 을 받아 설치하고 메모리 패치를 적용한다.
#   사용법:  ./setup.sh
#
# 검증된 조합 (2026-09 기준):
#   Ubuntu 24.04 (WSL2 포함), Python 3.12, align-analoglayout 0.9.8,
#   ALIGN-public @ 8d3cc2e
set -eu
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
VENV=${ALIGN_VENV:-$ROOT/.venv}
REPO=${ALIGN_REPO:-$ROOT/ALIGN-public}
PIN=${ALIGN_COMMIT:-8d3cc2e}

say() { printf "\n\033[1m== %s\033[0m\n" "$*"; }

say "1. 사전 조건 확인"
missing=()
command -v python3 >/dev/null || missing+=(python3)
command -v git     >/dev/null || missing+=(git)
python3 -c 'import sysconfig,os,sys; sys.exit(0 if os.path.exists(os.path.join(sysconfig.get_paths()["include"],"Python.h")) else 1)' \
  2>/dev/null || missing+=(python3-dev)
if [ ${#missing[@]} -gt 0 ]; then
  echo "다음이 없다: ${missing[*]}"
  echo "  sudo apt install -y ${missing[*]} build-essential"
  echo
  echo "python3-dev 가 없으면 gdspy 휠 빌드가 'Python.h: No such file' 로 깨진다."
  exit 1
fi
echo "  python3 $(python3 -c 'import platform;print(platform.python_version())')  git  python3-dev  OK"

say "2. 가상환경"
[ -d "$VENV" ] || python3 -m venv "$VENV"
# shellcheck disable=SC1091
source "$VENV/bin/activate"
python -m pip install -q --upgrade pip wheel

say "3. align-analoglayout 설치 (몇 분 걸린다)"
if python -c 'import align' 2>/dev/null; then
  echo "  이미 설치됨: $(python -c 'import align;print(align.__version__)')"
else
  python -m pip install 'align-analoglayout==0.9.8'
fi

say "4. ALIGN 저장소 (examples 와 PDK 가 필요하다)"
if [ -d "$REPO/.git" ]; then
  echo "  이미 있음: $REPO"
else
  git clone https://github.com/ALIGN-analoglayout/ALIGN-public.git "$REPO"
  git -C "$REPO" checkout "$PIN" 2>/dev/null \
    || echo "  경고: 커밋 $PIN 로 못 갔다. HEAD 를 쓴다 — 패치가 안 맞을 수 있다."
fi

say "5. 메모리 패치 적용"
SP=$(python -c 'import align,os;print(os.path.dirname(align.__file__))')
echo "  대상: $SP"
if grep -q emit_placements "$SP/pnr/placer.py" 2>/dev/null; then
  echo "  이미 적용됨"
else
  cp -a "$SP/pnr/placer.py" "$SP/pnr/placer.py.orig"
  cp -a "$SP/pnr/router.py" "$SP/pnr/router.py.orig"
  # 패치는 git diff 라 경로가 a/align/pnr/... 이다. site-packages 에서 -p1 이면
  # align/pnr/... 로 떨어져 정확히 맞는다.
  if ( cd "$SP/.." && patch -p1 --forward --fuzz=3 < "$ROOT/patches/align-memory.patch" ); then
    echo "  적용 완료 (원본은 *.orig 로 보관)"
  else
    echo
    echo "  자동 적용 실패. 손으로 넣어라 — 세 군데뿐이다."
    echo "  patches/README.md 에 내용이 적혀 있다."
    exit 1
  fi
fi

say "6. 확인"
# shellcheck disable=SC1091
source "$ROOT/env.sh"
python - <<'PY'
import align, align.pnr.placer as P, inspect
src = inspect.getsource(P.hierarchical_place)
print("  align", align.__version__)
print("  패치 확인: emit_placements", "있음" if "emit_placements" in src else "없음")
print("  패치 확인: PlaceOnGrid 가드", "있음" if hasattr(P, "_has_place_on_grid") else "없음")
PY
command -v node >/dev/null \
  && echo "  node $(node --version)  — JS 검사를 돌릴 수 있다" \
  || echo "  node 없음 — 브라우저 배치기 검사는 건너뛴다 (파이썬 쪽은 무관)"

say "끝. 다음:"
echo "  source env.sh"
echo "  ./scripts/verify.sh telescopic_ota     # 배치 + 배선 + DRC"
