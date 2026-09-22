"""배치 에너지와 그 기울기 (numpy, 해석적 미분).

세 항이다.
    E = W + lambda * D + mu * A
    W  넷을 따라 당기는 스프링  (매끄럽게 만든 HPWL)
    D  같은 부호 전하들의 반발  (젤리움 = 전하 + 균일 중화 배경)
    A  전체를 가두는 항          (매끄럽게 만든 바운딩 박스 면적)

자동미분 없이 손으로 미분한 이유는 두 가지다. 이 환경에서 torch 설치가
계속 잘렸고, 손으로 쓰면 수식이 코드에 그대로 드러나 문서와 대조된다.
정확성은 finite difference 로 검증한다 (check_grad).

M2 에서 torch 로 옮길 때 이 파일의 forward 부분만 그대로 옮기면 된다.
"""
from __future__ import annotations

import numpy as np


# ---------------------------------------------------------------- 배선

def wirelength(px, py, pin_net, n_net, gamma):
    """매끄러운 HPWL 과 핀별 기울기.

    W_x(e) = sum(x_p e^{x_p/g}) / sum(e^{x_p/g})
           - sum(x_p e^{-x_p/g}) / sum(e^{-x_p/g})

    앞항이 부드러운 max, 뒷항이 부드러운 min 이다.
    """
    W = 0.0
    gx = np.zeros_like(px)
    gy = np.zeros_like(py)

    for pos, grad in ((px, gx), (py, gy)):
        # exp 가 터지지 않게 넷별 최댓값을 뺀다. W 는 평행이동에 불변이라 안전하다.
        hi = np.full(n_net, -np.inf)
        np.maximum.at(hi, pin_net, pos)
        lo = np.full(n_net, np.inf)
        np.minimum.at(lo, pin_net, pos)
        s = pos - hi[pin_net]
        t = lo[pin_net] - pos

        u = np.exp(s / gamma)                 # e^{(x-max)/g}
        v = np.exp(t / gamma)                 # e^{(min-x)/g}
        Su = np.bincount(pin_net, u, n_net)
        Sv = np.bincount(pin_net, v, n_net)
        Tu = np.bincount(pin_net, pos * u, n_net)
        Tv = np.bincount(pin_net, pos * v, n_net)

        A = Tu / Su                            # 부드러운 max
        B = Tv / Sv                            # 부드러운 min
        W += float((A - B).sum())

        # dA/dx_q = (u_q/Su)[1 + (x_q - A)/g],  dB/dx_q = (v_q/Sv)[1 - (x_q - B)/g]
        dA = (u / Su[pin_net]) * (1.0 + (pos - A[pin_net]) / gamma)
        dB = (v / Sv[pin_net]) * (1.0 - (pos - B[pin_net]) / gamma)
        grad += dA - dB

    return W, gx, gy


# ---------------------------------------------------------------- 밀도

def dct_matrix(M):
    """정규직교 DCT-II 행렬. C @ C.T = I 이므로 역변환이 C.T 다.

    격자가 작아서(M <= 128) 행렬을 그냥 만든다. FFT 로 하면 정규화를
    틀리기 쉬운데 여기서는 그럴 여지가 없다. M2 의 배치 연산에서는
    2M-point FFT 로 바꾼다.
    """
    n = np.arange(M)
    k = np.arange(M)[:, None]
    C = np.cos(np.pi * (n + 0.5) * k / M)
    C[0] *= np.sqrt(1.0 / M)
    C[1:] *= np.sqrt(2.0 / M)
    return C


def laplacian_eigs(M, h):
    """Neumann 경계 5점 라플라시안의 DCT-II 고유값."""
    k = np.arange(M)
    return 2.0 * (1.0 - np.cos(np.pi * k / M)) / h**2


def _overlap(c, half, g, ghalf):
    """블록과 빈의 1차원 겹침 길이와 그 미분."""
    blo, bhi = c - half, c + half
    glo, ghi = g - ghalf, g + ghalf
    lo = np.maximum(blo, glo)
    hi = np.minimum(bhi, ghi)
    ov = np.maximum(hi - lo, 0.0)
    d = np.where(ov > 0, (bhi < ghi).astype(float) - (blo > glo).astype(float), 0.0)
    return ov, d


class Density:
    """정전기 밀도항. 격자와 변환 행렬을 미리 만들어 둔다."""

    def __init__(self, region, M=64):
        """M 은 긴 변의 빈 개수. 짧은 변은 셀이 정사각형에 가깝도록 맞춘다.

        영역이 1440 x 11760 처럼 길쭉한데 M x M 정사각 격자를 쓰면
        셀이 30 x 245 로 찌그러진다. 그러면 세로 방향 해상도가 턱없이 모자라
        밀도장이 블록 모양을 제대로 못 본다.
        """
        x0, y0, x1, y1 = region
        W, H = x1 - x0, y1 - y0
        if W >= H:
            Mx, My = M, max(8, int(round(M * H / W)))
        else:
            My, Mx = M, max(8, int(round(M * W / H)))
        self.Mx, self.My = Mx, My
        self.hx, self.hy = W / Mx, H / My
        self.gx = x0 + (np.arange(Mx) + 0.5) * self.hx
        self.gy = y0 + (np.arange(My) + 0.5) * self.hy
        self.Cx = dct_matrix(Mx)
        self.Cy = dct_matrix(My)
        mu = laplacian_eigs(Mx, self.hx)
        nu = laplacian_eigs(My, self.hy)
        den = mu[:, None] + nu[None, :]
        den[0, 0] = 1.0                    # 0 으로 나누기 방지
        self.inv_den = 1.0 / den
        self.inv_den[0, 0] = 0.0           # 평균 성분은 버린다

    def __call__(self, cx, cy, w, h):
        ox, dox = _overlap(cx[:, None], w[:, None] / 2, self.gx[None, :], self.hx / 2)
        oy, doy = _overlap(cy[:, None], h[:, None] / 2, self.gy[None, :], self.hy / 2)

        cell = self.hx * self.hy
        rho = np.einsum("im,in->mn", ox, oy) / cell
        rho = rho - rho.mean()             # 균일 중화 배경

        R = self.Cx @ rho @ self.Cy.T
        psi = self.Cx.T @ (R * self.inv_den) @ self.Cy

        D = 0.5 * float((rho * psi).sum()) * cell

        # D = (cell/2) rho^T G rho  ->  dD/drho = cell * psi
        # (psi 는 평균이 0 이라 중화 항 -mean(rho) 의 미분은 0 이 된다)
        # drho_mn/dcx_i = dox[i,m] * oy[i,n] / cell 이므로 cell 이 약분된다.
        tx = psi @ oy.T                    # (M, N)
        ty = psi.T @ ox.T                  # (M, N)
        gcx = (dox * tx.T).sum(1)
        gcy = (doy * ty.T).sum(1)
        return D, gcx, gcy

    def overflow(self, cx, cy, w, h):
        """빈이 얼마나 넘치는지. 수렴 판단에 쓴다 (0 에 가까울수록 겹침 없음)."""
        ox, _ = _overlap(cx[:, None], w[:, None] / 2, self.gx[None, :], self.hx / 2)
        oy, _ = _overlap(cy[:, None], h[:, None] / 2, self.gy[None, :], self.hy / 2)
        cell = self.hx * self.hy
        rho = np.einsum("im,in->mn", ox, oy)
        return float(np.maximum(rho - cell, 0).sum() / (w * h).sum())


# ---------------------------------------------------------------- 면적

def area(cx, cy, w, h, beta):
    """매끄러운 바운딩 박스 면적과 기울기.

    x_max = (1/b) log sum exp(b (c + w/2))  — log-sum-exp 로 편 max
    """
    def smax(v):
        m = v.max()
        e = np.exp(beta * (v - m))
        s = e.sum()
        return m + np.log(s) / beta, e / s      # 값, softmax 가중치

    def smin(v):
        m = v.min()
        e = np.exp(-beta * (v - m))
        s = e.sum()
        return m - np.log(s) / beta, e / s

    xmax, wxh = smax(cx + w / 2)
    xmin, wxl = smin(cx - w / 2)
    ymax, wyh = smax(cy + h / 2)
    ymin, wyl = smin(cy - h / 2)

    Wd, Hd = xmax - xmin, ymax - ymin
    A = Wd * Hd
    return A, Hd * (wxh - wxl), Wd * (wyh - wyl), (xmin, ymin, xmax, ymax)


# ---------------------------------------------------------------- 전체

def boundary(cx, cy, w, h, region):
    """영역 밖으로 삐져나간 만큼의 제곱 벌점.

    밀도 격자는 region 안에만 있어서, 블록이 밖으로 나가면 척력을 아예 안 받는다.
    (밖은 전하가 없는 빈 공간처럼 보인다) 그래서 가두는 항이 따로 필요하다.
    """
    x0, y0, x1, y1 = region
    exl = np.maximum(x0 - (cx - w / 2), 0.0)
    exh = np.maximum((cx + w / 2) - x1, 0.0)
    eyl = np.maximum(y0 - (cy - h / 2), 0.0)
    eyh = np.maximum((cy + h / 2) - y1, 0.0)
    B = float((exl**2 + exh**2 + eyl**2 + eyh**2).sum())
    return B, 2 * (exh - exl), 2 * (eyh - eyl)


class Objective:
    """z = z0 + N theta 위에서 정의된 목적함수.

        E = W + lambda * D + mu * B

    영역(region)이 고정이므로 면적 최소화는 밀도항이 암묵적으로 한다.
    (좁은 영역에 다 넣으려면 겹치지 않게 촘촘히 놓는 수밖에 없다)
    """

    def __init__(self, z0, Nmat, n_inst, w, h, pin_inst, pin_off, pin_net,
                 n_net, region, M=48, gamma=None, beta=None):
        self.z0, self.N = z0, Nmat
        self.n = n_inst
        self.w, self.h = w, h
        self.pin_inst, self.pin_off, self.pin_net = pin_inst, pin_off, pin_net
        self.n_net = n_net
        self.region = region
        self.dens = Density(region, M)
        span = max(region[2] - region[0], region[3] - region[1])
        self.gamma = gamma if gamma else 0.02 * span
        self.beta = beta if beta else 8.0 / span
        self.lam, self.mu = 1.0, 1.0

    def centers(self, theta):
        z = self.z0 + self.N @ theta
        return z[0:2 * self.n:2], z[1:2 * self.n:2]

    def terms(self, theta, sx=None, sy=None):
        cx, cy = self.centers(theta)
        sx = np.ones(self.n) if sx is None else sx
        sy = np.ones(self.n) if sy is None else sy

        # 핀 좌표 = 블록 중심 + (반전 반영한) 오프셋
        px = cx[self.pin_inst] + sx[self.pin_inst] * self.pin_off[:, 0]
        py = cy[self.pin_inst] + sy[self.pin_inst] * self.pin_off[:, 1]

        W, gpx, gpy = wirelength(px, py, self.pin_net, self.n_net, self.gamma)
        gwx = np.bincount(self.pin_inst, gpx, self.n)
        gwy = np.bincount(self.pin_inst, gpy, self.n)

        D, gdx, gdy = self.dens(cx, cy, self.w, self.h)
        B, gbx, gby = boundary(cx, cy, self.w, self.h, self.region)
        return (cx, cy, (W, gwx, gwy), (D, gdx, gdy), (B, gbx, gby))

    def calibrate(self, theta, lam_ratio=1.0, mu_ratio=4.0):
        """세 항의 기울기 크기를 맞춘다.

        W ~ 1e4, D ~ 1e12 처럼 규모가 제각각이라 그대로 더하면 한 항이
        전부 잡아먹는다. 기울기 1-노름 비로 계수를 잡아 출발선을 맞춘다.
        """
        _, _, (_, gwx, gwy), (_, gdx, gdy), (_, gbx, gby) = self.terms(theta)
        nw = np.abs(gwx).sum() + np.abs(gwy).sum()
        nd = np.abs(gdx).sum() + np.abs(gdy).sum()
        nb = np.abs(gbx).sum() + np.abs(gby).sum()
        self.lam = lam_ratio * nw / max(nd, 1e-30)
        self.mu = mu_ratio * nw / max(nb, 1e-30) if nb > 0 else 1.0
        return self.lam, self.mu

    def __call__(self, theta, sx=None, sy=None):
        cx, cy, (W, gwx, gwy), (D, gdx, gdy), (B, gbx, gby) = self.terms(theta, sx, sy)

        E = W + self.lam * D + self.mu * B
        gcx = gwx + self.lam * gdx + self.mu * gbx
        gcy = gwy + self.lam * gdy + self.mu * gby

        gz = np.zeros_like(self.z0)
        gz[0:2 * self.n:2] = gcx
        gz[1:2 * self.n:2] = gcy

        _, _, _, box = area(cx, cy, self.w, self.h, self.beta)
        return E, self.N.T @ gz, dict(W=W, D=D, B=B, box=box)


def check_grad(obj, theta, eps=1e-4, k=8):
    """유한차분으로 기울기를 검증한다. 손으로 미분했으니 반드시 확인한다."""
    _, g, _ = obj(theta)
    idx = np.random.default_rng(0).choice(len(theta), min(k, len(theta)), replace=False)
    worst = 0.0
    for i in idx:
        tp, tm = theta.copy(), theta.copy()
        tp[i] += eps
        tm[i] -= eps
        num = (obj(tp)[0] - obj(tm)[0]) / (2 * eps)
        scale = max(abs(num), abs(g[i]), 1e-9)
        worst = max(worst, abs(num - g[i]) / scale)
    return worst
