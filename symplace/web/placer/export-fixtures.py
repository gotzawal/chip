"""파이썬 구현을 정답으로 고정해 JS 포팅을 대조할 자료를 뽑는다.

영공간 기저 N 은 유일하지 않다(같은 부분공간의 아무 정규직교 기저나 된다).
그래서 theta 를 직접 비교하면 안 되고, 파이썬의 z0/N 을 그대로 넘겨
같은 매개화 위에서 E(theta) 와 grad 를 비교한다.
subspace 자체는 따로 성질 검사(A z = b, 랭크)로 확인한다.
"""
import json
import os
import sys

import numpy as np

WORK = os.environ.get("ALIGN_WORK", os.path.expanduser("~/align-work"))

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from gpuplace import energy as E          # noqa: E402
from gpuplace import netlist as NL        # noqa: E402
from gpuplace import placement as P       # noqa: E402
from gpuplace import subspace as S        # noqa: E402
import glob                               # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


def dump(example, n_theta=3, seed=0):
    # 배치 결과는 우리 배치기 출력(work/<예제>_ours)에 있다.
    want = example.upper()
    path = None
    for d in (f"{example}_ours", example):
        fs_ = sorted(glob.glob(
            os.path.join(WORK, d, "3_pnr", "Results",
                         "*.scaled_placement_verilog.json")))
        top = [f for f in fs_
               if os.path.basename(f).split(".scaled")[0].rsplit("_", 1)[0] == want]
        if top or fs_:
            path = (top or fs_)[0]; break
    if not path:
        print(f"{example}: 배치 결과 없음"); return
    pl = P.load(path)
    stem = os.path.basename(path).split(".scaled_placement_verilog")[0]
    mod = pl.top(stem)

    names, w, h, sx, sy, cxa, cya = [], [], [], [], [], [], []
    for inst in mod.instances:
        tb = pl.template_bbox(inst.concrete_template)
        if tb is None:
            continue
        c, wh = P.placed_center_size(tb, inst)
        names.append(inst.name); w.append(wh[0]); h.append(wh[1])
        cxa.append(c[0]); cya.append(c[1])
        sx.append(inst.sX); sy.append(inst.sY)
    w = np.array(w, float); h = np.array(h, float)
    sx = np.array(sx, float); sy = np.array(sy, float)
    cxa = np.array(cxa, float); cya = np.array(cya, float)
    n = len(names)

    pin_inst, pin_off, pin_net, net_names = NL.extract(pl, mod)
    sizes = {nm: (w[i], h[i]) for i, nm in enumerate(names)}
    sysm, skipped = S.build(mod.constraints, names, sizes)
    A, b = sysm.matrices()
    Nmat, rank = S.nullspace(A)
    z0 = S.particular(A, b)
    region = [float(v) for v in mod.bbox]

    obj = E.Objective(z0, Nmat, n, w, h, pin_inst, pin_off, pin_net,
                      len(net_names), tuple(region), M=48)

    rng = np.random.default_rng(seed)
    cases = []
    for i in range(n_theta):
        th = rng.normal(scale=100.0, size=Nmat.shape[1])
        if i == 0:
            obj.calibrate(th)               # lam/mu 를 여기서 고정
        Ev, g, info = obj(th, sx, sy)
        cx, cy = obj.centers(th)
        Wv, gwx, gwy = E.wirelength(
            cx[pin_inst] + sx[pin_inst] * pin_off[:, 0],
            cy[pin_inst] + sy[pin_inst] * pin_off[:, 1],
            pin_net, len(net_names), obj.gamma)
        Dv, gdx, gdy = obj.dens(cx, cy, w, h)
        Bv, gbx, gby = E.boundary(cx, cy, w, h, tuple(region))
        Av, _, _, box = E.area(cx, cy, w, h, obj.beta)
        cases.append(dict(
            theta=th.tolist(), E=float(Ev), grad=g.tolist(),
            W=float(Wv), D=float(Dv), B=float(Bv), area=float(Av),
            box=[float(v) for v in box],
            overflow=float(obj.dens.overflow(cx, cy, w, h)),
            cx=cx.tolist(), cy=cy.tolist()))

    fx = dict(
        example=example, n=n, names=names,
        w=w.tolist(), h=h.tolist(), sx=sx.tolist(), sy=sy.tolist(),
        region=region, n_net=len(net_names), net_names=net_names,
        cx_align=cxa.tolist(), cy_align=cya.tolist(),
        pin_inst=[int(v) for v in pin_inst],
        pin_off=[[float(a), float(bb)] for a, bb in pin_off],
        pin_net=[int(v) for v in pin_net],
        constraints=[c for c in mod.constraints],
        A=A.tolist(), b=b.tolist(), rank=int(rank),
        z0=z0.tolist(), N=Nmat.tolist(),
        M=48, gamma=float(obj.gamma), beta=float(obj.beta),
        lam=float(obj.lam), mu=float(obj.mu),
        dens=dict(Mx=int(obj.dens.Mx), My=int(obj.dens.My),
                  hx=float(obj.dens.hx), hy=float(obj.dens.hy)),
        cases=cases, skipped=[list(map(str, s)) for s in skipped])

    os.makedirs(OUT, exist_ok=True)
    p = f"{OUT}/{example}.json"
    with open(p, "w", encoding="utf8") as f:
        json.dump(fx, f)
    print(f"{example}: 블록 {n} 넷 {len(net_names)} 핀 {len(pin_inst)} "
          f"제약행 {A.shape[0]} 자유도 {Nmat.shape[1]}  -> {os.path.getsize(p)//1024} KB")


if __name__ == "__main__":
    ex = sys.argv[1:] or ["telescopic_ota", "high_speed_comparator",
                          "cascode_current_mirror_ota", "five_transistor_ota"]
    for e in ex:
        dump(e)
