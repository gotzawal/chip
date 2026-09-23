/** 회로도 자동 배열 — 회로(circuit.mjs)를 기호와 선으로.
 *
 *  좌표는 픽셀이고 y 는 위로 큰다 (view.mjs 의 mapper 가 그렇게 뒤집는다). 한 단(ROW)이 소자 하나의
 *  높이, 한 열(COL)이 소자 하나의 너비다.
 *
 *  세로 — 넷의 높이를 스프링으로 푼다. 전원은 위, 접지는 0 에 두고, 트랜지스터마다 위쪽 단자(NMOS 는
 *  드레인, PMOS 는 소스)가 아래쪽보다 한 단 위에 오게 하는 스프링을 건다. 게이트 넷은 약한 스프링으로
 *  소자 높이에 붙인다. 최소제곱을 두어 번 다시 풀어(눌린 스프링에 무게를 더 준다) 겹치지 않게 한다.
 *
 *  가로 — 직렬로 이어진 소자(채널 핀이 둘뿐인 넷으로 이어진 것)는 한 열에 세운다. 열끼리 넷을
 *  나눠 쓰는 정도로 친화도를 매기고(같은 묶음이면 더), 라플라시안의 피들러 벡터로 줄을 세운다 —
 *  1 차원 이차 배치다. 제약에 거울 쌍(SymmetricBlocks)이 있으면 쌍을 축의 양쪽에 거울로 놓고,
 *  양쪽에 채널로 닿는 열(꼬리 전류원)은 축 위에, 나머지(바이어스)는 친화도가 큰 쪽 바깥에 둔다.
 *
 *  선 — 넷마다 가로 줄기(trunk) 하나를 넷 높이에 두고 핀마다 세로로 떨어뜨린다. 줄기가 기호나
 *  다른 줄기를 지나면 비켜 놓는다. 전원·접지는 전체 폭의 레일이다.
 */

export const ROW = 84;
export const COL = 104;
const HW = 26, HH = 24, LEAD = 22;       // MOS 기호의 반폭·반높이, 단자까지의 거리
const MARGIN = 26;                       // 열 안 좌우 여백 (기호 밖)
const isMos = (d) => d.kind === "nmos" || d.kind === "pmos";
const pin = (d, name) => d.pins.find((p) => p.name === name)?.net ?? null;

// ---------------------------------------------------------------- 세로: 스프링
function mosEnds(d) {
  const D = pin(d, "D"), G = pin(d, "G"), S = pin(d, "S");
  if (D !== S) return d.kind === "nmos" ? [D, S] : [S, D];
  return d.kind === "nmos" ? [G, S] : [S, G];
}

/** 정규방정식을 세워 푼다. rows: [ [[var, coef]...], rhs, w ]. */
function lsq(rows, n) {
  const M = new Float64Array(n * n), b = new Float64Array(n);
  for (const [terms, rhs, w] of rows) {
    for (const [i, ci] of terms) {
      b[i] += w * ci * rhs;
      for (const [j, cj] of terms) M[i * n + j] += w * ci * cj;
    }
  }
  // 가우스 소거 (부분 피벗)
  const x = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let p = k, best = Math.abs(M[k * n + k]);
    for (let i = k + 1; i < n; i++) { const v = Math.abs(M[i * n + k]); if (v > best) { best = v; p = i; } }
    if (best < 1e-12) continue;
    if (p !== k) {
      for (let j = 0; j < n; j++) { const t = M[k * n + j]; M[k * n + j] = M[p * n + j]; M[p * n + j] = t; }
      const t = b[k]; b[k] = b[p]; b[p] = t;
    }
    for (let i = k + 1; i < n; i++) {
      const f = M[i * n + k] / M[k * n + k];
      if (!f) continue;
      for (let j = k; j < n; j++) M[i * n + j] -= f * M[k * n + j];
      b[i] -= f * b[k];
    }
  }
  for (let k = n - 1; k >= 0; k--) {
    let s = b[k];
    for (let j = k + 1; j < n; j++) s -= M[k * n + j] * x[j];
    x[k] = Math.abs(M[k * n + k]) < 1e-12 ? 0 : s / M[k * n + k];
  }
  return x;
}

/** 넷 -> 높이(단). 상자 소자는 자기 변수를 갖는다 (boxY). */
function solveY(c) {
  const keys = [...c.nets.keys()];
  const idx = new Map(keys.map((k, i) => [k, i]));
  let n = keys.length;
  const boxVar = new Map();
  for (const d of c.devices) if (d.kind === "box") boxVar.set(d.id, n++);
  const V = (name) => idx.get(name);
  const role = (name) => c.nets.get(name)?.role ?? null;
  const springs = [];          // 눌리면 무게를 올릴 것
  const rows = [];
  for (const d of c.devices) {
    if (isMos(d)) {
      const [top, bot] = mosEnds(d);
      const G = pin(d, "G");
      if (top !== bot) springs.push([[[V(top), 1], [V(bot), -1]], 1, 1]);
      if (G !== top && G !== bot && !role(G))
        rows.push([[[V(G), 1], [V(top), -0.5], [V(bot), -0.5]], 0, 0.05]);
    } else if (d.kind === "box") {
      const b = boxVar.get(d.id);
      for (const p of d.pins) {
        if (p.net == null) continue;
        const r = role(p.net);
        if (r === "vdd") rows.push([[[V(p.net), 1], [b, -1]], 1.5, 0.2]);
        else if (r === "gnd") rows.push([[[b, 1], [V(p.net), -1]], 1.5, 0.2]);
        else rows.push([[[V(p.net), 1], [b, -1]], 0, 0.2]);
      }
    } else {
      const P = pin(d, "P"), N = pin(d, "N");
      if (P !== N) springs.push([[[V(P), 1], [V(N), -1]], 1, d.kind === "cap" ? 0.15 : d.kind === "res" ? 0.3 : 0.5]);
    }
  }
  const gnd = keys.filter((k) => role(k) === "gnd"), vdd = keys.filter((k) => role(k) === "vdd");
  for (const k of gnd) rows.push([[[V(k), 1]], 0, 100]);
  for (let i = 1; i < vdd.length; i++) rows.push([[[V(vdd[i]), 1], [V(vdd[0]), -1]], 0, 100]);
  if (!gnd.length && vdd.length) rows.push([[[V(vdd[0]), 1]], 3, 100]);
  for (let i = 0; i < n; i++) rows.push([[[i, 1]], 1, 1e-3]);
  // 거울 쌍은 같은 높이에 — 양쪽 넷을 묶는다. 처음엔 느슨하게 풀어 보고, 구조가 달라 안 맞는
  // 쌍(높이 차가 크게 남는 것)은 놓아 주고 나머지는 꽉 묶는다
  let ties = [];
  for (const [a, b] of c.mirrors) {
    const A = c.devices[a], B = c.devices[b];
    if (A.kind !== B.kind) continue;
    if (isMos(A)) {
      const [ta, ba] = mosEnds(A), [tb, bb] = mosEnds(B);
      if (ta !== tb) ties.push([[[V(ta), 1], [V(tb), -1]], 0, 2]);
      if (ba !== bb) ties.push([[[V(ba), 1], [V(bb), -1]], 0, 2]);
    } else if (A.kind === "box") {
      ties.push([[[boxVar.get(a), 1], [boxVar.get(b), -1]], 0, 2]);
    } else {
      for (const p of ["P", "N"]) {
        const na = pin(A, p), nb = pin(B, p);
        if (na !== nb) ties.push([[[V(na), 1], [V(nb), -1]], 0, 2]);
      }
    }
  }

  let y = null;
  for (let pass = 0; pass < 5; pass++) {
    y = lsq([...rows, ...springs, ...ties], n);
    let changed = 0;
    if (pass === 0 && ties.length) {
      const keep = [];
      for (const t of ties) {
        const [[i], [j]] = t[0];
        if (Math.abs(y[i] - y[j]) < 0.3) { t[2] = 100; keep.push(t); }
      }
      changed += ties.length !== keep.length || keep.length;
      ties = keep;
    }
    for (const s of springs) {
      const [[i], [j]] = s[0];
      const len = y[i] - y[j];
      if (len < 0.85 * s[1] && s[2] < 40) { s[2] *= 4; changed++; }
    }
    if (!changed) break;
  }
  // 접지 아래로 내려간 넷은 없다 — 양끝이 다 접지에 닿는 더미 사슬이 그렇게 풀린다
  const floor = gnd.length ? 0.25 : -Infinity;
  const snap = (v, k) => (role(k) === "gnd" ? 0 : Math.max(floor, Math.round(v * 4) / 4));
  const netY = new Map(keys.map((k, i) => [k, snap(y[i], k)]));
  const boxY = new Map([...boxVar].map(([id, i]) => [id, Math.max(floor, Math.round(y[i] * 4) / 4)]));
  return { netY, boxY };
}

// ---------------------------------------------------------------- 기호의 크기와 자리
function geometry(c, netY, boxY) {
  const floor = [...c.nets.values()].some((n) => n.role === "gnd") ? 0.5 : -Infinity;
  return c.devices.map((d) => {
    if (isMos(d)) {
      const [top, bot] = mosEnds(d);
      let y = (netY.get(top) + netY.get(bot)) / 2;
      if (top === bot) y = netY.get(top) + (d.kind === "nmos" ? 0.5 : -0.5);
      return { hw: HW, hh: HH, y: Math.max(floor, y), horiz: false, top, bot };
    }
    if (d.kind === "box") {
      const n = d.pins.length;
      const longest = Math.max(1, ...d.pins.map((p) => p.name.length));
      const side = Math.ceil(Math.max(0, n - d.pins.filter((p) => c.nets.get(p.net)?.role).length) / 2);
      return { hw: Math.max(34, 12 + 4 * longest), hh: Math.max(20, 9 * side + 8), y: boxY.get(d.id) ?? 1,
               horiz: false, top: null, bot: null };
    }
    const P = pin(d, "P"), N = pin(d, "N");
    const yp = netY.get(P), yn = netY.get(N);
    if (Math.abs(yp - yn) < 0.3) return { hw: 24, hh: 14, y: (yp + yn) / 2, horiz: true, top: P, bot: N };
    return { hw: 14, hh: HH, y: (yp + yn) / 2, horiz: false, top: yp > yn ? P : N, bot: yp > yn ? N : P };
  });
}

// ---------------------------------------------------------------- 가로: 열
function columns(c, geo) {
  const N = c.devices.length;
  const parent = Array.from({ length: N }, (_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const net of c.nets.values()) {
    if (net.role) continue;
    const ch = net.pins.filter((p) => {
      const d = c.devices[p.dev];
      return d.kind !== "box" && p.pin !== "G" && p.pin !== "B";
    });
    if (ch.length !== 2 || ch[0].dev === ch[1].dev) continue;
    const a = ch[0].dev, b = ch[1].dev;
    if (Math.abs(geo[a].y - geo[b].y) < 0.6) continue;
    if (find(a) !== find(b)) parent[find(a)] = find(b);
  }
  const byRoot = new Map();
  for (let i = 0; i < N; i++) (byRoot.get(find(i)) ?? byRoot.set(find(i), []).get(find(i))).push(i);
  const cols = [];
  const colOf = new Int32Array(N);
  for (const devs of byRoot.values()) {
    devs.sort((a, b) => geo[b].y - geo[a].y || a - b);
    const id = cols.length;
    for (const d of devs) colOf[d] = id;
    cols.push({ id, devs,
                ymin: Math.min(...devs.map((d) => geo[d].y - geo[d].hh / ROW)),
                ymax: Math.max(...devs.map((d) => geo[d].y + geo[d].hh / ROW)),
                width: Math.max(...devs.map((d) => 2 * geo[d].hw + 2 * MARGIN)) });
  }
  cols.sort((a, b) => a.devs[0] - b.devs[0]);
  cols.forEach((col, k) => { col.id = k; for (const d of col.devs) colOf[d] = k; });
  return { cols, colOf };
}

/** 열 사이 친화도. A 는 모든 핀으로, chan 은 채널 핀(D/S, P/N)끼리만. */
function affinity(c, cols, colOf) {
  const n = cols.length;
  const A = new Float64Array(n * n), chan = new Float64Array(n * n);
  const bump = (M, cs, w) => {
    for (let i = 0; i < cs.length; i++)
      for (let j = i + 1; j < cs.length; j++) { M[cs[i] * n + cs[j]] += w; M[cs[j] * n + cs[i]] += w; }
  };
  for (const net of c.nets.values()) {
    if (net.role) continue;
    const all = [...new Set(net.pins.filter((p) => p.pin !== "B").map((p) => colOf[p.dev]))];
    if (all.length < 2) continue;
    bump(A, all, 2 / all.length);
    const ch = [...new Set(net.pins.filter((p) => c.devices[p.dev].kind !== "box" && p.pin !== "G" && p.pin !== "B")
                                   .map((p) => colOf[p.dev]))];
    if (ch.length >= 2) bump(chan, ch, 2 / ch.length);
  }
  for (const g of c.groups) {
    if (g.members.length < 2) continue;
    const cs = [...new Set(g.members.map((d) => colOf[d]))];
    if (cs.length < 2) continue;
    bump(A, cs, g.kind === "leaf" ? 3 : 1 + 0.5 * g.depth);
  }
  return { A, chan };
}

// ---------------------------------------------------------------- 스펙트럼 순서
/** 대칭 행렬의 고유분해 (야코비 회전). 작은 행렬(열 수백 개까지)에 충분하다. */
function jacobi(M, n) {
  const a = Float64Array.from(M);
  const v = new Float64Array(n * n);
  for (let i = 0; i < n; i++) v[i * n + i] = 1;
  for (let sweep = 0; sweep < 80; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i * n + j] * a[i * n + j];
    if (off < 1e-20) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q];
        if (Math.abs(apq) < 1e-15) continue;
        const theta = (a[q * n + q] - a[p * n + p]) / (2 * apq);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const cs = 1 / Math.sqrt(t * t + 1), sn = t * cs;
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p], akq = a[k * n + q];
          a[k * n + p] = cs * akp - sn * akq; a[k * n + q] = sn * akp + cs * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k], aqk = a[q * n + k];
          a[p * n + k] = cs * apk - sn * aqk; a[q * n + k] = sn * apk + cs * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k * n + p], vkq = v[k * n + q];
          v[k * n + p] = cs * vkp - sn * vkq; v[k * n + q] = sn * vkp + cs * vkq;
        }
      }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[i * n + i] - a[j * n + j]);
  return { vals: order.map((i) => a[i * n + i]), vec: (k) => { const col = order[k]; return Array.from({ length: n }, (_, i) => v[i * n + col]); } };
}

/** 연결 성분 (크기 큰 순). */
function components(A, n) {
  const seen = new Uint8Array(n), out = [];
  for (let s = 0; s < n; s++) {
    if (seen[s]) continue;
    const comp = [s]; seen[s] = 1;
    for (let k = 0; k < comp.length; k++) {
      const i = comp[k];
      for (let j = 0; j < n; j++) if (!seen[j] && A[i * n + j] > 0) { seen[j] = 1; comp.push(j); }
    }
    out.push(comp.sort((a, b) => a - b));
  }
  return out.sort((a, b) => b.length - a.length || a[0] - b[0]);
}

/** 피들러 벡터로 열의 1 차원 좌표. 성분마다 따로 재고 [0,1] 로 맞춰 이어 붙인다. */
function spectral(A, n, c, cols, colOf) {
  const f = new Float64Array(n);
  let base = 0;
  for (const comp of components(A, n)) {
    const m = comp.length;
    let val;
    if (m <= 2) val = comp.map((_, k) => k);
    else {
      const L = new Float64Array(m * m);
      for (let i = 0; i < m; i++) {
        let deg = 0;
        for (let j = 0; j < m; j++) if (i !== j) { const w = A[comp[i] * n + comp[j]]; L[i * m + j] = -w; deg += w; }
        L[i * m + i] = deg;
      }
      val = jacobi(L, m).vec(1);
      // 입력(게이트에만 닿는 핀)은 왼쪽, 출력(드레인에 닿는 핀)은 오른쪽으로
      let inS = 0, inN = 0, outS = 0, outN = 0;
      for (const net of c.nets.values()) {
        if (!net.port || net.role || !net.pins.length) continue;
        const cs = [...new Set(net.pins.map((p) => colOf[p.dev]))].map((ci) => comp.indexOf(ci)).filter((k) => k >= 0);
        if (!cs.length) continue;
        const mean = cs.reduce((s, k) => s + val[k], 0) / cs.length;
        const gateOnly = net.pins.every((p) => p.pin === "G" || c.devices[p.dev].kind === "box");
        if (gateOnly) { inS += mean; inN++; }
        else if (net.pins.some((p) => p.pin === "D")) { outS += mean; outN++; }
      }
      if (inN && outN && inS / inN > outS / outN) val = val.map((x) => -x);
    }
    const lo = Math.min(...val), hi = Math.max(...val);
    comp.forEach((ci, k) => { f[ci] = base + (hi > lo ? (val[k] - lo) / (hi - lo) : 0.5); });
    base += 1.5;
  }
  return f;
}

// ---------------------------------------------------------------- 가로 순서 (대칭 포함)
/** 축 위 열들을 세로로 겹치지 않게 칸에 담는다. */
function packAxis(ids, cols) {
  const slots = [];
  for (const ci of ids.slice().sort((a, b) => cols[a].ymin - cols[b].ymin)) {
    const fit = slots.find((s) => s.every((cj) => cols[cj].ymax + 0.4 <= cols[ci].ymin || cols[ci].ymax + 0.4 <= cols[cj].ymin));
    if (fit) fit.push(ci); else slots.push([ci]);
  }
  return slots;
}

/** 열의 좌우 순서. 돌려주는 것: 칸(slot)의 나열 — 칸 하나는 열 여럿(세로로 쌓인 축 열)이거나 빈칸. */
function arrange(c, cols, colOf, A, chan, f) {
  const n = cols.length;
  const at = (M, i, j) => M[i * n + j];
  const partner = new Map();
  for (const [a, b] of c.mirrors) {
    const ca = colOf[a], cb = colOf[b];
    if (ca === cb) continue;
    if (partner.has(ca) || partner.has(cb)) continue;
    partner.set(ca, cb); partner.set(cb, ca);
  }
  const axisCols = new Set(c.axis.map((d) => colOf[d]).filter((ci) => !partner.has(ci)));
  if (!partner.size && !axisCols.size) {
    const seq = Array.from({ length: n }, (_, i) => i).sort((a, b) => f[a] - f[b] || a - b);
    return { slots: seq.map((ci) => ({ cols: [ci], width: cols[ci].width })), axisIndex: null, symmetric: false };
  }
  const side = new Map();
  for (const ci of axisCols) side.set(ci, 0);
  const sumTo = (M, ci, s) => { let t = 0; for (const [cj, sj] of side) if (sj === s && cj !== ci) t += at(M, ci, cj); return t; };
  const pairs = [];
  for (const [a, b] of partner) if (a < b) pairs.push([a, b]);
  const left = new Set(pairs.map((_, k) => k));
  while (left.size) {
    let best = -1, bestScore = -Infinity, bestLeft = true;
    for (const k of left) {
      const [a, b] = pairs[k];
      const sc = (sumTo(A, a, -1) + sumTo(A, b, 1)) - (sumTo(A, a, 1) + sumTo(A, b, -1));
      const gap = f[b] - f[a];
      const score = Math.abs(sc) + 1e-3 * Math.abs(gap);
      if (score > bestScore) { bestScore = score; best = k; bestLeft = sc !== 0 ? sc > 0 : gap !== 0 ? gap > 0 : true; }
    }
    const [a, b] = pairs[best];
    left.delete(best);
    side.set(a, bestLeft ? -1 : 1); side.set(b, bestLeft ? 1 : -1);
  }
  // 나머지 열: 양쪽에 채널로 닿으면 축 위, 아니면 친화도 큰 쪽 (같으면 왼쪽)
  const rest = Array.from({ length: n }, (_, i) => i).filter((ci) => !side.has(ci));
  const total = (ci) => { let t = 0; for (let j = 0; j < n; j++) t += at(A, ci, j); return t; };
  rest.sort((a, b) => total(b) - total(a) || a - b);
  for (const ci of rest) {
    const l = sumTo(chan, ci, -1), r = sumTo(chan, ci, 1);
    if (l > 0 && r > 0) { side.set(ci, 0); axisCols.add(ci); continue; }
    side.set(ci, sumTo(A, ci, -1) >= sumTo(A, ci, 1) ? -1 : 1);
  }
  // 안쪽 정도: 반대쪽·축과의 연결이 많을수록 안쪽
  const inner = (ci) => {
    const s = side.get(ci);
    return sumTo(chan, ci, -s) + sumTo(chan, ci, 0) + 0.5 * (sumTo(A, ci, -s) + sumTo(A, ci, 0));
  };
  const L = [...side].filter(([, s]) => s === -1).map(([ci]) => ci).sort((a, b) => inner(a) - inner(b) || f[a] - f[b] || a - b);
  const R = [...side].filter(([, s]) => s === 1).map(([ci]) => ci).sort((a, b) => inner(a) - inner(b) || f[b] - f[a] || a - b);
  // 오른쪽은 왼쪽의 거울: 짝이 있으면 짝, 없으면 빈칸 (짝 없는 오른쪽 열이 빈칸을 채운다)
  const right = [];                                     // 안쪽 -> 바깥
  const used = new Set();
  for (const ci of [...L].reverse()) {
    const p = partner.get(ci);
    if (p != null) { right.push({ cols: [p] }); used.add(p); } else right.push({ cols: [] });
  }
  for (const ci of [...R].reverse()) {                  // 안쪽부터
    if (used.has(ci)) continue;
    const gap = right.find((s) => !s.cols.length);
    if (gap) gap.cols.push(ci); else right.push({ cols: [ci] });
    used.add(ci);
  }
  while (right.length && !right[right.length - 1].cols.length) right.pop();
  const leftSlots = L.map((ci) => ({ cols: [ci] }));
  const axisSlots = packAxis([...axisCols], cols).map((cs) => ({ cols: cs }));
  const slots = [...leftSlots, ...axisSlots, ...right];
  // 폭: 거울 자리끼리 같게
  const w = (s) => Math.max(0, ...s.cols.map((ci) => cols[ci].width)) || COL;
  for (const s of slots) s.width = w(s);
  const nl = leftSlots.length;
  for (let k = 0; k < Math.max(nl, right.length); k++) {
    const a = leftSlots[nl - 1 - k], b = right[k];
    if (a && b) a.width = b.width = Math.max(a.width, b.width);
  }
  return { slots, axisIndex: nl, axisCount: axisSlots.length, symmetric: true };
}

// ---------------------------------------------------------------- 선
function segLen(s) { return Math.abs(s[2] - s[0]) + Math.abs(s[3] - s[1]); }

/** 핀에서 줄기 높이 ty 까지의 선. 자연스러운 방향(위·아래·옆)으로 나가고, 줄기가 반대쪽이면 비켜 돌아간다. */
function lead(p, ty, toward) {
  const segs = [];
  if (p.dir === "up" || p.dir === "down") {
    const s = p.dir === "up" ? 1 : -1;
    if ((ty - p.y) * s >= -0.5) {
      if (Math.abs(ty - p.y) > 0.5) segs.push([p.x, p.y, p.x, ty]);
      return { segs, x: p.x };
    }
    const e = p.x + 18 * (toward >= p.x ? 1 : -1);
    const y1 = p.y + 8 * s;
    segs.push([p.x, p.y, p.x, y1], [p.x, y1, e, y1], [e, y1, e, ty]);
    return { segs, x: e };
  }
  const s = p.dir === "left" ? -1 : 1;
  const xg = p.x + 12 * s;
  segs.push([p.x, p.y, xg, p.y]);
  if (Math.abs(ty - p.y) > 0.5) segs.push([xg, p.y, xg, ty]);
  return { segs, x: xg };
}

/** 줄기 [x0,x1] 이 높이 ty 에서 기호를 지나는가. */
function hitsSymbol(devs, ty, x0, x1, margin = 5) {
  for (const d of devs)
    if (x1 >= d.x0 - margin && x0 <= d.x1 + margin && ty >= d.y0 - margin && ty <= d.y1 + margin) return d;
  return null;
}

function wires(c, placed, netY) {
  const boxes = placed.map((d) => ({ x0: d.x - d.hw, x1: d.x + d.hw, y0: d.y - d.hh, y1: d.y + d.hh }));
  const pinsOf = new Map();
  for (const d of placed)
    for (const p of d.pins) {
      if (p.net == null) continue;
      (pinsOf.get(p.net) ?? pinsOf.set(p.net, []).get(p.net)).push(p);
    }
  const allX = placed.flatMap((d) => [d.x - d.hw, d.x + d.hw]);
  const xmin = Math.min(...allX) - 30, xmax = Math.max(...allX) + 30;
  const out = [];
  const trunks = [];
  const rails = { vdd: 0, gnd: 0 };
  for (const net of c.nets.values()) {
    const pins = pinsOf.get(net.name) ?? [];
    if (net.role) {
      const k = rails[net.role]++;
      const ty = netY.get(net.name) * ROW + (net.role === "vdd" ? 14 * k : -14 * k);
      const segs = [[xmin, ty, xmax, ty]];
      const dots = [];
      for (const p of pins) {
        const l = lead(p, ty, p.x);
        segs.push(...l.segs);
        dots.push([l.x, ty]);
      }
      out.push({ name: net.name, role: net.role, port: net.port, segs, dots, label: { x: xmin - 6, y: ty, align: "right" },
                 trunk: [xmin, xmax, ty] });
      continue;
    }
    if (!pins.length) continue;
    let ty = netY.get(net.name) * ROW;
    const cx = pins.reduce((s, p) => s + p.x, 0) / pins.length;
    // 핀(포트)인 넷은 줄기를 그림 가장자리까지 끌어 이름을 밖에 적는다 — 입력은 왼쪽, 출력은 오른쪽
    const side = net.port ? (cx <= 0 ? -1 : 1) : 0;
    const xe = side < 0 ? xmin + 8 : side > 0 ? xmax - 8 : null;
    const build = (y) => {
      const leads = pins.map((l) => lead(l, y, cx));
      const xs = leads.map((l) => l.x);
      let x0 = Math.min(...xs), x1 = Math.max(...xs);
      if (xe != null) { x0 = Math.min(x0, xe); x1 = Math.max(x1, xe); }
      return { leads, x0, x1 };
    };
    // 줄기를 기호와 다른 줄기에서 비켜 놓는다
    let b = build(ty);
    const clear = (y) => {
      const t = build(y);
      if (hitsSymbol(boxes, y, t.x0, t.x1)) return false;
      for (const o of trunks) if (Math.abs(o[2] - y) < 11 && t.x1 + 4 >= o[0] && t.x0 - 4 <= o[1]) return false;
      return true;
    };
    if (!clear(ty)) {
      const tries = [];
      for (let k = 1; k <= 8; k++) tries.push(ty + 12 * k, ty - 12 * k);
      const hit = hitsSymbol(boxes, ty, b.x0, b.x1);
      if (hit) tries.unshift(ty >= (hit.y0 + hit.y1) / 2 ? hit.y1 + 8 : hit.y0 - 8);
      const ok = tries.find((y) => clear(y));
      if (ok != null) ty = ok;
      b = build(ty);
    }
    const segs = [];
    if (b.x1 - b.x0 > 0.5) segs.push([b.x0, ty, b.x1, ty]);
    for (const l of b.leads) segs.push(...l.segs);
    // 분기점: 한 자리에 선이 셋 이상 모이면 점
    const dots = [];
    const xs = b.leads.map((l) => l.x);
    for (const x of new Set(xs)) {
      let k = xs.filter((v) => Math.abs(v - x) < 0.5).length;
      if (x - b.x0 > 0.5) k++;
      if (b.x1 - x > 0.5) k++;
      if (k >= 3) dots.push([x, ty]);
    }
    let label = null;
    if (net.port) {
      label = { x: xe + 4 * side, y: ty, align: side < 0 ? "right" : "left", port: true };
    } else if (pins.length >= 3 && b.x1 - b.x0 > 40) {
      label = { x: (b.x0 + b.x1) / 2, y: ty + 4, align: "center", port: false };
    }
    trunks.push([b.x0, b.x1, ty]);
    out.push({ name: net.name, role: null, port: net.port, segs: segs.filter((s) => segLen(s) > 0.01), dots, label,
               trunk: [b.x0, b.x1, ty] });
  }
  return out;
}

// ---------------------------------------------------------------- 전체
export function layoutCircuit(c) {
  if (!c.devices.length)
    return { devices: [], nets: [], hulls: [], axis: null, bbox: [0, 0, 1, 1], stats: { devices: 0, nets: 0, columns: 0, symmetric: false } };
  const { netY, boxY } = solveY(c);
  const geo = geometry(c, netY, boxY);
  const { cols, colOf } = columns(c, geo);
  const { A, chan } = affinity(c, cols, colOf);
  const f = spectral(A, cols.length, c, cols, colOf);
  const arr = arrange(c, cols, colOf, A, chan, f);

  // 칸 -> x
  let x = 0;
  const slotX = arr.slots.map((s) => { const cx = x + s.width / 2; x += s.width; return cx; });
  let shift;
  if (!arr.symmetric) shift = x / 2;
  else if (arr.axisCount) {
    const a0 = slotX[arr.axisIndex] - arr.slots[arr.axisIndex].width / 2;
    const a1 = slotX[arr.axisIndex + arr.axisCount - 1] + arr.slots[arr.axisIndex + arr.axisCount - 1].width / 2;
    shift = (a0 + a1) / 2;
  } else shift = arr.axisIndex < slotX.length ? slotX[arr.axisIndex] - arr.slots[arr.axisIndex].width / 2 : x;
  const colX = new Float64Array(cols.length);
  arr.slots.forEach((s, k) => { for (const ci of s.cols) colX[ci] = slotX[k] - shift; });

  // 소자 자리
  const placed = c.devices.map((d) => {
    const g = geo[d.id];
    return { id: d.id, name: d.name, short: d.short ?? d.name.replace(/^.*\//, ""), kind: d.kind, sub: d.sub, group: d.group,
             x: colX[colOf[d.id]], y: g.y * ROW, hw: g.hw, hh: g.hh, horiz: g.horiz, s: 1, pins: [] };
  });
  // 게이트 방향: 게이트 넷의 다른 핀이 있는 쪽. 없으면(입력) 바깥쪽. 거울 쌍은 서로 반대
  for (const d of placed) {
    if (!isMos(c.devices[d.id])) continue;
    const G = pin(c.devices[d.id], "G");
    const others = (c.nets.get(G)?.pins ?? []).filter((p) => p.dev !== d.id).map((p) => placed[p.dev].x);
    if (!others.length) d.s = d.x <= 0 ? 1 : -1;
    else {
      const mean = others.reduce((s, v) => s + v, 0) / others.length;
      d.s = mean < d.x - 1 ? 1 : mean > d.x + 1 ? -1 : d.x <= 0 ? 1 : -1;
    }
  }
  for (const [a, b] of c.mirrors) {
    const [l, r] = placed[a].x <= placed[b].x ? [placed[a], placed[b]] : [placed[b], placed[a]];
    if (isMos(c.devices[l.id]) && isMos(c.devices[r.id])) r.s = -l.s;
  }
  // 단자
  for (const d of placed) {
    const dev = c.devices[d.id];
    if (isMos(dev)) {
      const D = pin(dev, "D"), G = pin(dev, "G"), S = pin(dev, "S");
      const top = { x: d.x, y: d.y + LEAD, dir: "up" }, bot = { x: d.x, y: d.y - LEAD, dir: "down" };
      const [tn, bn] = dev.kind === "nmos" ? ["D", "S"] : ["S", "D"];
      if (D === S) d.pins.push({ name: "S", net: S, ...bot });
      else d.pins.push({ name: tn, net: pin(dev, tn), ...top }, { name: bn, net: pin(dev, bn), ...bot });
      d.pins.push({ name: "G", net: G, x: d.x - LEAD * d.s, y: d.y, dir: d.s > 0 ? "left" : "right" });
    } else if (dev.kind === "box") {
      const role = (n) => c.nets.get(n)?.role;
      let k = 0;
      const sides = dev.pins.filter((p) => !role(p.net));
      const per = Math.ceil(sides.length / 2);
      for (const p of dev.pins) {
        if (role(p.net) === "vdd") d.pins.push({ name: p.name, net: p.net, x: d.x, y: d.y + d.hh + 10, dir: "up" });
        else if (role(p.net) === "gnd") d.pins.push({ name: p.name, net: p.net, x: d.x, y: d.y - d.hh - 10, dir: "down" });
        else {
          const col = k < per ? -1 : 1, row = k < per ? k : k - per;
          const y = d.y + d.hh - 12 - row * 18;
          d.pins.push({ name: p.name, net: p.net, x: d.x + col * (d.hw + 10), y, dir: col < 0 ? "left" : "right" });
          k++;
        }
      }
    } else {
      const g = geo[d.id];
      if (g.horiz) d.pins.push({ name: "P", net: g.top, x: d.x - LEAD, y: d.y, dir: "left" },
                               { name: "N", net: g.bot, x: d.x + LEAD, y: d.y, dir: "right" });
      else {
        const P = pin(dev, "P");
        d.pins.push({ name: g.top === P ? "P" : "N", net: g.top, x: d.x, y: d.y + LEAD, dir: "up" },
                    { name: g.top === P ? "N" : "P", net: g.bot, x: d.x, y: d.y - LEAD, dir: "down" });
      }
    }
  }
  const nets = wires(c, placed, netY);

  // 묶음 테두리 — 안쪽 것이 먼저 (작게), 바깥 것은 그만큼 더 넓게
  const height = new Map();
  const hgt = (g) => {
    if (height.has(g.id)) return height.get(g.id);
    const h = g.children.length ? 1 + Math.max(...g.children.map((k) => hgt(c.groups[k]))) : 0;
    height.set(g.id, h);
    return h;
  };
  const hulls = [];
  for (const g of c.groups) {
    if (!g.hull || !g.members.length) continue;
    const pad = 10 + 7 * hgt(g);
    const ds = g.members.map((m) => placed[m]);
    hulls.push({ id: g.id, name: g.name, family: g.family, gloss: g.gloss, kind: g.kind, depth: g.depth, height: hgt(g),
                 x0: Math.min(...ds.map((d) => d.x - d.hw)) - pad, x1: Math.max(...ds.map((d) => d.x + d.hw)) + pad,
                 y0: Math.min(...ds.map((d) => d.y - d.hh)) - pad, y1: Math.max(...ds.map((d) => d.y + d.hh)) + pad + 10 });
  }
  hulls.sort((a, b) => b.height - a.height || a.depth - b.depth);

  // 전체 상자
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const take = (a, b, c2, d2) => { x0 = Math.min(x0, a); y0 = Math.min(y0, b); x1 = Math.max(x1, c2); y1 = Math.max(y1, d2); };
  for (const d of placed) take(d.x - d.hw - 40, d.y - d.hh - 22, d.x + d.hw + 40, d.y + d.hh + 12);
  for (const n of nets) {
    for (const s of n.segs) take(Math.min(s[0], s[2]), Math.min(s[1], s[3]), Math.max(s[0], s[2]), Math.max(s[1], s[3]));
    if (n.label?.port || n.role) {
      const w = 7 * n.name.length + 8;
      take(n.label.align === "right" ? n.label.x - w : n.label.x, n.label.y - 8, n.label.align === "right" ? n.label.x : n.label.x + w, n.label.y + 8);
    }
  }
  for (const h of hulls) take(h.x0, h.y0, h.x1, h.y1);
  const M = 28;
  return {
    devices: placed, nets, hulls, axis: arr.symmetric ? 0 : null,
    bbox: [x0 - M, y0 - M, x1 + M, y1 + M],
    stats: { devices: placed.length, nets: nets.length, columns: cols.length, symmetric: arr.symmetric,
             mirrors: c.mirrors.length, hulls: hulls.length },
  };
}
