/** 연속 단계(Adam)를 WebGPU 로 — 시작점 수천 개를 한꺼번에.
 *
 *  solver.mjs 의 `adam` + `Objective.eval` 과 **같은 계산**을 컴퓨트 셰이더로 한다.
 *  워크그룹 하나가 시작점 하나다. 한 스텝은 여섯 패스다:
 *
 *      centers   z = z0 + N theta                       (스레드 = 행)
 *      wire      넷마다 부드러운 max/min, 핀 기울기      (스레드 = 넷, 그 다음 블록)
 *      overlap   u_i = Cx ox_i, a_i = Cx dox_i, v_i, b_i (스레드 = (블록, 격자 칸))
 *      spectrum  S = (sum_i u_i v_i^T / cell) o invDen,  D  (스레드 = 격자 칸)
 *      grad      gcx_i = a_i^T S v_i, 경계 벌점, gz     (스레드 = (블록, 칸) -> 블록)
 *      adam      grad_theta = N^T gz, Adam 갱신          (스레드 = theta 성분)
 *
 *  밀도항은 energy.mjs 의 랭크 N 항등식 그대로다 — rho 도 psi 도 없다.
 *
 *  ## 단위
 *
 *  WGSL 은 f32 다. 좌표를 설정마다 **영역의 긴 변으로 나눠** 무차원으로 둔다.
 *  그러면 gamma = 0.02, lr = 1/400 이 상수고 면적·배선이 1 언저리라 f32 로 충분하다.
 *  calibrate 가 lam, mu 를 기울기 비로 잡으므로 CPU 의 원래 단위와 **같은 궤적**이
 *  나온다 (반올림 차이만 남는다) — test/gpu.mjs 가 잰다.
 *
 *  ## 설정이 제각각이라 채운다
 *
 *  설정마다 n, P, Mx, My 가 다르다. 한 모듈의 설정 전체를 한 디스패치에 넣으려고
 *  최댓값(NMAX, PMAX, ...)으로 채우고, 스레드는 자기 설정의 크기 밖이면 논다.
 *  블록 16, theta 32, 격자 48 이면 시작점당 상태가 30 KB 남짓이다.
 *
 *  ## 밖에서 보는 모양
 *
 *      const runner = await createGpuRunner(gpu);   // gpu = navigator.gpu 또는 dawn 의 create()
 *      const out = await runner.runMany(prep, jobs, { iters, lamGrow, muGrow, lamRatio, muRatio });
 *      // prep[i] = { obj, z0, N }   (solver.mjs multiStartVariants 의 prep 과 같다)
 *      // jobs[j] = { p: prep 번호, theta0: Float64Array }
 *      // out[j]  = { theta: Float64Array (원래 단위), W, D, B }
 *
 *  화면 갱신은 chunk 단위로 제출하고 상태(theta, m, v, t)는 GPU 에 남는다 —
 *  끊어 돌린 것과 한 번에 돌린 것이 같다 (test/chunk.mjs 의 성질).
 */
import { laplacianEigs } from "../energy.mjs";

const WG = 64;

/** 설정 하나를 무차원 표로 편다. */
function normalizeConfig(p) {
  const { obj, z0, N } = p;
  const [x0, y0, x1, y1] = obj.region;
  const span = Math.max(x1 - x0, y1 - y0);
  const s = 1 / span;
  const n = obj.n, P = N.cols, rows = N.rows;
  const { Mx, My } = obj.dens;
  const hx = obj.dens.hx * s, hy = obj.dens.hy * s;
  const mu = laplacianEigs(Mx, hx), nu = laplacianEigs(My, hy);
  const invDen = new Float32Array(Mx * My);
  for (let m = 0; m < Mx; m++)
    for (let k = 0; k < My; k++) {
      const den = mu[m] + nu[k];
      invDen[m * My + k] = den === 0 ? 0 : 1 / den;
    }
  invDen[0] = 0;
  return {
    n, P, rows, Mx, My, span,
    z0: Float32Array.from(z0, (v) => v * s),
    N: N.data,                                   // 정규직교 — 무차원
    w: Float32Array.from(obj.w, (v) => v * s), h: Float32Array.from(obj.h, (v) => v * s),
    sx: obj.sx, sy: obj.sy,
    pinInst: obj.pinInst, pinNet: obj.pinNet,
    pinOff: Float32Array.from(obj.pinOff, (v) => v * s),
    pinEx: Float32Array.from(obj.pinEx, (v) => v * s), pinEy: Float32Array.from(obj.pinEy, (v) => v * s),
    nPins: obj.pinInst.length, nNets: obj.nNet,
    Cx: obj.dens.Cx.data, Cy: obj.dens.Cy.data, invDen,
    gx: Float32Array.from(obj.dens.gx, (v) => v * s), gy: Float32Array.from(obj.dens.gy, (v) => v * s),
    hx, hy, cell: hx * hy,
    region: [x0 * s, y0 * s, x1 * s, y1 * s],
    gamma: obj.gamma / span,                     // 0.02
    lr: 1 / 400,
  };
}

/** 표의 크기 상수. 채움의 최댓값이라 셰이더 문자열에 박힌다. */
function layoutOf(cfgs) {
  const mx = (f) => Math.max(1, ...cfgs.map(f));
  const L = {
    NMAX: mx((c) => c.n), PMAX: mx((c) => c.P), RMAX: mx((c) => c.rows),
    MXMAX: mx((c) => c.Mx), MYMAX: mx((c) => c.My),
    PINMAX: mx((c) => c.nPins), NETMAX: mx((c) => c.nNets),
  };
  // cfgF (설정당 f32 블록)
  let o = 0;
  L.F_Z0 = o; o += L.RMAX;
  L.F_N = o; o += L.RMAX * L.PMAX;
  L.F_WH = o; o += L.NMAX * 2;
  L.F_SXY = o; o += L.NMAX * 2;
  L.F_PIN = o; o += L.PINMAX * 4;
  L.F_CX = o; o += L.MXMAX * L.MXMAX;
  L.F_CY = o; o += L.MYMAX * L.MYMAX;
  L.F_INV = o; o += L.MXMAX * L.MYMAX;
  L.F_GX = o; o += L.MXMAX;
  L.F_GY = o; o += L.MYMAX;
  L.F_SC = o; o += 16;                 // hx hy x0 y0 x1 y1 cell gamma lr ...
  L.CF = o;
  // cfgU (설정당 u32 블록)
  o = 0;
  L.U_SC = o; o += 8;                  // n P rows Mx My nPins nNets
  L.U_PIN = o; o += L.PINMAX * 2;      // inst, net
  L.CU = o;
  // state (시작점당 f32)
  o = 0;
  L.S_TH = o; o += L.PMAX;
  L.S_M = o; o += L.PMAX;
  L.S_V = o; o += L.PMAX;
  L.S_LM = o; o += 4;                  // lam0 mu0
  L.S_ST = o; o += 4;                  // W D B E
  L.S_GZ = o; o += L.RMAX;
  L.S_CXY = o; o += L.NMAX * 2;
  L.S_GW = o; o += L.NMAX * 2;
  L.S_GC = o; o += L.NMAX * 2;
  L.S_GP = o; o += L.PINMAX * 2;
  L.SS = o;
  // work (시작점당 f32)
  o = 0;
  L.W_UA = o; o += L.NMAX * L.MXMAX * 2;
  L.W_VB = o; o += L.NMAX * L.MYMAX * 2;
  L.W_S = o; o += L.MXMAX * L.MYMAX;
  L.SW = o;
  return L;
}

function packConfigs(cfgs, L) {
  const F = new Float32Array(cfgs.length * L.CF);
  const U = new Uint32Array(cfgs.length * L.CU);
  cfgs.forEach((c, ci) => {
    const f = ci * L.CF, u = ci * L.CU;
    F.set(c.z0, f + L.F_Z0);
    for (let r = 0; r < c.rows; r++)
      for (let k = 0; k < c.P; k++) F[f + L.F_N + r * L.PMAX + k] = c.N[r * c.P + k];
    for (let i = 0; i < c.n; i++) {
      F[f + L.F_WH + 2 * i] = c.w[i]; F[f + L.F_WH + 2 * i + 1] = c.h[i];
      F[f + L.F_SXY + 2 * i] = c.sx[i]; F[f + L.F_SXY + 2 * i + 1] = c.sy[i];
    }
    for (let p = 0; p < c.nPins; p++) {
      F[f + L.F_PIN + 4 * p] = c.pinOff[2 * p]; F[f + L.F_PIN + 4 * p + 1] = c.pinOff[2 * p + 1];
      F[f + L.F_PIN + 4 * p + 2] = c.pinEx[p]; F[f + L.F_PIN + 4 * p + 3] = c.pinEy[p];
      U[u + L.U_PIN + 2 * p] = c.pinInst[p]; U[u + L.U_PIN + 2 * p + 1] = c.pinNet[p];
    }
    for (let k = 0; k < c.Mx; k++)
      for (let m = 0; m < c.Mx; m++) F[f + L.F_CX + k * L.MXMAX + m] = c.Cx[k * c.Mx + m];
    for (let l = 0; l < c.My; l++)
      for (let m = 0; m < c.My; m++) F[f + L.F_CY + l * L.MYMAX + m] = c.Cy[l * c.My + m];
    for (let k = 0; k < c.Mx; k++)
      for (let l = 0; l < c.My; l++) F[f + L.F_INV + k * L.MYMAX + l] = c.invDen[k * c.My + l];
    F.set(c.gx, f + L.F_GX); F.set(c.gy, f + L.F_GY);
    const sc = [c.hx, c.hy, c.region[0], c.region[1], c.region[2], c.region[3], c.cell, c.gamma, c.lr];
    F.set(sc, f + L.F_SC);
    U.set([c.n, c.P, c.rows, c.Mx, c.My, c.nPins, c.nNets, 0], u + L.U_SC);
  });
  return { F, U };
}

function shaderSource(L) {
  return /* wgsl */ `
const WG: u32 = ${WG}u;
const NMAX: u32 = ${L.NMAX}u;  const PMAX: u32 = ${L.PMAX}u;  const RMAX: u32 = ${L.RMAX}u;
const MXMAX: u32 = ${L.MXMAX}u; const MYMAX: u32 = ${L.MYMAX}u; const PINMAX: u32 = ${L.PINMAX}u;
const CF: u32 = ${L.CF}u; const CU: u32 = ${L.CU}u; const SS: u32 = ${L.SS}u; const SW: u32 = ${L.SW}u;
const F_Z0: u32 = ${L.F_Z0}u; const F_N: u32 = ${L.F_N}u; const F_WH: u32 = ${L.F_WH}u; const F_SXY: u32 = ${L.F_SXY}u;
const F_PIN: u32 = ${L.F_PIN}u; const F_CX: u32 = ${L.F_CX}u; const F_CY: u32 = ${L.F_CY}u; const F_INV: u32 = ${L.F_INV}u;
const F_GX: u32 = ${L.F_GX}u; const F_GY: u32 = ${L.F_GY}u; const F_SC: u32 = ${L.F_SC}u;
const U_SC: u32 = ${L.U_SC}u; const U_PIN: u32 = ${L.U_PIN}u;
const S_TH: u32 = ${L.S_TH}u; const S_M: u32 = ${L.S_M}u; const S_V: u32 = ${L.S_V}u; const S_LM: u32 = ${L.S_LM}u;
const S_ST: u32 = ${L.S_ST}u; const S_GZ: u32 = ${L.S_GZ}u; const S_CXY: u32 = ${L.S_CXY}u; const S_GW: u32 = ${L.S_GW}u;
const S_GC: u32 = ${L.S_GC}u; const S_GP: u32 = ${L.S_GP}u;
const W_UA: u32 = ${L.W_UA}u; const W_VB: u32 = ${L.W_VB}u; const W_S: u32 = ${L.W_S}u;

struct Step { t: u32, mode: u32, p0: u32, p1: u32 }
struct Params { lamGrow: f32, muGrow: f32, lamRatio: f32, muRatio: f32, lr: f32, b1: f32, b2: f32, eps: f32 }

@group(0) @binding(0) var<storage, read> cfgF: array<f32>;
@group(0) @binding(1) var<storage, read> cfgU: array<u32>;
@group(0) @binding(2) var<storage, read> startCfg: array<u32>;
@group(0) @binding(3) var<storage, read_write> state: array<f32>;
@group(0) @binding(4) var<storage, read_write> work: array<f32>;
@group(0) @binding(5) var<uniform> step: Step;
@group(0) @binding(6) var<uniform> prm: Params;

var<workgroup> red: array<f32, WG>;
var<workgroup> red2: array<f32, WG>;
var<workgroup> red3: array<f32, WG>;
var<workgroup> tmpA: array<f32, ${L.NMAX * L.MXMAX}>;
var<workgroup> tmpB: array<f32, ${L.NMAX * L.MYMAX}>;

fn wgsum(lid: u32, v: f32) -> f32 {
  red[lid] = v;
  workgroupBarrier();
  var s: f32 = 0.0;
  for (var i: u32 = 0u; i < WG; i++) { s += red[i]; }
  workgroupBarrier();
  return s;
}

// ---------------------------------------------------------------- 1. centers
@compute @workgroup_size(WG)
fn centers(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let b = wid.x; let c = startCfg[b];
  let cf = c * CF; let cu = c * CU; let ss = b * SS;
  let n = cfgU[cu + U_SC]; let P = cfgU[cu + U_SC + 1u]; let rows = cfgU[cu + U_SC + 2u];
  for (var r: u32 = lid; r < rows; r += WG) {
    var s: f32 = cfgF[cf + F_Z0 + r];
    for (var k: u32 = 0u; k < P; k++) { s += cfgF[cf + F_N + r * PMAX + k] * state[ss + S_TH + k]; }
    if (r < 2u * n) { state[ss + S_CXY + r] = s; }
  }
}

// ---------------------------------------------------------------- 2. wire
@compute @workgroup_size(WG)
fn wire(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let b = wid.x; let c = startCfg[b];
  let cf = c * CF; let cu = c * CU; let ss = b * SS;
  let n = cfgU[cu + U_SC]; let nPins = cfgU[cu + U_SC + 5u]; let nNets = cfgU[cu + U_SC + 6u];
  let gamma = cfgF[cf + F_SC + 7u];
  var Wacc: f32 = 0.0;
  for (var e: u32 = lid; e < nNets; e += WG) {
    for (var ax: u32 = 0u; ax < 2u; ax++) {
      // 핀 위치 (x 또는 y) 와 반폭
      var hi: f32 = -1e30; var lo: f32 = 1e30;
      for (var p: u32 = 0u; p < nPins; p++) {
        if (cfgU[cu + U_PIN + 2u * p + 1u] != e) { continue; }
        let i = cfgU[cu + U_PIN + 2u * p];
        let pos = state[ss + S_CXY + 2u * i + ax] + cfgF[cf + F_SXY + 2u * i + ax] * cfgF[cf + F_PIN + 4u * p + ax];
        let d = cfgF[cf + F_PIN + 4u * p + 2u + ax];
        hi = max(hi, pos + d); lo = min(lo, pos - d);
      }
      var Su: f32 = 0.0; var Sv: f32 = 0.0; var Tu: f32 = 0.0; var Tv: f32 = 0.0;
      for (var p: u32 = 0u; p < nPins; p++) {
        if (cfgU[cu + U_PIN + 2u * p + 1u] != e) { continue; }
        let i = cfgU[cu + U_PIN + 2u * p];
        let pos = state[ss + S_CXY + 2u * i + ax] + cfgF[cf + F_SXY + 2u * i + ax] * cfgF[cf + F_PIN + 4u * p + ax];
        let d = cfgF[cf + F_PIN + 4u * p + 2u + ax];
        let up = exp((pos + d - hi) / gamma); let vp = exp((lo - (pos - d)) / gamma);
        Su += up; Sv += vp; Tu += (pos + d) * up; Tv += (pos - d) * vp;
        state[ss + S_GP + 2u * p + ax] = up;          // 잠시 u 를 보관
        work[b * SW + W_S + p] = vp;                  // 잠시 v 를 보관 (S 는 뒤에서 덮어쓴다)
      }
      let A = Tu / Su; let B = Tv / Sv;
      Wacc += A - B;
      for (var p: u32 = 0u; p < nPins; p++) {
        if (cfgU[cu + U_PIN + 2u * p + 1u] != e) { continue; }
        let i = cfgU[cu + U_PIN + 2u * p];
        let pos = state[ss + S_CXY + 2u * i + ax] + cfgF[cf + F_SXY + 2u * i + ax] * cfgF[cf + F_PIN + 4u * p + ax];
        let d = cfgF[cf + F_PIN + 4u * p + 2u + ax];
        let up = state[ss + S_GP + 2u * p + ax]; let vp = work[b * SW + W_S + p];
        let dA = (up / Su) * (1.0 + (pos + d - A) / gamma);
        let dB = (vp / Sv) * (1.0 - (pos - d - B) / gamma);
        state[ss + S_GP + 2u * p + ax] = dA - dB;
      }
    }
  }
  let Wtot = wgsum(lid, Wacc);
  if (lid == 0u) { state[ss + S_ST] = Wtot; }
  storageBarrier();
  // 핀 기울기를 블록으로 모은다 (핀은 정확히 한 블록에 속한다)
  for (var i: u32 = lid; i < n; i += WG) {
    var gx: f32 = 0.0; var gy: f32 = 0.0;
    for (var p: u32 = 0u; p < nPins; p++) {
      if (cfgU[cu + U_PIN + 2u * p] != i) { continue; }
      gx += state[ss + S_GP + 2u * p]; gy += state[ss + S_GP + 2u * p + 1u];
    }
    state[ss + S_GW + 2u * i] = gx; state[ss + S_GW + 2u * i + 1u] = gy;
  }
}

// ---------------------------------------------------------------- 3. overlap  (u, a, v, b)
@compute @workgroup_size(WG)
fn overlap(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let b = wid.x; let c = startCfg[b];
  let cf = c * CF; let cu = c * CU; let ss = b * SS; let sw = b * SW;
  let n = cfgU[cu + U_SC]; let Mx = cfgU[cu + U_SC + 3u]; let My = cfgU[cu + U_SC + 4u];
  let hx2 = cfgF[cf + F_SC] * 0.5; let hy2 = cfgF[cf + F_SC + 1u] * 0.5;
  let total = n * (Mx + My);
  for (var idx: u32 = lid; idx < total; idx += WG) {
    if (idx < n * Mx) {
      let i = idx / Mx; let k = idx % Mx;
      let half = cfgF[cf + F_WH + 2u * i] * 0.5;
      let ctr = state[ss + S_CXY + 2u * i];
      let blo = ctr - half; let bhi = ctr + half;
      var s: f32 = 0.0; var t: f32 = 0.0;
      for (var m: u32 = 0u; m < Mx; m++) {
        let g = cfgF[cf + F_GX + m];
        let glo = g - hx2; let ghi = g + hx2;
        let o = min(bhi, ghi) - max(blo, glo);
        if (o > 0.0) {
          let ck = cfgF[cf + F_CX + k * MXMAX + m];
          s += ck * o;
          t += ck * (select(0.0, 1.0, bhi < ghi) - select(0.0, 1.0, blo > glo));
        }
      }
      work[sw + W_UA + (i * MXMAX + k) * 2u] = s; work[sw + W_UA + (i * MXMAX + k) * 2u + 1u] = t;
    } else {
      let j = idx - n * Mx; let i = j / My; let l = j % My;
      let half = cfgF[cf + F_WH + 2u * i + 1u] * 0.5;
      let ctr = state[ss + S_CXY + 2u * i + 1u];
      let blo = ctr - half; let bhi = ctr + half;
      var s: f32 = 0.0; var t: f32 = 0.0;
      for (var m: u32 = 0u; m < My; m++) {
        let g = cfgF[cf + F_GY + m];
        let glo = g - hy2; let ghi = g + hy2;
        let o = min(bhi, ghi) - max(blo, glo);
        if (o > 0.0) {
          let cl = cfgF[cf + F_CY + l * MYMAX + m];
          s += cl * o;
          t += cl * (select(0.0, 1.0, bhi < ghi) - select(0.0, 1.0, blo > glo));
        }
      }
      work[sw + W_VB + (i * MYMAX + l) * 2u] = s; work[sw + W_VB + (i * MYMAX + l) * 2u + 1u] = t;
    }
  }
}

// ---------------------------------------------------------------- 4. spectrum  (S, D)
@compute @workgroup_size(WG)
fn spectrum(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let b = wid.x; let c = startCfg[b];
  let cf = c * CF; let cu = c * CU; let ss = b * SS; let sw = b * SW;
  let n = cfgU[cu + U_SC]; let Mx = cfgU[cu + U_SC + 3u]; let My = cfgU[cu + U_SC + 4u];
  let cell = cfgF[cf + F_SC + 6u];
  var acc: f32 = 0.0;
  for (var idx: u32 = lid; idx < Mx * My; idx += WG) {
    let k = idx / My; let l = idx % My;
    var r: f32 = 0.0;
    for (var i: u32 = 0u; i < n; i++) {
      r += work[sw + W_UA + (i * MXMAX + k) * 2u] * work[sw + W_VB + (i * MYMAX + l) * 2u];
    }
    r = r / cell;
    let s = cfgF[cf + F_INV + k * MYMAX + l] * r;
    work[sw + W_S + k * MYMAX + l] = s;
    acc += r * s;
  }
  let D = wgsum(lid, acc) * 0.5 * cell;
  if (lid == 0u) { state[ss + S_ST + 1u] = D; }
}

// ---------------------------------------------------------------- 5. grad  (밀도 기울기, 경계, gz)
@compute @workgroup_size(WG)
fn grad(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let b = wid.x; let c = startCfg[b];
  let cf = c * CF; let cu = c * CU; let ss = b * SS; let sw = b * SW;
  let n = cfgU[cu + U_SC]; let rows = cfgU[cu + U_SC + 2u];
  let Mx = cfgU[cu + U_SC + 3u]; let My = cfgU[cu + U_SC + 4u];
  // 1) tmpA[i,k] = a_ik * sum_l S_kl v_il ;  tmpB[i,l] = b_il * sum_k S_kl u_ik
  for (var idx: u32 = lid; idx < n * Mx; idx += WG) {
    let i = idx / Mx; let k = idx % Mx;
    var t: f32 = 0.0;
    for (var l: u32 = 0u; l < My; l++) { t += work[sw + W_S + k * MYMAX + l] * work[sw + W_VB + (i * MYMAX + l) * 2u]; }
    tmpA[i * MXMAX + k] = work[sw + W_UA + (i * MXMAX + k) * 2u + 1u] * t;
  }
  for (var idx: u32 = lid; idx < n * My; idx += WG) {
    let i = idx / My; let l = idx % My;
    var t: f32 = 0.0;
    for (var k: u32 = 0u; k < Mx; k++) { t += work[sw + W_S + k * MYMAX + l] * work[sw + W_UA + (i * MXMAX + k) * 2u]; }
    tmpB[i * MYMAX + l] = work[sw + W_VB + (i * MYMAX + l) * 2u + 1u] * t;
  }
  workgroupBarrier();
  // 2) 블록별 밀도 기울기, 경계 벌점, 그리고 gz
  let x0 = cfgF[cf + F_SC + 2u]; let y0 = cfgF[cf + F_SC + 3u];
  let x1 = cfgF[cf + F_SC + 4u]; let y1 = cfgF[cf + F_SC + 5u];
  let calib = step.mode == 1u;
  let ngrow = f32((step.t - 1u) / 50u);
  let lam = state[ss + S_LM] * pow(prm.lamGrow, ngrow);
  let mu = state[ss + S_LM + 1u] * pow(prm.muGrow, ngrow);
  var Bacc: f32 = 0.0; var nw: f32 = 0.0; var nd: f32 = 0.0; var nb: f32 = 0.0;
  for (var i: u32 = lid; i < n; i += WG) {
    var gcx: f32 = 0.0; var gcy: f32 = 0.0;
    for (var k: u32 = 0u; k < Mx; k++) { gcx += tmpA[i * MXMAX + k]; }
    for (var l: u32 = 0u; l < My; l++) { gcy += tmpB[i * MYMAX + l]; }
    let w2 = cfgF[cf + F_WH + 2u * i] * 0.5; let h2 = cfgF[cf + F_WH + 2u * i + 1u] * 0.5;
    let cx = state[ss + S_CXY + 2u * i]; let cy = state[ss + S_CXY + 2u * i + 1u];
    let exl = max(x0 - (cx - w2), 0.0); let exh = max(cx + w2 - x1, 0.0);
    let eyl = max(y0 - (cy - h2), 0.0); let eyh = max(cy + h2 - y1, 0.0);
    Bacc += exl * exl + exh * exh + eyl * eyl + eyh * eyh;
    let bx = 2.0 * (exh - exl); let by = 2.0 * (eyh - eyl);
    let gwx = state[ss + S_GW + 2u * i]; let gwy = state[ss + S_GW + 2u * i + 1u];
    if (calib) {
      nw += abs(gwx) + abs(gwy); nd += abs(gcx) + abs(gcy); nb += abs(bx) + abs(by);
    } else {
      state[ss + S_GZ + 2u * i] = gwx + lam * gcx + mu * bx;
      state[ss + S_GZ + 2u * i + 1u] = gwy + lam * gcy + mu * by;
    }
    state[ss + S_GC + 2u * i] = gcx; state[ss + S_GC + 2u * i + 1u] = gcy;
  }
  for (var r: u32 = 2u * n + lid; r < rows; r += WG) { state[ss + S_GZ + r] = 0.0; }
  let Btot = wgsum(lid, Bacc);
  if (calib) {
    red2[lid] = nw; red3[lid] = nd; red[lid] = nb;
    workgroupBarrier();
    if (lid == 0u) {
      var sw_: f32 = 0.0; var sd: f32 = 0.0; var sb: f32 = 0.0;
      for (var i: u32 = 0u; i < WG; i++) { sw_ += red2[i]; sd += red3[i]; sb += red[i]; }
      state[ss + S_LM] = prm.lamRatio * sw_ / max(sd, 1e-30);
      state[ss + S_LM + 1u] = select(1.0, prm.muRatio * sw_ / max(sb, 1e-30), sb > 0.0);
    }
  }
  if (lid == 0u) {
    state[ss + S_ST + 2u] = Btot;
    state[ss + S_ST + 3u] = state[ss + S_ST] + lam * state[ss + S_ST + 1u] + mu * Btot;
  }
}

// ---------------------------------------------------------------- 6. adam
@compute @workgroup_size(WG)
fn adam(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) lid: u32) {
  let b = wid.x; let c = startCfg[b];
  let cf = c * CF; let cu = c * CU; let ss = b * SS;
  let P = cfgU[cu + U_SC + 1u]; let rows = cfgU[cu + U_SC + 2u];
  let t = f32(step.t);
  let c1 = 1.0 - pow(prm.b1, t); let c2 = 1.0 - pow(prm.b2, t);
  for (var k: u32 = lid; k < P; k += WG) {
    var g: f32 = 0.0;
    for (var r: u32 = 0u; r < rows; r++) { g += cfgF[cf + F_N + r * PMAX + k] * state[ss + S_GZ + r]; }
    let m = prm.b1 * state[ss + S_M + k] + (1.0 - prm.b1) * g;
    let v = prm.b2 * state[ss + S_V + k] + (1.0 - prm.b2) * g * g;
    state[ss + S_M + k] = m; state[ss + S_V + k] = v;
    state[ss + S_TH + k] -= (prm.lr * (m / c1)) / (sqrt(v / c2) + prm.eps);
  }
}
`;
}

/** WebGPU 장치를 얻는다. gpu 는 navigator.gpu 또는 dawn 의 create() 결과. 없으면 null. */
export async function requestGpuDevice(gpu) {
  if (!gpu) return null;
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return null;
    const device = await adapter.requestDevice();
    return { adapter, device };
  } catch {
    return null;
  }
}

export async function createGpuRunner(gpu, { maxStarts = 2048 } = {}) {
  const got = await requestGpuDevice(gpu);
  if (!got) return null;
  return new GpuRunner(got.device, { maxStarts });
}

export class GpuRunner {
  constructor(device, { maxStarts = 2048 } = {}) {
    this.device = device;
    this.maxStarts = maxStarts;
    this.kind = "gpu";
    this.pipelines = new Map();       // 셰이더는 표 크기(L)마다 하나
  }

  _pipelines(L) {
    const key = JSON.stringify([L.NMAX, L.PMAX, L.RMAX, L.MXMAX, L.MYMAX, L.PINMAX]);
    if (this.pipelines.has(key)) return this.pipelines.get(key);
    const dev = this.device;
    const module = dev.createShaderModule({ code: shaderSource(L) });
    const bgl = dev.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", hasDynamicOffset: true } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
    ] });
    const layout = dev.createPipelineLayout({ bindGroupLayouts: [bgl] });
    const mk = (entryPoint) => dev.createComputePipeline({ layout, compute: { module, entryPoint } });
    const out = { bgl, passes: ["centers", "wire", "overlap", "spectrum", "grad"].map(mk), adam: mk("adam") };
    this.pipelines.set(key, out);
    return out;
  }

  /** prep[i] = {obj, z0, N}, jobs[j] = {p, theta0}. 반환 out[j] = {theta, W, D, B, E}. */
  async runMany(prep, jobs, { iters = 600, lamGrow = 1.3, muGrow = 1.25, lamRatio = 1.0, muRatio = 4.0,
                              chunk = 100, onChunk = null } = {}) {
    const cfgs = prep.map(normalizeConfig);
    const L = layoutOf(cfgs);
    const { F, U } = packConfigs(cfgs, L);
    const pipes = this._pipelines(L);
    const dev = this.device;
    const out = new Array(jobs.length);
    for (let s0 = 0; s0 < jobs.length; s0 += this.maxStarts) {
      const slab = jobs.slice(s0, s0 + this.maxStarts);
      const res = await this._runSlab(cfgs, L, F, U, pipes, slab,
                                      { iters, lamGrow, muGrow, lamRatio, muRatio, chunk, onChunk });
      res.forEach((r, j) => { out[s0 + j] = r; });
    }
    return out;
  }

  async _runSlab(cfgs, L, F, U, pipes, jobs, opt) {
    const dev = this.device;
    const B = jobs.length;
    const mkBuf = (bytes, usage) => dev.createBuffer({ size: Math.max(16, Math.ceil(bytes / 16) * 16), usage });
    const ST = GPUBufferUsage.STORAGE, CD = GPUBufferUsage.COPY_DST, CS = GPUBufferUsage.COPY_SRC;

    const bufF = mkBuf(F.byteLength, ST | CD); dev.queue.writeBuffer(bufF, 0, F);
    const bufU = mkBuf(U.byteLength, ST | CD); dev.queue.writeBuffer(bufU, 0, U);
    const sc = new Uint32Array(B);
    jobs.forEach((j, b) => { sc[b] = j.p; });
    const bufSC = mkBuf(sc.byteLength, ST | CD); dev.queue.writeBuffer(bufSC, 0, sc);

    const state = new Float32Array(B * L.SS);
    jobs.forEach((j, b) => {
      const c = cfgs[j.p];
      for (let k = 0; k < c.P; k++) state[b * L.SS + L.S_TH + k] = j.theta0[k] / c.span;
      state[b * L.SS + L.S_LM] = 1; state[b * L.SS + L.S_LM + 1] = 1;
    });
    const bufState = mkBuf(state.byteLength, ST | CD | CS); dev.queue.writeBuffer(bufState, 0, state);
    const bufWork = mkBuf(B * L.SW * 4, ST);

    // 스텝 유니폼: 슬롯마다 256 바이트, 동적 오프셋으로 고른다. 슬롯 0 은 calibrate.
    const STRIDE = 256;
    const nSlots = opt.iters + 1;
    const stepArr = new Uint32Array((nSlots * STRIDE) / 4);
    stepArr.set([1, 1, 0, 0], 0);                                   // t=1, mode=calib
    for (let t = 1; t <= opt.iters; t++) stepArr.set([t, 0, 0, 0], (t * STRIDE) / 4);
    const bufStep = mkBuf(stepArr.byteLength, GPUBufferUsage.UNIFORM | CD);
    dev.queue.writeBuffer(bufStep, 0, stepArr);
    const prm = new Float32Array([opt.lamGrow, opt.muGrow, opt.lamRatio, opt.muRatio, cfgs[0].lr, 0.9, 0.999, 1e-8]);
    const bufPrm = mkBuf(prm.byteLength, GPUBufferUsage.UNIFORM | CD);
    dev.queue.writeBuffer(bufPrm, 0, prm);

    const bg = dev.createBindGroup({ layout: pipes.bgl, entries: [
      { binding: 0, resource: { buffer: bufF } },
      { binding: 1, resource: { buffer: bufU } },
      { binding: 2, resource: { buffer: bufSC } },
      { binding: 3, resource: { buffer: bufState } },
      { binding: 4, resource: { buffer: bufWork } },
      { binding: 5, resource: { buffer: bufStep, size: STRIDE } },
      { binding: 6, resource: { buffer: bufPrm } },
    ] });

    const encodeStep = (pass, slot, withAdam) => {
      for (const p of pipes.passes) {
        pass.setPipeline(p);
        pass.setBindGroup(0, bg, [slot * STRIDE]);
        pass.dispatchWorkgroups(B);
      }
      if (withAdam) {
        pass.setPipeline(pipes.adam);
        pass.setBindGroup(0, bg, [slot * STRIDE]);
        pass.dispatchWorkgroups(B);
      }
    };

    // calibrate: 다섯 패스를 mode=1 로 한 번
    {
      const enc = dev.createCommandEncoder();
      const pass = enc.beginComputePass();
      encodeStep(pass, 0, false);
      pass.end();
      dev.queue.submit([enc.finish()]);
    }
    for (let t0 = 1; t0 <= opt.iters; t0 += opt.chunk) {
      const enc = dev.createCommandEncoder();
      const pass = enc.beginComputePass();
      for (let t = t0; t < Math.min(t0 + opt.chunk, opt.iters + 1); t++) encodeStep(pass, t, true);
      pass.end();
      dev.queue.submit([enc.finish()]);
      if (opt.onChunk) { await dev.queue.onSubmittedWorkDone(); opt.onChunk(Math.min(t0 + opt.chunk - 1, opt.iters), opt.iters); }
    }

    // 읽어온다
    const stag = mkBuf(state.byteLength, GPUBufferUsage.MAP_READ | CD);
    {
      const enc = dev.createCommandEncoder();
      enc.copyBufferToBuffer(bufState, 0, stag, 0, stag.size);
      dev.queue.submit([enc.finish()]);
    }
    await stag.mapAsync(GPUMapMode.READ);
    const got = new Float32Array(stag.getMappedRange().slice(0));
    stag.unmap();
    for (const b of [bufF, bufU, bufSC, bufState, bufWork, bufStep, bufPrm, stag]) b.destroy();

    return jobs.map((j, b) => {
      const c = cfgs[j.p];
      const theta = new Float64Array(c.P);
      for (let k = 0; k < c.P; k++) theta[k] = got[b * L.SS + L.S_TH + k] * c.span;
      const st = b * L.SS + L.S_ST;
      return { theta, W: got[st] * c.span, D: got[st + 1], B: got[st + 2], E: got[st + 3],
               lam0: got[b * L.SS + L.S_LM], mu0: got[b * L.SS + L.S_LM + 1] };
    });
  }
}

/** CPU runner — GPU 와 같은 모양의 인터페이스. solver.mjs 의 adam 을 그대로 돈다. */
export function cpuRunner({ adam }) {
  return {
    kind: "cpu",
    async runMany(prep, jobs, { iters = 600, lamGrow = 1.3, muGrow = 1.25, lamRatio = 1.0, muRatio = 4.0 } = {}) {
      return jobs.map((j) => {
        const p = prep[j.p];
        const { obj } = p;
        obj.lam = 1.0; obj.mu = 1.0;
        const theta = Float64Array.from(j.theta0);
        const [x0, y0, x1, y1] = obj.region;
        const lr = Math.max(x1 - x0, y1 - y0) / 400;
        const r = adam(obj, theta, { iters, lr, lamGrow, muGrow, lamRatio, muRatio });
        return { theta, W: r.last.W, D: r.last.D, B: r.last.B, E: r.last.E };
      });
    },
  };
}
