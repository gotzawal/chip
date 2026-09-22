#!/usr/bin/env python
"""M2: 배치 차원으로 수천 개 시작점을 동시에 굴린다.

    python -m gpuplace.m2 telescopic_ota [--batch 2048] [--iters 1200]

M1 대비 달라지는 것은 하나뿐이다 — 재시작을 순차가 아니라 한꺼번에 돌린다.
분포를 보면 좋은 해가 드물게 나오므로(HPWL 폭/평균 1.02) 표본이 곧 품질이다.

시작 전에 M1 구현과 값을 맞춰본다. 배치화는 축을 헷갈리기 쉬운 작업이라
같은 theta 에서 같은 답이 나오는지부터 확인하고 넘어간다.
"""
from __future__ import annotations

import argparse
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from gpuplace import batch as BA             # noqa: E402
from gpuplace import energy as E             # noqa: E402
from gpuplace import handoff as HO           # noqa: E402
from gpuplace import legalize as LG          # noqa: E402
from gpuplace import netlist as NL           # noqa: E402
from gpuplace import placement as P          # noqa: E402
from gpuplace import subspace as S           # noqa: E402
from gpuplace.m0 import WORK, find_placement  # noqa: E402
from gpuplace.m1 import hpwl                 # noqa: E402

PDK_DEFAULT = os.path.join(os.environ.get("ALIGN_REPO", ""),
                           "pdks", "FinFET14nm_Mock_PDK")


def load(example):
    path = find_placement(example)
    if not path:
        return None
    pl = P.load(path)
    stem = os.path.basename(path).split(".scaled_placement_verilog")[0]
    mod = pl.top(stem)

    names, w, h, cx_a, cy_a, sx, sy = [], [], [], [], [], [], []
    for inst in mod.instances:
        tb = pl.template_bbox(inst.concrete_template)
        if tb is None:
            continue
        c, wh = P.placed_center_size(tb, inst)
        names.append(inst.name)
        w.append(wh[0]); h.append(wh[1])
        cx_a.append(c[0]); cy_a.append(c[1])
        sx.append(inst.sX); sy.append(inst.sY)
    d = dict(pl=pl, mod=mod, names=names,
             w=np.array(w, float), h=np.array(h, float),
             cx_a=np.array(cx_a, float), cy_a=np.array(cy_a, float),
             sx=np.array(sx, float), sy=np.array(sy, float))
    d["n"] = len(names)
    d["pin"] = NL.extract(pl, mod)
    return d


def run(example, B, iters, legal, n_legal=8, emit=False):
    d = load(example)
    if d is None:
        print(f"{example}: 배치 결과 없음")
        return
    n, w, h, mod, pl = d["n"], d["w"], d["h"], d["mod"], d["pl"]
    pin_inst, pin_off, pin_net, net_names = d["pin"]
    if len(pin_inst) == 0:
        print(f"{example}: 핀 정보 없음 — 범위 밖")
        return

    sizes = {nm: (w[i], h[i]) for i, nm in enumerate(d["names"])}
    sysm, _ = S.build(mod.constraints, d["names"], sizes)
    A, b = sysm.matrices()
    Nmat, _ = S.nullspace(A)
    z0 = S.particular(A, b)
    P_dof = Nmat.shape[1]
    region = tuple(mod.bbox)

    a_area = (mod.bbox[2] - mod.bbox[0]) * (mod.bbox[3] - mod.bbox[1])
    a_hpwl = hpwl(d["cx_a"], d["cy_a"], pin_inst, pin_off, pin_net,
                  len(net_names), d["sx"], d["sy"])

    print(f"\n{'=' * 68}\n{example}   배치 {B}개 x {iters}회")
    print(f"  블록 {n}  넷 {len(net_names)}  자유도 {sysm.n} -> {P_dof}")

    bobj = BA.BatchObjective(z0, Nmat, n, w, h, pin_inst, pin_off, pin_net,
                             len(net_names), region, M=64)
    sobj = E.Objective(z0, Nmat, n, w, h, pin_inst, pin_off, pin_net,
                       len(net_names), region, M=64)

    # --- 배치 구현이 M1 과 같은 답을 내는가 ---
    rng = np.random.default_rng(0)
    t1 = rng.normal(scale=100, size=P_dof)
    bobj.calibrate(t1[None, :])
    de, dg = BA.cross_check(bobj, sobj, t1)
    print(f"  M1 대조: 에너지 상대차 {de:.3g}, 기울기 상대차 {dg:.3g}"
          f"  {'OK' if max(de, dg) < 1e-9 else '<-- 의심'}")

    # --- 배치 초기값: 영역 안 무작위 위치를 제약 부분공간에 사영 ---
    x0, y0, x1, y1 = region
    zt = np.repeat(z0[None, :], B, axis=0)
    zt[:, 0:2 * n:2] = rng.uniform(x0, x1, (B, n))
    zt[:, 1:2 * n:2] = rng.uniform(y0, y1, (B, n))
    theta = np.linalg.lstsq(Nmat, (zt - z0[None, :]).T, rcond=None)[0].T

    span = max(x1 - x0, y1 - y0)
    t0 = time.time()
    theta = BA.adam(bobj, theta, iters, lr=span / 400,
                    lam_grow=1.30, mu_grow=1.25)
    el = time.time() - t0
    print(f"  최적화 {el:.1f}초  ({B * iters / el / 1000:.0f}k 배치·반복/초)")

    cx, cy = bobj.centers(theta)
    ar = (np.max(cx + w / 2, 1) - np.min(cx - w / 2, 1)) * \
         (np.max(cy + h / 2, 1) - np.min(cy - h / 2, 1))
    of = bobj.overflow(cx, cy)
    hp = np.array([hpwl(cx[i], cy[i], pin_inst, pin_off, pin_net,
                        len(net_names), d["sx"], d["sy"]) for i in range(B)])
    # 겹침은 legalization 이 어차피 없애준다. 여기서 과하게 벌주면
    # 배선이 좋은 해를 버리게 된다 (high_speed_comparator 에서 실제로 그랬다).
    # 최종 선택은 legalize 후에 하므로, 여기서는 후보를 넓게 남긴다.
    score = ar / a_area + hp / a_hpwl + 3 * of
    k = int(np.argmin(score))

    print(f"\n  {'':16s} {'ALIGN':>13s} {'M2 최선':>13s} {'M2 중앙':>13s}")
    print(f"  {'면적':16s} {a_area:13.4g} {ar[k]:13.4g} {np.median(ar):13.4g}")
    print(f"  {'HPWL':16s} {a_hpwl:13.4g} {hp[k]:13.4g} {np.median(hp):13.4g}")
    print(f"  {'겹침':16s} {'-':>13s} {of[k]:13.3f} {np.median(of):13.3f}")
    print(f"  최선 대비 ALIGN: 면적 {ar[k]/a_area:.2f}x, HPWL {hp[k]/a_hpwl:.2f}x")
    print(f"  HPWL 상위 1% 평균 {np.sort(hp)[:max(1, B//100)].mean():.4g}")

    if legal:
        # 최종 지표는 legalize 후다. 연속해 점수로 하나만 고르면
        # 겹침이 큰 해를 집어 펴느라 면적을 잃는다 (실측: 0.99x -> 1.30x).
        # 상위 후보 몇 개를 실제로 legalize 해서 그중 최선을 고른다.
        # 한 지표만 보면 한쪽으로 치우친 후보만 남는다.
        # 종합 점수 / 배선 / 면적 각각의 상위를 섞어 tradeoff 를 훑는다.
        cand = np.unique(np.r_[np.argsort(score)[:n_legal],
                               np.argsort(hp)[:n_legal // 2],
                               np.argsort(ar)[:n_legal // 4]])
        # 배선으로 넘길 거면 격자 조건을 MILP 안에서 지키게 한다.
        # 나중에 반올림하면 겹침이 되살아난다.
        grid, gref = (1, 1), None
        if emit:
            grid = HO.pdk_grid(os.environ.get("ALIGN_PDK", PDK_DEFAULT))
            gref = HO.grid_anchors(pl, mod)
            print(f"\n  배선 격자 (PDK): x {grid[0]}, y {grid[1]}")
        print(f"  후보 {len(cand)}개 legalize (종합·배선·면적 상위를 섞음)")
        best = None
        for c in cand:
            th2, st = LG.legalize(z0, Nmat, n, w, h, cx[c], cy[c], region,
                                  time_limit=30, grid_ref=gref, grid=grid)
            if th2 is None:
                continue
            z2 = z0 + Nmat @ th2
            cx2, cy2 = z2[0:2 * n:2], z2[1:2 * n:2]
            ar2 = (np.max(cx2 + w / 2) - np.min(cx2 - w / 2)) * \
                  (np.max(cy2 + h / 2) - np.min(cy2 - h / 2))
            hp2 = hpwl(cx2, cy2, pin_inst, pin_off, pin_net,
                       len(net_names), d["sx"], d["sy"])
            s2 = ar2 / a_area + hp2 / a_hpwl
            if best is None or s2 < best[0]:
                best = (s2, ar2, hp2, th2, z2, st)
        if best is None:
            print("  legalization 전부 실패")
        else:
            _, ar2, hp2, th2, z2, st = best
            cx2, cy2 = z2[0:2 * n:2], z2[1:2 * n:2]
            ov2 = LG.exact_overlap(cx2, cy2, w, h)
            rs2 = float(np.abs(A @ z2 - b).max()) if A.shape[0] else 0
            print(f"  최선 ({st}): 면적 {ar2/a_area:.2f}x, "
                  f"HPWL {hp2/a_hpwl:.2f}x, 겹침 {ov2:.3g}, 대칭 잔차 {rs2:.3g}")

            if emit:
                ncx, ncy, nbbox = HO.normalize(pl, mod, cx2, cy2, w, h, grid)
                ov3 = LG.exact_overlap(ncx, ncy, w, h)
                moved = float(np.abs(np.r_[ncx - cx2, ncy - cy2]).max())
                work = HO.prepare(f"{WORK}/{example}", f"{WORK}/{example}_ours")
                HO.inject(work, pl, mod, ncx, ncy, bbox=nbbox)
                print(f"  배선용 출력: 이동 {moved:.3g}, 겹침 {ov3:.3g}, "
                      f"bbox {nbbox}")
                print(f"    {work}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("examples", nargs="*", default=["telescopic_ota"])
    ap.add_argument("--batch", type=int, default=1024)
    ap.add_argument("--iters", type=int, default=1200)
    ap.add_argument("--no-legalize", action="store_true")
    ap.add_argument("--n-legal", type=int, default=8)
    ap.add_argument("--emit", action="store_true")
    a = ap.parse_args()
    for ex in (a.examples or ["telescopic_ota"]):
        run(ex, a.batch, a.iters, not a.no_legalize, a.n_legal, a.emit)


if __name__ == "__main__":
    main()
