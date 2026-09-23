#!/usr/bin/env bash
# lp_solve 5.5.2.11 (ALIGN thirdparty/lpsolve.cmake 가 고정한 판) 소스를 받아 풀어 둔다.
# build.rs 가 여기서 C 를 빌드한다. 저장소에는 넣지 않는다 (LGPL-2.1, 약 3.5 MB).
#
#   symplace/alignroute/fetch-lpsolve.sh      -> ~/.cache/symplace/lpsolve-wasi/lp_solve_5.5
set -eu
W=${LPSOLVE_WASI:-$HOME/.cache/symplace/lpsolve-wasi}
mkdir -p "$W" && cd "$W"
TGZ=lp_solve_5.5.2.11_source.tar.gz
[ -f "$TGZ" ] || curl -sSL -o "$TGZ" "https://sourceforge.net/projects/lpsolve/files/lpsolve/5.5.2.11/$TGZ/download"
echo "a829a8d9c60ff81dc72ff52363703886  $TGZ" | md5sum -c - >/dev/null
[ -d lp_solve_5.5 ] || tar xzf "$TGZ"
echo "$W/lp_solve_5.5"
