#!/usr/bin/env python
"""M1: 스프링 + 밀도로 실제 배치를 만들고 ALIGN 결과와 비교한다.

    python -m gpuplace.m1 telescopic_ota [--restarts 64] [--iters 600]

순서
  1. ALIGN 결과에서 블록 크기·핀·넷·제약을 읽는다
  2. 등식 제약을 영공간으로 흡수한다 (M0 에서 검증한 것)
  3. 기울기를 유한차분으로 검증한다
  4. theta 에 대해 Adam 으로 내려간다. lambda 를 키우며 담금질
  5. ALIGN 과 면적·HPWL·대칭 잔차를 비교한다

M1 은 CPU 단일 배치다. 재시작은 순차로 돈다 (M2 에서 배치 차원으로 묶는다).
"""
from __future__ import annotations

import argparse
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from gpuplace import energy as E          # noqa: E402
from gpuplace import netlist as NL        # noqa: E402
from gpuplace import placement as P       # noqa: E402
from gpuplace import subspace as S        # noqa: E402
from gpuplace.m0 import WORK, find_placement    # noqa: E402


def hpwl(cx, cy, pin_inst, pin_off, pin_net, n_net, sx, sy):
    """진짜 HPWL (매끄럽게 만들지 않은 것). 비교용."""
    px = cx[pin_inst] + sx[pin_inst] * pin_off[:, 0]
    py = cy[pin_inst] + sy[pin_inst] * pin_off[:, 1]
    tot = 0.0
    for pos in (px, py):
        hi = np.full(n_net, -np.inf); np.maximum.at(hi, pin_net, pos)
        lo = np.full(n_net, np.inf);  np.minimum.at(lo, pin_net, pos)
        tot += float((hi - lo).sum())
    return tot


def init_theta(obj, rng, region, n):
    """영역 안의 무작위 위치를 제약 부분공간으로 사영해 초기값을 만든다.

    theta 를 그냥 무작위로 뽑으면 블록이 영역 밖 멀리서 시작해서,
    경계 벌점을 미는 데 반복을 다 쓴다.
    """
    x0, y0, x1, y1 = region
    z_t = obj.z0.copy()
    z_t[0:2 * n:2] = rng.uniform(x0, x1, n)
    z_t[1:2 * n:2] = rng.uniform(y0, y1, n)
    th, *_ = np.linalg.lstsq(obj.N, z_t - obj.z0, rcond=None)
    return th


def adam(obj, theta, iters, lr, lam_grow, mu_grow, verbose=False):
    m = np.zeros_like(theta)
    v = np.zeros_like(theta)
    obj.calibrate(theta)                 # 세 항의 출발 규모를 맞춘다
    b1, b2, eps = 0.9, 0.999, 1e-8
    for t in range(1, iters + 1):
        val, g, info = obj(theta)
        m = b1 * m + (1 - b1) * g
        v = b2 * v + (1 - b2) * g * g
        mh = m / (1 - b1 ** t)
        vh = v / (1 - b2 ** t)
        theta = theta - lr * mh / (np.sqrt(vh) + eps)
        if t % 50 == 0:
            obj.lam *= lam_grow          # 담금질: 점점 딱딱하게
            obj.mu *= mu_grow            # 영역 밖은 점점 더 비싸게
            if verbose:
                cx, cy = obj.centers(theta)
                of = obj.dens.overflow(cx, cy, obj.w, obj.h)
                print(f"    it {t:4d}  E={val:11.4g}  W={info['W']:9.4g} "
                      f"D={info['D']:9.4g}  B={info['B']:9.4g} "
                      f"overflow={of:.3f}")
    return theta


def run(example, restarts, iters, verbose, legal=True, emit=False):
    path = find_placement(example)
    if not path:
        print(f"{example}: 배치 결과 없음")
        return
    pl = P.load(path)
    stem = os.path.basename(path).split(".scaled_placement_verilog")[0]
    mod = pl.top(stem)

    # --- ALIGN 결과에서 블록 정보 ---
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
    w = np.array(w, float); h = np.array(h, float)
    cx_a = np.array(cx_a, float); cy_a = np.array(cy_a, float)
    sx = np.array(sx, float); sy = np.array(sy, float)
    n = len(names)

    sizes = {nm: (w[i], h[i]) for i, nm in enumerate(names)}
    pin_inst, pin_off, pin_net, net_names = NL.extract(pl, mod)

    # --- 영공간 ---
    sysm, _ = S.build(mod.constraints, names, sizes)
    A, b = sysm.matrices()
    Nmat, rank = S.nullspace(A)
    z0 = S.particular(A, b)
    P_dof = Nmat.shape[1]

    region = tuple(mod.bbox)             # ALIGN 과 같은 면적 예산에서 비교
    print(f"\n{'=' * 68}\n{example}")
    print(f"  블록 {n}  넷 {len(net_names)}  핀 {len(pin_inst)}  "
          f"자유도 {sysm.n} -> {P_dof}")
    if len(pin_inst) == 0:
        print("  핀 정보 없음 (계층 하위 모듈 참조) — M1 범위 밖")
        return

    obj = E.Objective(z0, Nmat, n, w, h, pin_inst, pin_off, pin_net,
                      len(net_names), region, M=48)

    # --- 기울기 검증: 손으로 미분했으니 반드시 확인한다 ---
    rng = np.random.default_rng(0)
    err = E.check_grad(obj, rng.normal(scale=100, size=P_dof))
    print(f"  기울기 검증(유한차분 상대오차): {err:.3g}"
          f"  {'OK' if err < 1e-4 else '<-- 의심'}")

    # --- ALIGN 기준값 ---
    a_area = (mod.bbox[2] - mod.bbox[0]) * (mod.bbox[3] - mod.bbox[1])
    a_hpwl = hpwl(cx_a, cy_a, pin_inst, pin_off, pin_net, len(net_names), sx, sy)

    fill = float((w * h).sum() / a_area)
    print(f"  영역 채움률 {fill:.0%}  (ALIGN bbox 대비 블록 면적 합)")

    # --- 다중 시작 ---
    span = max(region[2] - region[0], region[3] - region[1])
    best, trials = None, []
    for r in range(restarts):
        th = init_theta(obj, rng, region, n)
        th = adam(obj, th, iters, lr=span / 400, lam_grow=1.30, mu_grow=1.25,
                  verbose=(verbose and r == 0))
        cx, cy = obj.centers(th)
        # 보고용 면적은 매끄러운 근사가 아니라 진짜 bbox 로 잰다.
        # (log-sum-exp 는 beta 가 작으면 log(n)/beta 만큼 부풀려진다)
        ar = (np.max(cx + w / 2) - np.min(cx - w / 2)) * \
             (np.max(cy + h / 2) - np.min(cy - h / 2))
        hp = hpwl(cx, cy, pin_inst, pin_off, pin_net, len(net_names), sx, sy)
        of = obj.dens.overflow(cx, cy, w, h)
        # 세 지표를 ALIGN 기준으로 정규화해 더한다.
        # 면적·겹침만 보면 배선이 엉망인 해를 고르게 된다 (실제로 그랬다).
        score = ar / a_area + hp / a_hpwl + 20 * of
        trials.append((ar, hp, of))
        if best is None or score < best[0]:
            best = (score, ar, hp, of, th)

    _, ar, hp, of, th = best
    cx, cy = obj.centers(th)

    # --- 대칭이 정말 정확한가 ---
    z = z0 + Nmat @ th
    resid = float(np.abs(A @ z - b).max()) if A.shape[0] else 0.0

    print(f"\n  {'':16s} {'ALIGN':>14s} {'M1':>14s}")
    print(f"  {'면적':16s} {a_area:14.4g} {ar:14.4g}   ({ar / a_area:.2f}x)")
    print(f"  {'HPWL':16s} {a_hpwl:14.4g} {hp:14.4g}   ({hp / a_hpwl:.2f}x)")
    print(f"  {'겹침(overflow)':16s} {'-':>14s} {of:14.3f}")
    print(f"  {'대칭 잔차':16s} {'-':>14s} {resid:14.3g}")

    # --- M1.5: 겹침 제거 ---
    if legal:
        from gpuplace import handoff as HO
        from gpuplace import legalize as LG
        ov0 = LG.exact_overlap(cx, cy, w, h)
        # 배선으로 넘기려면 oX/oY 가 정수여야 한다. 반올림 대신 MILP 제약으로 건다.
        gref = HO.grid_anchors(pl, mod) if emit else None
        th2, st = LG.legalize(z0, Nmat, n, w, h, cx, cy, region, grid_ref=gref)
        if th2 is None:
            print(f"\n  legalization 실패: {st}")
        else:
            cx2, cy2 = obj.centers(th2)
            ar2 = (np.max(cx2 + w / 2) - np.min(cx2 - w / 2)) * \
                  (np.max(cy2 + h / 2) - np.min(cy2 - h / 2))
            hp2 = hpwl(cx2, cy2, pin_inst, pin_off, pin_net, len(net_names), sx, sy)
            ov2 = LG.exact_overlap(cx2, cy2, w, h)
            z2 = z0 + Nmat @ th2
            rs2 = float(np.abs(A @ z2 - b).max()) if A.shape[0] else 0.0
            blk = float((w * h).sum())
            print(f"\n  legalization ({st})")
            print(f"  {'':16s} {'연속해':>14s} {'legalize 후':>14s}")
            print(f"  {'면적':16s} {ar:14.4g} {ar2:14.4g}   ({ar2 / a_area:.2f}x ALIGN)")
            print(f"  {'HPWL':16s} {hp:14.4g} {hp2:14.4g}   ({hp2 / a_hpwl:.2f}x ALIGN)")
            print(f"  {'겹침 면적':16s} {ov0:14.4g} {ov2:14.4g}   "
                  f"(블록 면적의 {ov2 / blk:.2%})")
            print(f"  {'대칭 잔차':16s} {resid:14.3g} {rs2:14.3g}")

            if emit:
                grid = HO.pdk_grid(os.environ.get(
                    "ALIGN_PDK",
                    os.path.join(os.environ.get("ALIGN_REPO", ""), "pdks", "FinFET14nm_Mock_PDK")))
                print(f"\n  배선 격자 (PDK): x {grid[0]}, y {grid[1]}")
                ncx, ncy, nbbox = HO.normalize(pl, mod, cx2, cy2, w, h, grid)
                ov3 = LG.exact_overlap(ncx, ncy, w, h)
                work = HO.prepare(f"{WORK}/{example}", f"{WORK}/{example}_ours")
                key = HO.inject(work, pl, mod, ncx, ncy, bbox=nbbox)
                moved = float(np.abs(np.r_[ncx - cx2, ncy - cy2]).max())
                # 다듬은 뒤에도 대칭이 남아 있는지 직접 확인
                z3 = z0.copy()
                z3[0:2 * n:2] = ncx
                z3[1:2 * n:2] = ncy
                if A.shape[0]:
                    Aa = A[:, 2 * n:]
                    rr = b - A[:, :2 * n] @ z3[:2 * n]
                    sol = np.linalg.lstsq(Aa, rr, rcond=None)[0] if Aa.shape[1] else []
                    rs3 = float(np.abs(Aa @ sol - rr).max()) if Aa.shape[1] else \
                        float(np.abs(rr).max())
                else:
                    rs3 = 0.0
                print(f"\n  배선용 출력: {work}")
                print(f"  정수·짝수·원점 정렬 후: 이동 {moved:.3g}, "
                      f"겹침 {ov3:.3g}, 대칭 잔차 {rs3:.3g}, bbox {nbbox}")
                print(f"  다음 명령으로 ALIGN 배선을 이어붙인다:")
                print(f"    schematic2layout.py $ALIGN_EXAMPLES/{example} "
                      f"-p $ALIGN_PDK -w {work} --flow_start 3_pnr:route")

    # 재시작을 늘리는 게(=M2) 의미 있으려면 시도별 품질이 벌어져 있어야 한다.
    # 분산이 작으면 병목은 표본 수가 아니라 목적함수/스케줄이다.
    t = np.array(trials)
    print(f"\n  재시작 {len(t)}회 분포")
    for k, nm in ((0, "면적"), (1, "HPWL"), (2, "겹침")):
        v = t[:, k]
        rng_ = (v.max() - v.min()) / max(abs(v.mean()), 1e-30)
        print(f"    {nm:6s} 최소 {v.min():10.4g}  중앙 {np.median(v):10.4g}  "
              f"최대 {v.max():10.4g}   폭/평균 {rng_:.2f}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("examples", nargs="*", default=["telescopic_ota"])
    ap.add_argument("--restarts", type=int, default=32)
    ap.add_argument("--iters", type=int, default=600)
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("--no-legalize", action="store_true")
    ap.add_argument("--emit", action="store_true",
                    help="배선으로 넘길 수 있게 work/<ex>_ours 에 출력")
    a = ap.parse_args()
    for ex in (a.examples or ["telescopic_ota"]):
        run(ex, a.restarts, a.iters, a.verbose, not a.no_legalize, a.emit)


if __name__ == "__main__":
    main()
