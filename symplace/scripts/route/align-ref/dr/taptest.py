#!/usr/bin/env python3
"""tap 덤프의 모드 4 입력으로 oracle5 (C++ 원본) 와 Rust 를 돌려 바로 뒤 모드 5 출력(m5_out)과 견준다.

  taptest.py [뿌리=~/.cache/symplace/tap] [--rust] [--oracle] [--ex=예제] [--tag=배치] [--node=모듈]

둘 다 안 고르면 oracle 만. 모두 같으면 끝줄 표가 {('rust', 'same'): N} 꼴이다.
"""
import sys
from common import first_diff, run_oracle, run_rust, tap_cases

args = [a for a in sys.argv[1:] if not a.startswith('--')]
opt = dict(a[2:].split('=', 1) for a in sys.argv[1:] if a.startswith('--') and '=' in a)
root = args[0] if args else '~/.cache/symplace/tap'
use_o = '--oracle' in sys.argv or '--rust' not in sys.argv
use_r = '--rust' in sys.argv

tally = {}
for ex, tag, mod, job, want in tap_cases(root):
    if opt.get('ex', ex) != ex or opt.get('tag', tag) != tag or opt.get('node', mod) != mod:
        continue
    line = f'{ex[:28]:28s} {tag[:14]:14s} {mod[:26]:26s}'
    for name, fn, on in (('oracle', run_oracle, use_o), ('rust', run_rust, use_r)):
        if not on:
            continue
        got, dt = fn(job, 'tap')
        if isinstance(got, tuple):
            res, detail = got[0], got[1:]
        elif 'error' in got:
            res, detail = 'error', got['error'][:200]
        else:
            fd = first_diff(got, want)
            res, detail = ('same', '') if not fd else ('DIFF', fd)
        tally[(name, res)] = tally.get((name, res), 0) + 1
        line += f' {name}:{res} {dt:.2f}s {detail if detail else ""}'
    print(line, flush=True)
print(tally)
