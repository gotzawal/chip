/** 두 배선 결과 — "ALIGN 원본"(alignworker.mjs) 과 "Rust 이식"(routeworker.mjs) — 를 견준다.
 *
 *  같은 배치에서 넷이 같아야 한다:
 *    최종 도형   검사기가 정리한 도형 (색 사본과 Outline 은 빼고) — 다중집합으로, bbox 까지
 *    GDS        파이썬 판 GDS 바이트 (BGNLIB/BGNSTR 의 시각만 빼고)
 *    오류 문구   DRC/LVS 줄 (개수와 앞 40 줄)
 *    단계 기록   RouteWork 마다 배선기가 쓴 필드 (records.mjs) — 어디서 갈라졌는지 짚는다
 */
import { compareRuns } from "./records.mjs";

export const shapeKey = (t) =>
  `${t.layer}|${t.netName ?? ""}|${t.netType ?? ""}|${t.rect.join(",")}` + (t.terminal ? `|${t.terminal}` : "");

const shapes = (geo) => (geo?.terminals ?? []).filter((t) => t.layer !== "Outline" && !t.color);

function count(arr) {
  const m = new Map();
  for (const t of arr) { const k = shapeKey(t); m.set(k, (m.get(k) ?? 0) + 1); }
  return m;
}

/** 최종 도형 비교. onlyA/onlyB 는 한쪽에만 있는 도형의 키 (그림에서 강조한다). */
export function compareLayouts(a, b) {
  const A = count(shapes(a)), B = count(shapes(b));
  const onlyA = [], onlyB = [];
  for (const [k, n] of A) for (let i = n - (B.get(k) ?? 0); i > 0; i--) onlyA.push(k);
  for (const [k, n] of B) for (let i = n - (A.get(k) ?? 0); i > 0; i--) onlyB.push(k);
  const bboxSame = JSON.stringify(a?.bbox) === JSON.stringify(b?.bbox);
  const layers = new Map();
  for (const k of [...onlyA, ...onlyB]) { const l = k.split("|")[0]; layers.set(l, (layers.get(l) ?? 0) + 1); }
  return {
    same: !onlyA.length && !onlyB.length && bboxSame, bboxSame,
    nA: shapes(a).length, nB: shapes(b).length, onlyA, onlyB,
    byLayer: [...layers].sort((x, y) => y[1] - x[1]),
  };
}

/** GDSII 바이트가 시각 필드만 빼고 같은가 */
export function gdsSame(a, b) {
  if (!a || !b) return null;
  const x = new Uint8Array(a), y = new Uint8Array(b);
  if (x.length !== y.length) return false;
  const blank = (u) => {
    const v = u.slice();
    for (let off = 0; off + 4 <= v.length;) {
      const len = (v[off] << 8) | v[off + 1];
      if (len < 4) break;
      if (v[off + 2] === 0x01 || v[off + 2] === 0x05) v.fill(0, off + 4, Math.min(off + len, off + 28));   // BGNLIB, BGNSTR
      off += len;
    }
    return v;
  };
  const p = blank(x), q = blank(y);
  for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return false;
  return true;
}

/** DRC/LVS 오류 문구 — ALIGN 원본(pyroute.py)은 앞 40 줄만 넘기므로 개수와 그 앞부분을 견준다 */
export function errorsSame(a, b) {
  if (!a?.errors || !b?.errors) return null;
  if ((a.nerrors ?? a.errors.length) !== (b.nerrors ?? b.errors.length)) return false;
  const n = Math.min(a.errors.length, b.errors.length);
  for (let i = 0; i < n; i++) if (a.errors[i] !== b.errors[i]) return false;
  return true;
}

/** 한 번에: {layout, gds, errors, stages} — stages 는 둘 다 기록이 있을 때만 */
export function compareResults(align, rust) {
  return {
    layout: compareLayouts(align.geo, rust.geo),
    gds: gdsSame(align.gds, rust.gds),
    errors: errorsSame(align, rust),
    stages: align.records && rust.records ? compareRuns(align.records, rust.records) : null,
  };
}
