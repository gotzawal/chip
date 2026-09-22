"""등식 제약을 A z = b 로 모으고, 영공간 매개화 z = z0 + N·theta 를 만든다.

배치 최적화에서 대칭·정렬 같은 등식 제약을 벌점으로 처리하면
수렴해야 맞고, 부동소수점 오차만큼 틀어진다. 아날로그에서는 대칭이
근사여선 곤란하다.

대신 등식이 전부 선형이라는 점을 쓴다. 자유 변수를 영공간에 두면
제약이 정의상 만족되고, 자유도도 줄어 탐색 공간이 작아진다.
물리에서 구속을 좌표계로 흡수하는 것과 같다.

변수 순서: [cx_0, cy_0, cx_1, cy_1, ..., axis_0, axis_1, ...]
(cx, cy 는 인스턴스 중심. axis 는 SymmetricBlocks 마다 하나씩 붙는 대칭축.)
"""
from __future__ import annotations

import numpy as np

# Align 의 *_any 는 "겹치기만 하면 된다"는 부등식이라 등식 계에 넣으면 안 된다.
ALIGN_EQ = {
    "h_top":    ("y", "max"),
    "h_bottom": ("y", "min"),
    "h_center": ("y", "center"),
    "v_left":   ("x", "min"),
    "v_right":  ("x", "max"),
    "v_center": ("x", "center"),
}


class System:
    """A z = b 를 모으는 도우미."""

    def __init__(self, inst_names, n_axis):
        self.inst = {n: i for i, n in enumerate(inst_names)}
        self.n_inst = len(inst_names)
        self.n_axis = n_axis
        self.n = 2 * self.n_inst + n_axis
        self.rows, self.rhs, self.why = [], [], []

    def cx(self, name):
        return 2 * self.inst[name]

    def cy(self, name):
        return 2 * self.inst[name] + 1

    def axis(self, k):
        return 2 * self.n_inst + k

    def add(self, terms, rhs, why):
        """terms: {열 인덱스: 계수}"""
        r = np.zeros(self.n)
        for c, v in terms.items():
            r[c] += v
        self.rows.append(r)
        self.rhs.append(rhs)
        self.why.append(why)

    def matrices(self):
        if not self.rows:
            return np.zeros((0, self.n)), np.zeros(0)
        return np.array(self.rows), np.array(self.rhs)


def build(constraints, inst_names, sizes):
    """제약 목록에서 등식 계를 만든다.

    sizes: {instance_name: (w, h)} — 배치된 크기(상수).
    반환: (System, 건너뛴 제약 목록)
    """
    sym = [c for c in constraints if c.get("constraint") == "SymmetricBlocks"]
    sysm = System(inst_names, n_axis=len(sym))
    skipped = []

    for k, c in enumerate(sym):
        v = c.get("direction", "V") == "V"      # V: 세로축(x 가 거울), H: 가로축
        mirror = sysm.cx if v else sysm.cy      # 거울 대칭이 걸리는 좌표
        same = sysm.cy if v else sysm.cx        # 같아야 하는 좌표
        a = sysm.axis(k)

        for pair in c["pairs"]:
            pair = [p for p in pair if p in sysm.inst]
            if len(pair) == 1:
                # 자기대칭: 중심이 축 위에 있어야 한다
                sysm.add({mirror(pair[0]): 1.0, a: -1.0}, 0.0,
                         f"SymmetricBlocks[{k}] self {pair[0]}")
            elif len(pair) == 2:
                A, B = pair
                # 거울 쌍: 축에서 같은 거리, 반대편
                sysm.add({mirror(A): 1.0, mirror(B): 1.0, a: -2.0}, 0.0,
                         f"SymmetricBlocks[{k}] pair {A}~{B}")
                sysm.add({same(A): 1.0, same(B): -1.0}, 0.0,
                         f"SymmetricBlocks[{k}] same {A}~{B}")

    for c in constraints:
        if c.get("constraint") != "Align":
            continue
        line = c.get("line")
        if line not in ALIGN_EQ:
            skipped.append((c.get("constraint"), line, "등식이 아님(겹침 조건)"))
            continue
        axis_xy, kind = ALIGN_EQ[line]
        names = [i for i in c["instances"] if i in sysm.inst]
        if len(names) < 2:
            continue
        col = sysm.cx if axis_xy == "x" else sysm.cy
        dim = 0 if axis_xy == "x" else 1

        def edge_offset(n):
            # 중심 기준 상수 오프셋. 중심이면 0, 최소변이면 -w/2, 최대변이면 +w/2
            half = sizes[n][dim] / 2
            return {"center": 0.0, "min": -half, "max": +half}[kind]

        ref = names[0]
        for n in names[1:]:
            # c_ref + off_ref = c_n + off_n  ->  c_ref - c_n = off_n - off_ref
            sysm.add({col(ref): 1.0, col(n): -1.0},
                     edge_offset(n) - edge_offset(ref),
                     f"Align({line}) {ref}~{n}")

    return sysm, skipped


def nullspace(A, tol=1e-9):
    """A 의 영공간 기저 N 과 랭크. z = z0 + N·theta 의 N."""
    if A.shape[0] == 0:
        return np.eye(A.shape[1]), 0
    U, S, Vt = np.linalg.svd(A)
    if S.size == 0:
        return np.eye(A.shape[1]), 0
    thresh = tol * max(A.shape) * S[0]
    rank = int((S > thresh).sum())
    return Vt[rank:].T, rank


def particular(A, b):
    """A z = b 의 특수해 (최소노름)."""
    if A.shape[0] == 0:
        return np.zeros(A.shape[1])
    return np.linalg.lstsq(A, b, rcond=None)[0]
