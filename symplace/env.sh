#!/usr/bin/env bash
# 실행 환경 설정.  사용법:  source env.sh
#
# 경로는 이 파일의 위치에서 유도한다. 어디에 풀어놓아도 된다.
# 이미 설정한 값이 있으면 그것을 존중한다.

SYMPLACE_ROOT=${SYMPLACE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}
export SYMPLACE_ROOT

export ALIGN_VENV=${ALIGN_VENV:-$SYMPLACE_ROOT/.venv}
export ALIGN_REPO=${ALIGN_REPO:-$SYMPLACE_ROOT/ALIGN-public}

# align-analoglayout 휠은 COIN-OR 라이브러리(libCgl/libClp/libCbc)를 <venv>/lib 에
# 설치하는데 거기는 동적 링커 기본 검색 경로가 아니다. 직접 잡아줘야 한다.
export LD_LIBRARY_PATH=$ALIGN_VENV/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}

if [ -f "$ALIGN_VENV/bin/activate" ]; then
  # shellcheck disable=SC1091
  source "$ALIGN_VENV/bin/activate"
else
  echo "venv 가 없다: $ALIGN_VENV   (setup.sh 를 먼저 돌려라)" >&2
fi

export ALIGN_EXAMPLES=${ALIGN_EXAMPLES:-$ALIGN_REPO/examples}
export ALIGN_PDK=${ALIGN_PDK:-$ALIGN_REPO/pdks/FinFET14nm_Mock_PDK}

# 작업 디렉터리. WSL 에서 /mnt/c 아래에 두면 drvfs I/O 때문에 매우 느리고,
# 무거운 예제에서는 VM 이 불안정해진다. 리눅스 파일시스템을 기본으로 한다.
export ALIGN_WORK=${ALIGN_WORK:-$HOME/align-work}
mkdir -p "$ALIGN_WORK"

export PYTHONPATH=$SYMPLACE_ROOT${PYTHONPATH:+:$PYTHONPATH}

echo "symplace 준비됨"
echo "  align    : $(python -c 'import align; print(align.__version__)' 2>&1)"
echo "  repo     : $ALIGN_REPO"
echo "  pdk      : $ALIGN_PDK"
echo "  work     : $ALIGN_WORK"
