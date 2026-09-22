"""M2: 배치 차원을 추가해 수천 개 시작점을 동시에 굴린다.

M1 은 재시작을 순차로 돌았다. 분포를 재보니 HPWL 의 폭/평균이 1.02 로,
좋은 해가 드물게 나온다 (telescopic_ota: 최소 1.269e4, 중앙 2.379e4).
표본을 늘리는 게 곧 품질이다.

알고리즘은 M1 과 같다. 모든 텐서 앞에 B 축을 붙였을 뿐이다.
    theta  [B, P]        cx, cy  [B, N]        rho, psi  [B, Mx, My]
배치끼리 완전히 독립이라 그냥 쌓으면 된다.

torch 없이 numpy 로 한 이유는 이 환경에서 torch 설치가 두 번 잘렸기 때문이다.
격자가 작아서(telescopic_ota 는 8x64) B=4096 이어도 rho 가 16MB 남짓이라
numpy 로 충분하다. GPU 로 옮길 때는 np -> torch 치환이면 된다.

정확성은 M1 구현(gpuplace.energy)과 값을 맞춰 검증한다 (cross_check).
"""
from __future__ import annotations

import numpy as np

from gpuplace.energy import _overlap, dct_matrix, laplacian_eigs


class BatchObjective:
    def __init__(self, z0, Nmat, n_inst, w, h, pin_inst, pin_off, pin_net,
                 n_net, region, M=64, gamma=None, beta=None):
        self.z0, self.N = z0, Nmat
        self.n, self.P = n_inst, Nmat.shape[1]
        self.w, self.h = w, h
        self.n_net = n_net

        # 핀을 넷 순으로 정렬해 두면 reduceat 로 넷별 집계가 한 번에 된다.
        order = np.argsort(pin_net, kind="stable")
        self.pin_inst = pin_inst[order]
        self.pin_off = pin_off[order]
        self.pin_net = pin_net[order]
        self.starts = np.searchsorted(self.pin_net, np.arange(n_net))

        x0, y0, x1, y1 = region
        self.region = region
        W, H = x1 - x0, y1 - y0
        if W >= H:
            Mx, My = M, max(8, int(round(M * H / W)))
        else:
            My, Mx = M, max(8, int(round(M * W / H)))
        self.Mx, self.My = Mx, My
        self.hx, self.hy = W / Mx, H / My
        self.gx = x0 + (np.arange(Mx) + 0.5) * self.hx
        self.gy = y0 + (np.arange(My) + 0.5) * self.hy
        self.Cx, self.Cy = dct_matrix(Mx), dct_matrix(My)
        den = laplacian_eigs(Mx, self.hx)[:, None] + \
            laplacian_eigs(My, self.hy)[None, :]
        den[0, 0] = 1.0
        self.inv_den = 1.0 / den
        self.inv_den[0, 0] = 0.0

        span = max(W, H)
        self.gamma = gamma if gamma else 0.02 * span
        self.beta = beta if beta else 8.0 / span
        self.lam, self.mu = 1.0, 1.0

    # ---------------------------------------------------------------- 좌표
    def centers(self, theta):
        z = self.z0[None, :] + theta @ self.N.T          # [B, 2N+K]
        return z[:, 0:2 * self.n:2], z[:, 1:2 * self.n:2]

    # ---------------------------------------------------------------- 배선
    def _wire(self, pos):
        """pos: [B, n_pin] -> (W [B], dW/dpos [B, n_pin])"""
        st = self.starts
        hi = np.maximum.reduceat(pos, st, axis=1)        # [B, n_net]
        lo = np.minimum.reduceat(pos, st, axis=1)
        u = np.exp((pos - hi[:, self.pin_net]) / self.gamma)
        v = np.exp((lo[:, self.pin_net] - pos) / self.gamma)

        Su = np.add.reduceat(u, st, axis=1)
        Sv = np.add.reduceat(v, st, axis=1)
        A = np.add.reduceat(pos * u, st, axis=1) / Su    # 부드러운 max
        B = np.add.reduceat(pos * v, st, axis=1) / Sv    # 부드러운 min

        dA = (u / Su[:, self.pin_net]) * \
             (1.0 + (pos - A[:, self.pin_net]) / self.gamma)
        dB = (v / Sv[:, self.pin_net]) * \
             (1.0 - (pos - B[:, self.pin_net]) / self.gamma)
        return (A - B).sum(1), dA - dB

    # ---------------------------------------------------------------- 밀도
    def _density(self, cx, cy):
        ox, dox = _overlap(cx[:, :, None], self.w[None, :, None] / 2,
                           self.gx[None, None, :], self.hx / 2)   # [B, N, Mx]
        oy, doy = _overlap(cy[:, :, None], self.h[None, :, None] / 2,
                           self.gy[None, None, :], self.hy / 2)   # [B, N, My]
        cell = self.hx * self.hy
        rho = np.einsum("bim,bin->bmn", ox, oy) / cell
        rho = rho - rho.mean(axis=(-2, -1), keepdims=True)

        R = self.Cx @ rho @ self.Cy.T
        psi = self.Cx.T @ (R * self.inv_den[None]) @ self.Cy

        D = 0.5 * (rho * psi).sum(axis=(-2, -1)) * cell
        tx = np.einsum("bmn,bin->bmi", psi, oy)
        ty = np.einsum("bmn,bim->bni", psi, ox)
        gcx = np.einsum("bim,bmi->bi", dox, tx)
        gcy = np.einsum("bin,bni->bi", doy, ty)
        return D, gcx, gcy

    def overflow(self, cx, cy):
        ox, _ = _overlap(cx[:, :, None], self.w[None, :, None] / 2,
                         self.gx[None, None, :], self.hx / 2)
        oy, _ = _overlap(cy[:, :, None], self.h[None, :, None] / 2,
                         self.gy[None, None, :], self.hy / 2)
        cell = self.hx * self.hy
        rho = np.einsum("bim,bin->bmn", ox, oy)
        return np.maximum(rho - cell, 0).sum(axis=(-2, -1)) / (self.w * self.h).sum()

    # ---------------------------------------------------------------- 전체
    def terms(self, theta):
        cx, cy = self.centers(theta)
        px = cx[:, self.pin_inst] + self.pin_off[None, :, 0]
        py = cy[:, self.pin_inst] + self.pin_off[None, :, 1]

        Wv, gpx = self._wire(px)
        Wh, gpy = self._wire(py)
        B_ = theta.shape[0]
        gwx = np.zeros((B_, self.n)); np.add.at(gwx, (slice(None), self.pin_inst), gpx)
        gwy = np.zeros((B_, self.n)); np.add.at(gwy, (slice(None), self.pin_inst), gpy)

        D, gdx, gdy = self._density(cx, cy)

        x0, y0, x1, y1 = self.region
        exl = np.maximum(x0 - (cx - self.w / 2), 0.0)
        exh = np.maximum((cx + self.w / 2) - x1, 0.0)
        eyl = np.maximum(y0 - (cy - self.h / 2), 0.0)
        eyh = np.maximum((cy + self.h / 2) - y1, 0.0)
        Bd = (exl**2 + exh**2 + eyl**2 + eyh**2).sum(1)
        return (cx, cy, (Wv + Wh, gwx, gwy), (D, gdx, gdy),
                (Bd, 2 * (exh - exl), 2 * (eyh - eyl)))

    def calibrate(self, theta, lam_ratio=1.0, mu_ratio=4.0):
        _, _, (_, gwx, gwy), (_, gdx, gdy), (_, gbx, gby) = self.terms(theta)
        nw = np.abs(gwx).sum() + np.abs(gwy).sum()
        nd = np.abs(gdx).sum() + np.abs(gdy).sum()
        nb = np.abs(gbx).sum() + np.abs(gby).sum()
        self.lam = lam_ratio * nw / max(nd, 1e-30)
        self.mu = mu_ratio * nw / max(nb, 1e-30) if nb > 0 else 1.0

    def __call__(self, theta):
        cx, cy, (W, gwx, gwy), (D, gdx, gdy), (Bd, gbx, gby) = self.terms(theta)
        E = W + self.lam * D + self.mu * Bd              # [B]
        gcx = gwx + self.lam * gdx + self.mu * gbx
        gcy = gwy + self.lam * gdy + self.mu * gby

        gz = np.zeros((theta.shape[0], self.z0.shape[0]))
        gz[:, 0:2 * self.n:2] = gcx
        gz[:, 1:2 * self.n:2] = gcy
        return E, gz @ self.N, dict(W=W, D=D, B=Bd)


def adam(obj, theta, iters, lr, lam_grow, mu_grow):
    """배치 전체를 한꺼번에 내린다. 배치끼리 독립이라 그냥 elementwise 다."""
    m = np.zeros_like(theta)
    v = np.zeros_like(theta)
    obj.calibrate(theta)
    b1, b2, eps = 0.9, 0.999, 1e-8
    for t in range(1, iters + 1):
        _, g, _ = obj(theta)
        m = b1 * m + (1 - b1) * g
        v = b2 * v + (1 - b2) * g * g
        theta = theta - lr * (m / (1 - b1 ** t)) / (np.sqrt(v / (1 - b2 ** t)) + eps)
        if t % 50 == 0:
            obj.lam *= lam_grow
            obj.mu *= mu_grow
    return theta


def cross_check(bobj, sobj, theta1):
    """M1 의 단일 구현과 값·기울기가 같은지 확인한다.

    배치화하면서 einsum 축을 헷갈리기 쉽다. 같은 theta 를 넣어
    두 구현이 같은 답을 내는지 보면 그런 실수가 바로 드러난다.
    """
    sobj.lam, sobj.mu = bobj.lam, bobj.mu
    E1, g1, _ = sobj(theta1)
    E2, g2, _ = bobj(theta1[None, :])
    de = abs(E1 - E2[0]) / max(abs(E1), 1e-30)
    dg = np.abs(g1 - g2[0]).max() / max(np.abs(g1).max(), 1e-30)
    return de, dg
