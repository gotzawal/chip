/** 배치 에너지와 해석적 기울기. gpuplace/energy.py 의 이식.
 *
 *      E = W + lambda * D + mu * B
 *      W  넷을 따라 당기는 스프링  (매끄럽게 만든 HPWL)
 *      D  같은 부호 전하들의 반발  (젤리움 = 전하 + 균일 중화 배경)
 *      B  영역 밖으로 나간 만큼의 제곱 벌점
 *
 *  파이썬과 수식이 한 줄씩 대응하도록 썼다. 정확성은 test/parity.mjs 가
 *  파이썬이 뽑아둔 고정값과 대조해 확인한다.
 */
import { Mat, matmul } from "./linalg.mjs";

// ---------------------------------------------------------------- 배선

/** 매끄러운 HPWL 과 핀별 기울기.
 *
 *  W_x(e) = sum(x_p e^{x_p/g}) / sum(e^{x_p/g})
 *         - sum(x_p e^{-x_p/g}) / sum(e^{-x_p/g})
 *  앞항이 부드러운 max, 뒷항이 부드러운 min 이다.
 *
 *  ## 핀은 점이 아니라 사각형이다 — ex, ey 는 핀의 반폭
 *
 *  ALIGN 배치기의 비용(`HPWL_extend`)은 넷마다 핀 **경계 사각형**의 min/max 를
 *  잰다. 손가락 16 개를 한 줄로 늘어놓은 변이는 핀이 폭 5,000 짜리 막대인데,
 *  핀 중심 한 점으로 재면 그 길이가 통째로 사라져 길쭉한 변이가 공짜로 보였다
 *  (symplace/PLAN-place-variants-gpu.md 2.1 절). 그래서 max 에는 `x + ex`,
 *  min 에는 `x - ex` 를 넣는다. 식은 그대로고 넣는 점만 바뀐다 — 두 항 모두
 *  같은 x 로 미분되므로 기울기도 그대로 합쳐진다. ex, ey 를 안 주면 점이다.
 */
export function wirelength(px, py, pinNet, nNet, gamma, ex = null, ey = null) {
  const P = px.length;
  let W = 0;
  const gx = new Float64Array(P);
  const gy = new Float64Array(P);

  for (const [pos, ext, grad] of [[px, ex, gx], [py, ey, gy]]) {
    // exp 가 터지지 않게 넷별 최댓값/최솟값을 뺀다. W 는 평행이동에 불변이라 안전하다.
    const hi = new Float64Array(nNet).fill(-Infinity);
    const lo = new Float64Array(nNet).fill(Infinity);
    for (let p = 0; p < P; p++) {
      const e = pinNet[p], d = ext ? ext[p] : 0;
      if (pos[p] + d > hi[e]) hi[e] = pos[p] + d;
      if (pos[p] - d < lo[e]) lo[e] = pos[p] - d;
    }
    const u = new Float64Array(P), v = new Float64Array(P);
    const Su = new Float64Array(nNet), Sv = new Float64Array(nNet);
    const Tu = new Float64Array(nNet), Tv = new Float64Array(nNet);
    for (let p = 0; p < P; p++) {
      const e = pinNet[p], d = ext ? ext[p] : 0;
      const xh = pos[p] + d, xl = pos[p] - d;
      const up = Math.exp((xh - hi[e]) / gamma);
      const vp = Math.exp((lo[e] - xl) / gamma);
      u[p] = up; v[p] = vp;
      Su[e] += up; Sv[e] += vp;
      Tu[e] += xh * up; Tv[e] += xl * vp;
    }
    const A = new Float64Array(nNet), B = new Float64Array(nNet);
    for (let e = 0; e < nNet; e++) {
      A[e] = Tu[e] / Su[e];                  // 부드러운 max
      B[e] = Tv[e] / Sv[e];                  // 부드러운 min
      W += A[e] - B[e];
    }
    // dA/dx_q = (u_q/Su)[1 + (x_q + e_q - A)/g],  dB/dx_q = (v_q/Sv)[1 - (x_q - e_q - B)/g]
    for (let p = 0; p < P; p++) {
      const e = pinNet[p], d = ext ? ext[p] : 0;
      const dA = (u[p] / Su[e]) * (1 + (pos[p] + d - A[e]) / gamma);
      const dB = (v[p] / Sv[e]) * (1 - (pos[p] - d - B[e]) / gamma);
      grad[p] += dA - dB;
    }
  }
  return { W, gx, gy };
}

// ---------------------------------------------------------------- 밀도

/** 정규직교 DCT-II 행렬. C C^T = I 이므로 역변환이 C^T 다.
 *  격자가 작아서(M <= 128) 행렬을 그냥 만든다.
 */
export function dctMatrix(M) {
  const C = new Mat(M, M);
  const s0 = Math.sqrt(1 / M), s1 = Math.sqrt(2 / M);
  for (let k = 0; k < M; k++) {
    const s = k === 0 ? s0 : s1;
    for (let n = 0; n < M; n++) C.data[k * M + n] = Math.cos((Math.PI * (n + 0.5) * k) / M) * s;
  }
  return C;
}

/** Neumann 경계 5점 라플라시안의 DCT-II 고유값. */
export function laplacianEigs(M, h) {
  const e = new Float64Array(M);
  for (let k = 0; k < M; k++) e[k] = (2 * (1 - Math.cos((Math.PI * k) / M))) / (h * h);
  return e;
}

/** 블록과 빈의 1차원 겹침 길이와 그 미분. 결과는 (N x M) 두 장. */
function overlap1d(c, half, g, ghalf) {
  const N = c.length, M = g.length;
  const ov = new Mat(N, M), d = new Mat(N, M);
  for (let i = 0; i < N; i++) {
    const blo = c[i] - half[i], bhi = c[i] + half[i];
    const base = i * M;
    for (let m = 0; m < M; m++) {
      const glo = g[m] - ghalf, ghi = g[m] + ghalf;
      const loo = blo > glo ? blo : glo;
      const hii = bhi < ghi ? bhi : ghi;
      const o = hii - loo;
      if (o > 0) {
        ov.data[base + m] = o;
        d.data[base + m] = (bhi < ghi ? 1 : 0) - (blo > glo ? 1 : 0);
      }
    }
  }
  return { ov, d };
}

/** numpy 의 int(round(x)) 와 맞추기 위한 짝수 반올림. */
function roundHalfToEven(x) {
  const f = Math.floor(x), diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** 정전기 밀도항. 격자와 변환 행렬을 미리 만들어 둔다. */
export class Density {
  /** M 은 긴 변의 빈 개수. 짧은 변은 셀이 정사각형에 가깝도록 맞춘다.
   *  영역이 1440 x 11760 처럼 길쭉한데 M x M 정사각 격자를 쓰면
   *  셀이 30 x 245 로 찌그러져 밀도장이 블록 모양을 못 본다.
   */
  constructor(region, M = 64) {
    const [x0, y0, x1, y1] = region;
    const W = x1 - x0, H = y1 - y0;
    let Mx, My;
    if (W >= H) { Mx = M; My = Math.max(8, roundHalfToEven((M * H) / W)); }
    else { My = M; Mx = Math.max(8, roundHalfToEven((M * W) / H)); }
    this.Mx = Mx; this.My = My;
    this.hx = W / Mx; this.hy = H / My;
    this.gx = new Float64Array(Mx);
    this.gy = new Float64Array(My);
    for (let i = 0; i < Mx; i++) this.gx[i] = x0 + (i + 0.5) * this.hx;
    for (let i = 0; i < My; i++) this.gy[i] = y0 + (i + 0.5) * this.hy;
    this.Cx = dctMatrix(Mx);
    this.Cy = dctMatrix(My);
    const mu = laplacianEigs(Mx, this.hx);
    const nu = laplacianEigs(My, this.hy);
    this.invDen = new Mat(Mx, My);
    for (let m = 0; m < Mx; m++)
      for (let n = 0; n < My; n++) {
        const den = mu[m] + nu[n];
        this.invDen.data[m * My + n] = den === 0 ? 0 : 1 / den;
      }
    this.invDen.data[0] = 0;                 // 평균 성분은 버린다
  }

  /** 밀도 에너지와 기울기 — **랭크 N 항등식**으로 푼다.
   *
   *  원래 식은 rho (Mx x My) 를 만들고 DCT 를 네 번 곱해 psi 를 얻는 것이었다:
   *      rho = sum_i ox_i oy_i^T / cell,  rho -= mean
   *      psi = Cx^T ((Cx rho Cy^T) o invDen) Cy,   D = (cell/2) <rho, psi>
   *  그런데 rho 가 블록별 외적의 합(랭크 N)이라 DCT 가 외적 안으로 들어간다:
   *      R = Cx rho Cy^T = sum_i u_i v_i^T / cell      u_i = Cx ox_i,  v_i = Cy oy_i
   *      S = R o invDen
   *      D = (cell/2) <R, S>                            (DCT 가 직교라 <rho, psi> = <R, S>)
   *      gcx_i = dox_i^T psi oy_i = (Cx dox_i)^T S v_i
   *      gcy_i = ox_i^T psi doy_i = u_i^T S (Cy doy_i)
   *  평균 빼기는 R[0,0] 만 바꾸는데 invDen[0,0] = 0 이 그것을 지우므로 결과가 같다.
   *  psi 와 rho 는 만들지 않는다 — 곱셈이 4 M^3 에서 4 N M^2 + 3 N Mx My 로 줄고
   *  (N=11, M=48 에서 3 배), 시작점당 남는 격자 상태가 S 하나라 GPU 로 옮기기 좋다.
   *  결과는 실수 산술로 같은 식이다 — test/parity.mjs 가 반올림 오차 안에서 확인한다.
   */
  eval(cx, cy, w, h) {
    const N = cx.length, { Mx, My } = this;
    const halfW = new Float64Array(N), halfH = new Float64Array(N);
    for (let i = 0; i < N; i++) { halfW[i] = w[i] / 2; halfH[i] = h[i] / 2; }
    const { ov: ox, d: dox } = overlap1d(cx, halfW, this.gx, this.hx / 2);
    const { ov: oy, d: doy } = overlap1d(cy, halfH, this.gy, this.hy / 2);
    const cell = this.hx * this.hy;
    const Cx = this.Cx.data, Cy = this.Cy.data, inv = this.invDen.data;

    // u_i = Cx ox_i, a_i = Cx dox_i (N x Mx);  v_i = Cy oy_i, b_i = Cy doy_i (N x My)
    const U = new Float64Array(N * Mx), Ad = new Float64Array(N * Mx);
    const V = new Float64Array(N * My), Bd = new Float64Array(N * My);
    for (let i = 0; i < N; i++) {
      const bx = i * Mx;
      for (let k = 0; k < Mx; k++) {
        let s = 0, t = 0;
        const ck = k * Mx;
        for (let m = 0; m < Mx; m++) { s += Cx[ck + m] * ox.data[bx + m]; t += Cx[ck + m] * dox.data[bx + m]; }
        U[bx + k] = s; Ad[bx + k] = t;
      }
      const by = i * My;
      for (let l = 0; l < My; l++) {
        let s = 0, t = 0;
        const cl = l * My;
        for (let n = 0; n < My; n++) { s += Cy[cl + n] * oy.data[by + n]; t += Cy[cl + n] * doy.data[by + n]; }
        V[by + l] = s; Bd[by + l] = t;
      }
    }

    // S = (sum_i u_i v_i^T / cell) o invDen,   D = (cell/2) sum R o S
    const S = new Float64Array(Mx * My);
    let D = 0;
    for (let k = 0; k < Mx; k++) {
      for (let l = 0; l < My; l++) {
        let r = 0;
        for (let i = 0; i < N; i++) r += U[i * Mx + k] * V[i * My + l];
        r /= cell;
        const s = inv[k * My + l] * r;
        S[k * My + l] = s;
        D += r * s;
      }
    }
    D *= 0.5 * cell;

    // gcx_i = a_i^T S v_i,  gcy_i = u_i^T S b_i
    const gcx = new Float64Array(N), gcy = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const bx = i * Mx, by = i * My;
      let sx = 0, sy = 0;
      for (let k = 0; k < Mx; k++) {
        const ak = Ad[bx + k], uk = U[bx + k];
        if (ak === 0 && uk === 0) continue;
        const sk = k * My;
        let tv = 0;
        for (let l = 0; l < My; l++) {
          const s = S[sk + l];
          tv += s * V[by + l];
          sy += uk * s * Bd[by + l];
        }
        sx += ak * tv;
      }
      gcx[i] = sx; gcy[i] = sy;
    }
    return { D, gcx, gcy };
  }

  /** 빈이 얼마나 넘치는지. 0 에 가까울수록 겹침이 없다. */
  overflow(cx, cy, w, h) {
    const N = cx.length, { Mx, My } = this;
    const halfW = new Float64Array(N), halfH = new Float64Array(N);
    for (let i = 0; i < N; i++) { halfW[i] = w[i] / 2; halfH[i] = h[i] / 2; }
    const { ov: ox } = overlap1d(cx, halfW, this.gx, this.hx / 2);
    const { ov: oy } = overlap1d(cy, halfH, this.gy, this.hy / 2);
    const cell = this.hx * this.hy;
    const rho = new Float64Array(Mx * My);
    for (let i = 0; i < N; i++) {
      const bx = i * Mx, by = i * My;
      for (let m = 0; m < Mx; m++) {
        const a = ox.data[bx + m];
        if (a === 0) continue;
        for (let n = 0; n < My; n++) rho[m * My + n] += a * oy.data[by + n];
      }
    }
    let over = 0;
    for (let i = 0; i < rho.length; i++) if (rho[i] > cell) over += rho[i] - cell;
    let tot = 0;
    for (let i = 0; i < N; i++) tot += w[i] * h[i];
    return over / tot;
  }
}

// ---------------------------------------------------------------- 면적

/** 매끄러운 바운딩 박스 면적과 기울기.
 *  x_max = (1/b) log sum exp(b (c + w/2))  — log-sum-exp 로 편 max
 */
export function area(cx, cy, w, h, beta) {
  const N = cx.length;
  const smax = (v) => {
    let m = -Infinity;
    for (const x of v) if (x > m) m = x;
    const e = new Float64Array(N);
    let s = 0;
    for (let i = 0; i < N; i++) { e[i] = Math.exp(beta * (v[i] - m)); s += e[i]; }
    for (let i = 0; i < N; i++) e[i] /= s;
    return [m + Math.log(s) / beta, e];
  };
  const smin = (v) => {
    let m = Infinity;
    for (const x of v) if (x < m) m = x;
    const e = new Float64Array(N);
    let s = 0;
    for (let i = 0; i < N; i++) { e[i] = Math.exp(-beta * (v[i] - m)); s += e[i]; }
    for (let i = 0; i < N; i++) e[i] /= s;
    return [m - Math.log(s) / beta, e];
  };
  const mk = (c, d, sign) => {
    const v = new Float64Array(N);
    for (let i = 0; i < N; i++) v[i] = c[i] + (sign * d[i]) / 2;
    return v;
  };
  const [xmax, wxh] = smax(mk(cx, w, +1));
  const [xmin, wxl] = smin(mk(cx, w, -1));
  const [ymax, wyh] = smax(mk(cy, h, +1));
  const [ymin, wyl] = smin(mk(cy, h, -1));

  const Wd = xmax - xmin, Hd = ymax - ymin;
  const gx = new Float64Array(N), gy = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    gx[i] = Hd * (wxh[i] - wxl[i]);
    gy[i] = Wd * (wyh[i] - wyl[i]);
  }
  return { A: Wd * Hd, gx, gy, box: [xmin, ymin, xmax, ymax] };
}

// ---------------------------------------------------------------- 전체

/** 영역 밖으로 삐져나간 만큼의 제곱 벌점.
 *  밀도 격자는 region 안에만 있어서 블록이 밖으로 나가면 척력을 아예 안 받는다.
 */
export function boundary(cx, cy, w, h, region) {
  const [x0, y0, x1, y1] = region;
  const N = cx.length;
  let B = 0;
  const gx = new Float64Array(N), gy = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const exl = Math.max(x0 - (cx[i] - w[i] / 2), 0);
    const exh = Math.max(cx[i] + w[i] / 2 - x1, 0);
    const eyl = Math.max(y0 - (cy[i] - h[i] / 2), 0);
    const eyh = Math.max(cy[i] + h[i] / 2 - y1, 0);
    B += exl * exl + exh * exh + eyl * eyl + eyh * eyh;
    gx[i] = 2 * (exh - exl);
    gy[i] = 2 * (eyh - eyl);
  }
  return { B, gx, gy };
}

/** z = z0 + N theta 위에서 정의된 목적함수. */
export class Objective {
  constructor({ z0, N, nInst, w, h, pinInst, pinOff, pinNet, nNet, region,
                M = 48, gamma = null, beta = null, sx = null, sy = null,
                pinExt = null }) {
    this.z0 = z0; this.N = N;
    this.n = nInst;
    this.w = w; this.h = h;
    this.pinInst = pinInst; this.pinOff = pinOff; this.pinNet = pinNet;
    // 핀 반폭 [ex, ey] (핀당 2 개). 반전에 무관하다 — 오프셋 부호만 바뀌고 폭은 그대로다.
    this.pinExt = pinExt;
    const P = pinInst.length;
    this.pinEx = new Float64Array(P); this.pinEy = new Float64Array(P);
    if (pinExt) for (let p = 0; p < P; p++) { this.pinEx[p] = pinExt[2 * p]; this.pinEy[p] = pinExt[2 * p + 1]; }
    this.nNet = nNet;
    this.region = region;
    this.dens = new Density(region, M);
    const span = Math.max(region[2] - region[0], region[3] - region[1]);
    this.gamma = gamma ?? 0.02 * span;
    this.beta = beta ?? 8.0 / span;
    this.lam = 1.0; this.mu = 1.0;
    this.sx = sx ?? new Float64Array(nInst).fill(1);
    this.sy = sy ?? new Float64Array(nInst).fill(1);
  }

  centers(theta) {
    const z = Float64Array.from(this.z0);
    const { N } = this;
    for (let i = 0; i < N.rows; i++) {
      let s = 0;
      const base = i * N.cols;
      for (let j = 0; j < N.cols; j++) s += N.data[base + j] * theta[j];
      z[i] += s;
    }
    const cx = new Float64Array(this.n), cy = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) { cx[i] = z[2 * i]; cy[i] = z[2 * i + 1]; }
    return { cx, cy };
  }

  terms(theta) {
    const { cx, cy } = this.centers(theta);
    const P = this.pinInst.length;
    const px = new Float64Array(P), py = new Float64Array(P);
    for (let p = 0; p < P; p++) {
      const i = this.pinInst[p];
      px[p] = cx[i] + this.sx[i] * this.pinOff[2 * p];
      py[p] = cy[i] + this.sy[i] * this.pinOff[2 * p + 1];
    }
    const { W, gx: gpx, gy: gpy } = wirelength(px, py, this.pinNet, this.nNet, this.gamma,
                                               this.pinEx, this.pinEy);
    const gwx = new Float64Array(this.n), gwy = new Float64Array(this.n);
    for (let p = 0; p < P; p++) {
      const i = this.pinInst[p];
      gwx[i] += gpx[p]; gwy[i] += gpy[p];
    }
    const den = this.dens.eval(cx, cy, this.w, this.h);
    const bnd = boundary(cx, cy, this.w, this.h, this.region);
    return { cx, cy, W, gwx, gwy, den, bnd };
  }

  /** 세 항의 기울기 1-노름을 맞춘다. W ~ 1e4, D ~ 1e12 처럼 규모가 제각각이라
   *  그대로 더하면 한 항이 전부 잡아먹는다. */
  calibrate(theta, lamRatio = 1.0, muRatio = 4.0) {
    const { gwx, gwy, den, bnd } = this.terms(theta);
    const l1 = (a, b) => {
      let s = 0;
      for (let i = 0; i < a.length; i++) s += Math.abs(a[i]) + Math.abs(b[i]);
      return s;
    };
    const nw = l1(gwx, gwy);
    const nd = l1(den.gcx, den.gcy);
    const nb = l1(bnd.gx, bnd.gy);
    this.lam = (lamRatio * nw) / Math.max(nd, 1e-30);
    this.mu = nb > 0 ? (muRatio * nw) / Math.max(nb, 1e-30) : 1.0;
    return { lam: this.lam, mu: this.mu };
  }

  eval(theta) {
    const { cx, cy, W, gwx, gwy, den, bnd } = this.terms(theta);
    const E = W + this.lam * den.D + this.mu * bnd.B;

    const gz = new Float64Array(this.z0.length);
    for (let i = 0; i < this.n; i++) {
      gz[2 * i] = gwx[i] + this.lam * den.gcx[i] + this.mu * bnd.gx[i];
      gz[2 * i + 1] = gwy[i] + this.lam * den.gcy[i] + this.mu * bnd.gy[i];
    }
    const { N } = this;
    const grad = new Float64Array(N.cols);
    for (let i = 0; i < N.rows; i++) {
      const g = gz[i];
      if (g === 0) continue;
      const base = i * N.cols;
      for (let j = 0; j < N.cols; j++) grad[j] += N.data[base + j] * g;
    }
    const { box } = area(cx, cy, this.w, this.h, this.beta);
    return { E, grad, W, D: den.D, B: bnd.B, box, cx, cy };
  }
}

/** 유한차분으로 기울기를 검증한다. 손으로 미분했으니 반드시 확인한다. */
export function checkGrad(obj, theta, eps = 1e-4, k = 8) {
  const { grad } = obj.eval(theta);
  const idx = [];
  for (let i = 0; i < Math.min(k, theta.length); i++) idx.push(i);
  let worst = 0;
  for (const i of idx) {
    const tp = Float64Array.from(theta), tm = Float64Array.from(theta);
    tp[i] += eps; tm[i] -= eps;
    const num = (obj.eval(tp).E - obj.eval(tm).E) / (2 * eps);
    const scale = Math.max(Math.abs(num), Math.abs(grad[i]), 1e-9);
    worst = Math.max(worst, Math.abs(num - grad[i]) / scale);
  }
  return worst;
}
