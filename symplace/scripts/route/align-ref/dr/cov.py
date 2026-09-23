#!/usr/bin/env python3
"""alignroute/src/dr 의 덮개(coverage): 계측한 네이티브 Rust 를 tap 덤프와 흔든 사례에 돌려 안 닿은 줄을 본다.
oracle 은 안 돈다 — 어느 길을 차분 시험이 안 거쳤는지만 (그 길을 겨누는 흔들기를 fuzz.py 에 더한다).

  cov.py build                                   계측 빌드 (rustup component add llvm-tools 가 있어야 한다)
  cov.py run [--tap] [--gen=5|6|7 --from=0 --to=500]   돌려서 쌓는다 (여러 번 불러 더 쌓는다)
  cov.py report                                  합쳐서 파일별 표 + 안 닿은 줄 (오류·자취 줄은 뺀다)
  cov.py clean                                   쌓은 것을 지운다

일은 ~/.cache/symplace/dr-cov 에서 한다 (DR_COV_DIR).
"""
import glob, json, os, re, subprocess, sys
from pathlib import Path
from common import ALIGNROUTE, tap_cases

W = Path(os.environ.get('DR_COV_DIR', Path.home() / '.cache/symplace/dr-cov'))
TD = W / 'target'
BIN = TD / 'release/alignroute'
PROF = W / 'prof'
opt = dict(a[2:].split('=', 1) for a in sys.argv[2:] if a.startswith('--') and '=' in a)


def tools():
    t = glob.glob(str(Path.home() / '.rustup/toolchains/*/lib/rustlib/*/bin/llvm-profdata'))
    if not t:
        sys.exit('llvm-profdata 가 없다 — rustup component add llvm-tools')
    return Path(t[0]).parent


def run(job):
    W.mkdir(parents=True, exist_ok=True)
    jp = W / f'job{os.getpid()}.json'
    j = dict(job, modes=[4, 5])
    j.setdefault('powerGrid', [4, 5])
    j.setdefault('powerRouting', [0, 5])
    j.setdefault('skip', [7, 8])
    jp.write_text(json.dumps(j))
    env = dict(os.environ, LLVM_PROFILE_FILE=str(PROF / 'p%m_%p.profraw'))
    try:
        subprocess.run([str(BIN), str(jp)], capture_output=True, timeout=60, env=env)
    except subprocess.TimeoutExpired:
        pass
    jp.unlink(missing_ok=True)


def report():
    t = tools()
    raws = glob.glob(str(PROF / '*.profraw'))
    pd = W / 'cov.profdata'
    subprocess.run([str(t / 'llvm-profdata'), 'merge', '-sparse', '-o', str(pd)] + raws, check=True)
    files = sorted(glob.glob(str(ALIGNROUTE / 'src/dr/*.rs')))
    subprocess.run([str(t / 'llvm-cov'), 'report', str(BIN), f'-instr-profile={pd}'] + files)
    show = subprocess.run([str(t / 'llvm-cov'), 'show', str(BIN), f'-instr-profile={pd}', '-show-line-counts'] + files,
                          capture_output=True, text=True).stdout
    cur = None
    for ln in show.splitlines():
        m = re.match(r'^(/\S+\.rs):$', ln.strip())
        if m:
            cur = m.group(1).split('/')[-1]
            print('=====', cur)
            continue
        m = re.match(r'^\s*(\d+)\|\s*(\S*)\|(.*)$', ln)
        if not m or cur is None or m.group(2) != '0':
            continue
        c = m.group(3).strip()
        if any(k in c for k in ('Err(', 'ok_or', 'eprintln', 'tr()', 'format!(')) or c in ('}', '{', '};', ');', ')', '});', '})', '},'):
            continue
        print(f'{int(m.group(1)):5d} {c[:150]}')


if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'build':
        # build.rs 도 계측되어 돌면서 .profraw 를 남긴다 — 크레이트 폴더가 아니라 여기로
        env = dict(os.environ, CARGO_TARGET_DIR=str(TD), RUSTFLAGS='-C instrument-coverage',
                   LLVM_PROFILE_FILE=str(W / 'build-%p.profraw'))
        subprocess.run(['cargo', 'build', '--release'], cwd=ALIGNROUTE, env=env, check=True)
    elif cmd == 'run':
        PROF.mkdir(parents=True, exist_ok=True)
        if '--tap' in sys.argv:
            for root in ('~/.cache/symplace/tap', '~/.cache/symplace/tap-vary'):
                for _, _, _, job, _ in tap_cases(root):
                    run(job)
        if 'gen' in opt:
            from fuzz import GEN
            for seed in range(int(opt.get('from', 0)), int(opt.get('to', 500))):
                run(GEN[opt['gen']](seed)[0])
    elif cmd == 'report':
        report()
    elif cmd == 'clean':
        for f in PROF.glob('*.profraw'):
            f.unlink()
