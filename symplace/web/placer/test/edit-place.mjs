/** 배치 편집 검사 (src/edit/place.mjs) — 편집 키트, 끌기 사영, 정리, 변이 다시 고르기.
 *
 *  예제마다 배치(CPU, 시작점 BATCH, 격자)를 한 번 한 뒤:
 *    키트     rebuild 한 문제가 배치기 안의 문제와 이름·크기·핀이 같고, theta 를 되찾은 좌표 오차 < 1e-9
 *    끌기     자유 블록은 포인터를 따라오고, 거울 쌍은 짝이 거울로, 축 위 블록은 축을 따라서만, 축 핸들은 그룹째.
 *             끄는 동안 대칭 잔차 < 1e-9
 *    정리     편집 6 종 (끌기 넷, 자리 바꾸기, 겹치게 던지기) 마다 겹침 0, 잔차 < 1e-9, 격자 밖 0,
 *             편집 좌표에서 성립하던 쌍 관계 보존, 편집 없이 정리하면 이동 0
 *    변이     같은 위상에서 배정을 전수로 — 지금 배정이 항등이고, 1 위 점수 <= 지금 점수
 *
 *  실행:  node symplace/web/placer/test/edit-place.mjs [예제 ...]    (BATCH=48, ALL=1 이면 예제 전부, CACHE=1 이면 배치를 캐시)
 */
import fs from "node:fs";
import path from "node:path";
import { loadDesign, exampleNames } from "./_load.mjs";
import { placeHierarchy } from "../../../../src/place.mjs";
import { editKit, rebuild, centers, dragTheta, pinRows, dragRows, relations, settle, toRects,
         chooseFlips, flipGroup, variantChoices, withVariant, retryVariants, GRID } from "../../../../src/edit/place.mjs";
import { symmetryResidual } from "../../../../src/place.mjs";

const BATCH = Number(process.env.BATCH ?? 48);
const CACHE = process.env.SYMPLACE_CACHE ?? path.join(process.env.HOME ?? "", ".cache/symplace");
const DEFAULT = ["telescopic_ota", "five_transistor_ota", "cascode_current_mirror_ota", "high_speed_comparator"];
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : process.env.ALL ? exampleNames() : DEFAULT;
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  실패 " + m); } };
const maxAbs = (a, b) => { let e = 0; for (let i = 0; i < a.length; i++) e = Math.max(e, Math.abs(a[i] - b[i])); return e; };

for (const ex of wanted) {
  console.log("\n=== " + ex + " ===");
  const blob = loadDesign(ex);
  // 배치는 오래 걸린다 (hsc 34 s). CACHE=1 이면 rects·kit 을 캐시(SYMPLACE_CACHE)에서 읽고, 없으면 배치한 뒤 쓴다.
  const cacheFile = path.join(CACHE, `edit-${ex}.json`);
  let rects, kit, top = null, P0 = null;
  if (process.env.CACHE && fs.existsSync(cacheFile)) {
    ({ rects, kit } = JSON.parse(fs.readFileSync(cacheFile, "utf8")));
    console.log(`  캐시 ${cacheFile}`);
  } else {
    const t0 = Date.now();
    const hr = await placeHierarchy(blob, { batch: BATCH, iters: 600, seed: 1, grid: GRID });
    if (!hr.ok) { fails++; console.log(`  배치 실패 [${hr.module}] ${hr.reason}`); continue; }
    top = hr.top; P0 = top.problem;
    console.log(`  배치 ${((Date.now() - t0) / 1000).toFixed(1)}s  블록 ${P0.n}  bbox ${Math.round(top.box[2] - top.box[0])}x${Math.round(top.box[3] - top.box[1])}`);
    // --- 키트 -> 페이지의 rects (done 과 같은 모양, 원점 0) ---
    kit = editKit(hr, GRID);
    const [ox0, oy0] = [top.box[0], top.box[1]];
    rects = P0.names.map((nm, i) => ({ name: nm, concrete: top.concrete[i],
      x: top.cx[i] - P0.w[i] / 2 - ox0, y: top.cy[i] - P0.h[i] / 2 - oy0, w: P0.w[i], h: P0.h[i], sx: top.sx[i], sy: top.sy[i] }));
    if (process.env.CACHE) { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify({ rects, kit })); }
  }
  const model = rebuild(blob, kit, rects);
  const P = model.P;
  const c0 = centers(model);
  if (P0) {
    const [ox0, oy0] = [top.box[0], top.box[1]];
    ok(P.names.join() === P0.names.join(), "다시 지은 문제의 이름·순서가 다르다");
    ok(maxAbs(P.w, P0.w) === 0 && maxAbs(P.h, P0.h) === 0, "크기가 다르다");
    ok(P.pinInst.length === P0.pinInst.length && maxAbs(P.pinOff, P0.pinOff) < 1e-9, "핀이 다르다");
    const e = Math.max(maxAbs(c0.cx, P0.names.map((_, i) => top.cx[i] - ox0)), maxAbs(c0.cy, P0.names.map((_, i) => top.cy[i] - oy0)));
    ok(e < 1e-9, `theta 되찾기 오차 ${e}`);
    console.log(`  키트 템플릿 ${Object.keys(kit.subTemplates).length} 개 ${JSON.stringify(kit).length} 바이트  자유도 ${model.K}  축 ${model.nAxis}  되찾기 오차 ${e.toExponential(1)}`);
  } else {
    // 캐시에서 왔으면 좌표가 제약을 지키는지만 (theta 왕복)
    const e = Math.max(maxAbs(c0.cx, rects.map((r) => r.x + r.w / 2)), maxAbs(c0.cy, rects.map((r) => r.y + r.h / 2)));
    ok(e < 1e-9, `theta 되찾기 오차 ${e}`);
  }

  // --- 끌기 ---
  const n = model.n, cx0 = c0.cx, cy0 = c0.cy, ax0 = c0.ax;
  const pins = pinRows(model);
  const drag = (names, dx, dy, opt) => centers(model, dragTheta(model, model.theta, opt?.group ? pinRows(model, { lockAxes: false }) : pins, dragRows(model, names, dx, dy, cx0, cy0, ax0, opt)));
  const roleOf = (nm) => model.roles.get(nm);
  const cases = [];
  {
    const free = P.names.find((nm) => !roleOf(nm));
    if (free) {
      const i = model.idx.get(free), d = drag([free], 0.6 * P.w[i], 0.4 * P.h[i]);
      ok(Math.abs(d.cx[i] - cx0[i] - 0.6 * P.w[i]) < 1e-6 && Math.abs(d.cy[i] - cy0[i] - 0.4 * P.h[i]) < 1e-6, "자유 블록이 포인터를 안 따라온다");
      ok(symmetryResidual(P, d.cx, d.cy) < 1e-9, "끄는 동안 잔차");
      cases.push(["자유 블록 끌기", d]);
    }
    const pairName = P.names.find((nm) => roleOf(nm)?.len === 2);
    if (pairName) {
      const r = roleOf(pairName), i = model.idx.get(pairName), j = model.idx.get(r.pair[1 - r.pos]);
      const d = drag([pairName], 0.5 * P.w[i], 1.2 * P.h[i]);
      const mirror = r.vert ? [d.cx[j] - cx0[j], d.cy[j] - cy0[j]] : [d.cy[j] - cy0[j], d.cx[j] - cx0[j]];
      const own = r.vert ? [d.cx[i] - cx0[i], d.cy[i] - cy0[i]] : [d.cy[i] - cy0[i], d.cx[i] - cx0[i]];
      ok(Math.abs(mirror[0] + own[0]) < 1e-6 && Math.abs(mirror[1] - own[1]) < 1e-6, `거울 쌍의 짝이 거울로 안 따라온다 (${own} / ${mirror})`);
      ok(Math.abs(d.ax[r.k] - ax0[r.k]) < 1e-6, "축이 움직였다");
      cases.push(["거울 쌍 한쪽 끌기", d]);
    }
    const selfName = P.names.find((nm) => roleOf(nm)?.len === 1);
    if (selfName) {
      const r = roleOf(selfName), i = model.idx.get(selfName);
      const d = drag([selfName], 500, 2 * P.h[i]);
      const perp = r.vert ? d.cx[i] - cx0[i] : d.cy[i] - cy0[i];
      const along = r.vert ? d.cy[i] - cy0[i] : d.cx[i] - cx0[i];
      ok(Math.abs(perp) < 1e-6, `축 위 블록이 축을 벗어났다 (${perp})`);
      ok(Math.abs(along - (r.vert ? 2 * P.h[i] : 500)) < 1e-6, "축 위 블록이 축을 따라 안 움직였다");
      cases.push(["축 위 블록 끌기 (축 방향)", d]);
      // 축 핸들: 그룹째 (자기대칭 블록을 group 으로 끌면 축 행에 목표가 붙는다)
      const g = drag([selfName], 700, 0, { group: true });
      const moved = P.names.filter((nm) => roleOf(nm)?.k === r.k && Math.abs((r.vert ? g.cx : g.cy)[model.idx.get(nm)] - (r.vert ? cx0 : cy0)[model.idx.get(nm)]) > 1e-6).length;
      const members = P.names.filter((nm) => roleOf(nm)?.k === r.k).length;
      ok(Math.abs(g.ax[r.k] - ax0[r.k] - 700) < 1e-6, "축이 목표로 안 갔다");
      ok(moved === members, `축을 끌었는데 그룹 ${moved}/${members} 만 움직였다`);
      cases.push(["축 끌기 (그룹째)", g]);
    }
    const selfs = P.names.filter((nm) => roleOf(nm)?.len === 1);
    if (selfs.length >= 2) {
      const a = model.idx.get(selfs[0]), b = model.idx.get(selfs[1]);
      const th = dragTheta(model, model.theta, pins, [[2 * a + 1, cy0[b]], [2 * b + 1, cy0[a]]]);
      cases.push(["자리 바꾸기 (축 위 둘)", centers(model, th)]);
    }
    const i = n - 1, j = 0;
    if (i !== j) cases.push(["겹치게 던지기", drag([P.names[i]], cx0[j] + 0.3 * P.w[j] - cx0[i], cy0[j] + 0.2 * P.h[j] - cy0[i])]);
  }

  // --- 정리 ---
  let blockArea = 0; for (let i = 0; i < n; i++) blockArea += P.w[i] * P.h[i];
  const base = toRects(model, cx0, cy0, model.sx, model.sy);
  const run = (label, d, opts = {}) => {
    const r = settle(model, d.cx, d.cy, model.sx, model.sy, opts);
    if (r.status !== "OPTIMAL") {
      // Order 를 어긴 편집은 실패해도 된다 — 그때는 어느 제약인지 알려야 한다
      const excused = r.orderBad.length > 0;
      console.log(`  ${label.padEnd(30)} ${r.status}${excused ? " (Order 위반 " + r.orderBad.join(", ") + ")" : ""}  ${r.ms.toFixed(0)} ms`);
      ok(excused, `${label}: 정리 실패 ${r.status}`);
      return;
    }
    const out = toRects(model, r.cx, r.cy, model.sx, model.sy);
    const relE = relations(model, d.cx, d.cy), relF = relations(model, r.cx, r.cy);
    // Order 로 박힌 쌍은 편집이 어겼어도 정리가 바로잡는다 — 그 쌍은 박은 방향을 지켰는지 본다
    const forcedOf = new Map(r.dirs.filter((z) => z.forced).map((z) => [`${z.i},${z.j}`, z.dir]));
    let kept = 0, tot = 0;
    relE.forEach((q, k) => {
      const f = relF[k], fd = forcedOf.get(`${q.i},${q.j}`);
      if (fd !== undefined) { tot++; if (f.x === fd || f.y === fd) kept++; return; }
      if (q.x >= 0 || q.y >= 0) { tot++; if ((q.x >= 0 && f.x === q.x) || (q.y >= 0 && f.y === q.y)) kept++; }
    });
    let move = 0; for (let i = 0; i < n; i++) move += Math.abs(r.cx[i] - d.cx[i]) + Math.abs(r.cy[i] - d.cy[i]);
    console.log(`  ${label.padEnd(30)} OPTIMAL ${r.ms.toFixed(0).padStart(4)} ms  겹침 ${(out.overlap / blockArea).toExponential(1)}  잔차 ${out.resid.toExponential(1)}  격자밖 ${out.offgrid}  관계 ${kept}/${tot}  이동 ${move.toFixed(0)}  면적 ${(out.area / base.area).toFixed(3)}x  HPWL ${(out.hpwl / base.hpwl).toFixed(3)}x`);
    ok(out.overlap / blockArea < 1e-9, `${label}: 겹침`);
    ok(out.resid < 1e-9, `${label}: 잔차 ${out.resid}`);
    ok(out.offgrid === 0, `${label}: 격자 밖 ${out.offgrid}`);
    if (kept !== tot)
      relE.forEach((q, k) => {
        const f = relF[k];
        const d = r.dirs.find((z) => z.i === q.i && z.j === q.j);
        if (d?.forced) return;
        if (!((q.x >= 0 || q.y >= 0) && !((q.x >= 0 && f.x === q.x) || (q.y >= 0 && f.y === q.y)))) return;
        console.log(`      바뀐 쌍 ${P.names[q.i]} ~ ${P.names[q.j]}: 편집 (x ${q.x}, y ${q.y}) -> 정리 (x ${f.x}, y ${f.y})  박은 방향 ${d?.dir}${d?.forced ? " (Order)" : ""}`);
      });
    ok(kept === tot, `${label}: 관계 ${kept}/${tot}`);
    ok(out.orderBad === 0, `${label}: Order 위반 ${out.orderBad}`);
    return { r, out, move };
  };
  for (const [label, d] of cases) { run(label + " · 하나", d); run(label + " · 둘 다", d, { both: true }); }
  const same = run("편집 없음", c0);
  if (same) ok(same.move < 1e-6, `편집 없이 정리했는데 ${same.move} 움직였다`);

  // --- 반전·변이 ---
  const fr = chooseFlips(model, cx0, cy0);
  ok(Math.abs(fr.hpwl - base.hpwl) < 1e-6 || fr.hpwl <= base.hpwl + 1e-6, "반전 다시 고르기가 HPWL 을 늘렸다");
  for (const nm of P.names) {
    for (const axis of ["x", "y"]) {
      const f = flipGroup(model, nm, axis, model.sx, model.sy);
      if (!f) continue;
      const i = model.idx.get(nm);
      ok((axis === "x" ? f.sx[i] : f.sy[i]) === -(axis === "x" ? model.sx[i] : model.sy[i]), `${nm} ${axis} 반전이 안 뒤집혔다`);
    }
    const vc = variantChoices(model, nm);
    ok(vc && vc.current === P.concrete[model.idx.get(nm)], `${nm} 의 변이 후보를 못 찾았다`);
    if (vc && vc.choices.length > 1) {
      const other = vc.choices.find((c) => c.concrete !== vc.current);
      const rects2 = withVariant(model, base.rects, nm, other.concrete);
      const m2 = rebuild(blob, kit, rects2);
      ok(m2.P.concrete[m2.idx.get(nm)] === other.concrete, `${nm} 변이 바꾸기가 안 먹었다`);
      break;
    }
  }

  // --- 변이 다시 고르기 (같은 위상) ---
  const rv = retryVariants(model, cx0, cy0, model.sx, model.sy, { cap: 128 });
  const cur = rv.ranking[rv.current];
  console.log(`  변이 다시: 배정 ${rv.total} (본 것 ${rv.tried}, 풀린 것 ${rv.ranking.length}) ${rv.ms.toFixed(0)} ms  지금 ${rv.current + 1} 위  1 위 ${Math.round(rv.ranking[0].bbox[2])}x${Math.round(rv.ranking[0].bbox[3])} 점수 ${rv.ranking[0].score.toFixed(3)} (지금 ${cur?.score.toFixed(3)})`);
  ok(cur && Math.abs(cur.score - base.score) < 1e-6, `지금 배정이 항등이 아니다 (${cur?.score} / ${base.score})`);
  ok(rv.ranking[0].score <= base.score + 1e-9, "1 위가 지금보다 나쁘다");
  // 고정: 첫 그룹의 지금 변이를 고정하면 그 변이만 나와야 한다
  const g0 = model.groups.find((g) => g.choices.length > 1);
  if (g0) {
    const nm = model.design.instances[g0.members[0]].name, c = P.concrete[model.idx.get(nm)];
    const rf = retryVariants(model, cx0, cy0, model.sx, model.sy, { cap: 128, fixed: { [nm]: c } });
    ok(rf.ranking.every((r) => r.concrete[model.idx.get(nm)] === c), "고정한 변이가 안 지켜졌다");
  }
}
console.log(fails ? `\n실패 ${fails} 건` : "\n전부 통과");
process.exit(fails ? 1 : 0);
