#!/usr/bin/env python
"""M0: 입출력 왕복 + 영공간 매개화를 실제 ALIGN 결과로 검증한다.

    python -m gpuplace.m0 <예제이름> [...]

두 가지를 확인한다.

1. 왕복 — ALIGN 이 낸 배치 JSON 을 우리 자료구조로 읽고 다시 써서
   원본과 같은지. 같으면 좌표만 우리 것으로 갈아끼울 준비가 된 것이다.

2. 부분공간 — ALIGN 의 실제 배치가 우리가 세운 등식 제약
   A z = b 를 만족하는지. 만족하면 설계의 전제(대칭을 재매개화로
   흡수할 수 있다)가 데이터로 확인된 것이고, 잔차가 크면 제약 해석이
   틀린 것이다.
"""
from __future__ import annotations

import glob
import json
import os
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from gpuplace import placement as P          # noqa: E402
from gpuplace import subspace as S           # noqa: E402

WORK = os.environ.get("ALIGN_WORK", os.path.expanduser("~/align-work"))


def find_placement(example):
    """최상위 모듈의 배치 파일을 고른다.

    계층 설계는 하위 모듈 파일도 같이 남기므로 알파벳순 첫 파일을 집으면
    엉뚱한 걸 본다 (예: CASCODED_CMC_NMOS_..._PG0_0 이 CASCODE_..._0 보다 앞선다).
    예제 이름을 대문자로 바꾼 것이 최상위 모듈 이름이다.
    """
    pat = f"{WORK}/{example}/3_pnr/Results/*.scaled_placement_verilog.json"
    files = sorted(glob.glob(pat))
    if not files:
        return None
    want = example.upper().replace("_FAST", "")
    top = [f for f in files
           if os.path.basename(f).split(".scaled")[0].rsplit("_", 1)[0] == want]
    return top[0] if top else files[0]


def roundtrip(path):
    pl = P.load(path)
    tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    tmp.close()
    P.dump(pl, tmp.name)
    a = json.load(open(path, encoding="utf8"))
    b = json.load(open(tmp.name, encoding="utf8"))
    os.unlink(tmp.name)
    return a == b, pl


def check(example):
    path = find_placement(example)
    print(f"\n{'=' * 66}\n{example}")
    if not path:
        print("  배치 결과 없음 (실행이 완주하지 않은 예제)")
        return

    ok, pl = roundtrip(path)
    print(f"  왕복 : {'일치' if ok else '불일치 — 모델이 뭔가를 흘리고 있다'}")

    stem = os.path.basename(path).split(".scaled_placement_verilog")[0]
    mod = pl.top(stem)

    names, sizes, centers = [], {}, {}
    for inst in mod.instances:
        tb = pl.template_bbox(inst.concrete_template)
        if tb is None:
            continue
        c, wh = P.placed_center_size(tb, inst)
        names.append(inst.name)
        sizes[inst.name] = wh
        centers[inst.name] = c

    sysm, skipped = S.build(mod.constraints, names, sizes)
    A, b = sysm.matrices()
    N, rank = S.nullspace(A)

    n_free_raw = 2 * len(names)
    dof = sysm.n - rank

    print(f"  모듈 : {mod.concrete_name}  블록 {len(names)}개  "
          f"대칭축 {sysm.n_axis}개")
    print(f"  제약 : 등식 {A.shape[0]}개 (랭크 {rank})")
    print(f"  자유도: {sysm.n} -> {dof}   "
          f"(축 변수 제외 시 {n_free_raw} -> {dof - sysm.n_axis + sysm.n_axis})")

    if A.shape[0] == 0:
        print("  등식 제약 없음 — 재매개화할 게 없다")
        return

    # 실제 배치를 넣고 축 변수만 최소제곱으로 풀어 잔차를 본다.
    z_known = np.zeros(sysm.n)
    for n in names:
        z_known[sysm.cx(n)] = centers[n][0]
        z_known[sysm.cy(n)] = centers[n][1]

    Ac = A[:, : 2 * len(names)]
    Aa = A[:, 2 * len(names):]
    rhs = b - Ac @ z_known[: 2 * len(names)]
    if Aa.shape[1]:
        z_axis, *_ = np.linalg.lstsq(Aa, rhs, rcond=None)
        resid = Aa @ z_axis - rhs
    else:
        z_axis, resid = np.zeros(0), rhs

    print(f"  잔차 : max |A z - b| = {np.abs(resid).max():.6g}")
    for k, v in enumerate(z_axis):
        print(f"         대칭축[{k}] = {v:.1f}  "
              f"(모듈 중심 {(mod.bbox[0] + mod.bbox[2]) / 2:.1f})")

    worst = np.argsort(-np.abs(resid))[:3]
    for i in worst:
        if abs(resid[i]) > 1e-6:
            print(f"    위반: {sysm.why[i]}  잔차 {resid[i]:.3g}")

    for s in skipped:
        print(f"  건너뜀: {s}")

    # 부분공간 위에 있는지 직접 확인: z 를 z0 + N theta 로 표현 가능한가
    z_full = z_known.copy()
    z_full[2 * len(names):] = z_axis
    z0 = S.particular(A, b)
    theta, *_ = np.linalg.lstsq(N, z_full - z0, rcond=None)
    err = np.abs(z0 + N @ theta - z_full).max()
    print(f"  부분공간: max |z0 + N·theta - z| = {err:.6g}"
          f"  {'✓ 실제 배치가 부분공간 위에 있다' if err < 1e-6 else '✗'}")


def main():
    examples = sys.argv[1:] or [
        d for d in sorted(os.listdir(WORK))
        if os.path.isdir(f"{WORK}/{d}") and find_placement(d)
    ]
    for ex in examples:
        check(ex)


if __name__ == "__main__":
    main()
