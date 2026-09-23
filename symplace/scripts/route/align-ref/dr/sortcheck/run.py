#!/usr/bin/env python3
"""alignroute/src/dr/sort.rs 대 libc++ 18 std::sort: 무작위 사례를 두 쪽에 주고 정렬 뒤 원소 번호를 견준다.
어긋난 비교 함수(SortPinsOrder 꼴)와 구간 앞쪽을 읽는 비교 함수까지 — 벡터 밖을 건드리면 두 쪽 다 "UB".

  run.py [seed-from=1] [seed-to=6] [cases=2000]

빌드는 ~/.cache/symplace/dr-sortcheck 에 (clang++ -stdlib=libc++, cargo).
"""
import os, random, subprocess, sys
from pathlib import Path

H = Path(__file__).resolve().parent
W = Path(os.environ.get('DR_SORTCHECK_DIR', Path.home() / '.cache/symplace/dr-sortcheck'))
W.mkdir(parents=True, exist_ok=True)
subprocess.run(['clang++', '-stdlib=libc++', '-O1', '-std=c++17', '-o', str(W / 'ref'), str(H / 'ref.cpp')], check=True)
subprocess.run(['cargo', 'build', '--release', '-q'], cwd=H, env=dict(os.environ, CARGO_TARGET_DIR=str(W / 'target')), check=True)


def cases(seed, T):
    R = random.Random(seed)
    lines = [str(T)]
    for _ in range(T):
        n = R.choice([0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 16, 23, 24, 25, 26, 30, 31, 40, 64, 100, 127, 128, 129, 130, 200, 257, 400, 1000])
        kind = R.choice([1, 2, 2, 3, 4, 4])
        first = 0 if R.random() < 0.4 or n == 0 else R.randrange(0, n)
        kr = R.choice([2, 3, 5, 20, 1000])
        ps = R.choice([0.0, 0.0, 0.05, 0.2, 0.5])
        keys = [R.randrange(kr) for _ in range(n)]
        shape = R.random()
        if shape < 0.15:
            keys.sort()
        elif shape < 0.3:
            keys.sort(reverse=True)
        items = [f'{k} {1 if R.random() < ps else 0}' for k in keys]
        lines.append(f'{n} {first} {kind} ' + ' '.join(items))
    return lines


a = int(sys.argv[1]) if len(sys.argv) > 1 else 1
b = int(sys.argv[2]) if len(sys.argv) > 2 else 6
T = int(sys.argv[3]) if len(sys.argv) > 3 else 2000
total_diff = 0
for seed in range(a, b):
    lines = cases(seed, T)
    inp = '\n'.join(lines) + '\n'
    x = subprocess.run([str(W / 'ref')], input=inp, capture_output=True, text=True)
    y = subprocess.run([str(W / 'target/release/sortcheck')], input=inp, capture_output=True, text=True)
    if x.returncode or y.returncode:
        print('crash', x.returncode, y.returncode, x.stderr[-300:], y.stderr[-300:])
        total_diff += 1
        continue
    A, B = x.stdout.splitlines(), y.stdout.splitlines()
    same = sum(p == q for p, q in zip(A, B))
    ub = sum(p == q == 'UB' for p, q in zip(A, B))
    diff = [i for i, (p, q) in enumerate(zip(A, B)) if p != q] + ([-1] if len(A) != len(B) else [])
    total_diff += len(diff)
    for i in diff[:3]:
        print('DIFF', seed, i, lines[i + 1][:200])
    print(f'seed {seed}: 같음 {same}/{T} (둘 다 UB {ub}), 다름 {len(diff)}')
sys.exit(1 if total_diff else 0)
