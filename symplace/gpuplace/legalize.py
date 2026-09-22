"""겹침 제거 (legalization) — theta 공간에서 작은 MILP 로 푼다.

연속 최적화는 겹침을 "거의" 없앨 뿐 정확히 0 으로 만들지 못한다.
실측: 재시작 24회의 overflow 최소값이 0.0118 이었다. 표본을 아무리 늘려도
0 이 안 나온다 — 연속 완화의 본질적 한계다.

그래서 마무리는 이산으로 한다. 핵심은 x 가 아니라 theta 를 변수로 두는 것.
x 공간에서 블록을 밀면 대칭이 깨지지만, theta 공간에서는 어떻게 움직여도
x = z0 + N theta 가 제약을 만족한다. 게다가 자유도가 훨씬 적어
(telescopic_ota: 10 -> 7) MILP 가 작아진다.

겹침 배제는 고전적인 분리 조건이다. 두 블록은 넷 중 하나를 만족해야 한다.
    i 가 j 의 왼쪽 / 오른쪽 / 아래 / 위
이걸 big-M 과 이진변수로 쓴다.
"""
from __future__ import annotations

import numpy as np

try:
    from mip import BINARY, INTEGER, Model, OptimizationStatus, minimize, xsum
except ImportError:                       # pragma: no cover
    Model = None


def exact_overlap(cx, cy, w, h):
    """블록 쌍의 실제 겹침 면적 합. density overflow 와 달리 근사가 아니다."""
    n = len(cx)
    tot = 0.0
    for i in range(n):
        for j in range(i + 1, n):
            ox = min(cx[i] + w[i] / 2, cx[j] + w[j] / 2) - \
                 max(cx[i] - w[i] / 2, cx[j] - w[j] / 2)
            oy = min(cy[i] + h[i] / 2, cy[j] + h[j] / 2) - \
                 max(cy[i] - h[i] / 2, cy[j] - h[j] / 2)
            if ox > 0 and oy > 0:
                tot += ox * oy
    return tot


def legalize(z0, Nmat, n, w, h, cx_ref, cy_ref, region,
             bbox_weight=0.5, slack=1.6, time_limit=60, verbose=False,
             grid_ref=None, grid=(1, 1)):
    """연속해를 겹치지 않는 배치로 옮긴다.

    목적함수 = 연속해로부터의 이동거리(L1) + bbox_weight * 반둘레

    이동거리를 줄이는 이유는 연속 최적화가 찾아낸 배선 구조를 지키기 위해서다.
    반둘레 항은 선형이라 MILP 에 그대로 들어간다 (면적은 쌍선형이라 못 쓴다).

    반환: (theta, 상태문자열) — 실패하면 theta 는 None
    """
    if Model is None:
        return None, "mip 미설치"

    P = Nmat.shape[1]
    x0, y0, x1, y1 = region
    W, H = x1 - x0, y1 - y0
    # 원래 영역만 고집하면 풀 수 없을 수 있다. 여유를 줘서 실현 가능하게 만들고,
    # 대신 반둘레를 목적함수에 넣어 알아서 줄이게 한다.
    ex, ey = (slack - 1) * W / 2, (slack - 1) * H / 2
    rx0, rx1 = x0 - ex, x1 + ex
    ry0, ry1 = y0 - ey, y1 + ey
    BIG = 2 * (rx1 - rx0 + ry1 - ry0) + float(max(w.max(), h.max()))

    m = Model()
    m.verbose = 0

    span = max(W, H)
    th = [m.add_var(lb=-8 * span, ub=8 * span) for _ in range(P)]

    def X(i):
        return z0[2 * i] + xsum(Nmat[2 * i, k] * th[k] for k in range(P))

    def Y(i):
        return z0[2 * i + 1] + xsum(Nmat[2 * i + 1, k] * th[k] for k in range(P))

    XX = [X(i) for i in range(n)]
    YY = [Y(i) for i in range(n)]

    # 영역 안에 들어오게
    for i in range(n):
        m += XX[i] - w[i] / 2 >= rx0
        m += XX[i] + w[i] / 2 <= rx1
        m += YY[i] - h[i] / 2 >= ry0
        m += YY[i] + h[i] / 2 <= ry1

    # ALIGN 좌표는 정수다. 끝나고 반올림하면 대칭이 깨지므로,
    # 정수 조건을 여기서 제약으로 건다. theta 는 여전히 연속 변수이고
    # x = z0 + N theta 가 제약을 만족하므로 대칭은 그대로 유지된다.
    #   grid_ref = (ax, ay) : (X_i - ax_i) 와 (Y_i - ay_i) 가 정수여야 한다
    if grid_ref is not None:
        ax, ay = grid_ref
        qx, qy = grid
        # MILP 를 푼 뒤에 격자로 반올림하면 겹침이 되살아날 수 있다.
        # 격자 조건을 제약으로 넣어 solver 가 처음부터 지키게 한다.
        # theta 는 여전히 연속 변수라 대칭은 그대로 유지된다.
        # x 와 y 의 범위가 크게 다를 수 있다 (telescopic_ota: 1440 vs 11760).
        # 한쪽 기준으로 묶으면 다른 쪽이 범위 밖으로 나가 INFEASIBLE 이 된다.
        bx = int((abs(rx0) + abs(rx1) + max(abs(v) for v in ax)) / qx) + 10
        by = int((abs(ry0) + abs(ry1) + max(abs(v) for v in ay)) / qy) + 10
        for i in range(n):
            kx = m.add_var(var_type=INTEGER, lb=-bx, ub=bx)
            ky = m.add_var(var_type=INTEGER, lb=-by, ub=by)
            m += XX[i] - float(ax[i]) == qx * kx
            m += YY[i] - float(ay[i]) == qy * ky

    # 쌍마다 분리 조건 (넷 중 최소 하나)
    for i in range(n):
        for j in range(i + 1, n):
            bl = m.add_var(var_type=BINARY)
            br = m.add_var(var_type=BINARY)
            bb = m.add_var(var_type=BINARY)
            bt = m.add_var(var_type=BINARY)
            m += XX[i] + w[i] / 2 <= XX[j] - w[j] / 2 + BIG * (1 - bl)
            m += XX[j] + w[j] / 2 <= XX[i] - w[i] / 2 + BIG * (1 - br)
            m += YY[i] + h[i] / 2 <= YY[j] - h[j] / 2 + BIG * (1 - bb)
            m += YY[j] + h[j] / 2 <= YY[i] - h[i] / 2 + BIG * (1 - bt)
            m += bl + br + bb + bt >= 1

    # 이동거리 (L1)
    dx = [m.add_var(lb=0) for _ in range(n)]
    dy = [m.add_var(lb=0) for _ in range(n)]
    for i in range(n):
        m += dx[i] >= XX[i] - float(cx_ref[i])
        m += dx[i] >= float(cx_ref[i]) - XX[i]
        m += dy[i] >= YY[i] - float(cy_ref[i])
        m += dy[i] >= float(cy_ref[i]) - YY[i]

    # 반둘레 (면적 대용, 선형)
    xlo = m.add_var(lb=rx0, ub=rx1); xhi = m.add_var(lb=rx0, ub=rx1)
    ylo = m.add_var(lb=ry0, ub=ry1); yhi = m.add_var(lb=ry0, ub=ry1)
    for i in range(n):
        m += xlo <= XX[i] - w[i] / 2
        m += xhi >= XX[i] + w[i] / 2
        m += ylo <= YY[i] - h[i] / 2
        m += yhi >= YY[i] + h[i] / 2

    m.objective = minimize(
        xsum(dx) + xsum(dy) + bbox_weight * n * ((xhi - xlo) + (yhi - ylo)))

    st = m.optimize(max_seconds=time_limit)
    if st not in (OptimizationStatus.OPTIMAL, OptimizationStatus.FEASIBLE):
        return None, str(st).split(".")[-1]

    theta = np.array([v.x for v in th], dtype=float)
    return theta, ("OPTIMAL" if st == OptimizationStatus.OPTIMAL else "FEASIBLE")
