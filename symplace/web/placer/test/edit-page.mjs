/** 페이지의 편집기 — headless Chromium 에서 index.html 을 열어 배치한 뒤 편집 모드로 고쳐 본다.
 *
 *  보는 것:
 *    편집 토글이 켜지고 카드가 뜬다. 편집이 없으면 배치 결과(rects)가 그대로다.
 *    블록을 끌면 그 블록만 따라오고(자유 블록) 정리 전 상태가 되며, Enter 로 정리하면 겹침 0·편집 1 회,
 *    이 배치의 배선 결과는 지워진다. F 로 반전, Z 로 되돌리기, 카드에서 variant 를 고르면 고정되고
 *    다음 Placement 실행이 그 variant 를 쓴다. "위상 유지 최적화" 가 순위를 보인다.
 *
 *    그 다음 배선하고 배선 편집 모드에서 넷·조각을 골라 한 트랙 끌면 재검사가 돌고 그 넷이 고정되며, Z/Y 로
 *    되돌리고, "이 넷만 다시 배선" 이 나머지를 고정한 채 배선기를 돌린다.
 *
 *    배선 그리기 (수동): 넷의 배선을 지우고(rip-up) 노드 검사와 같은 차례(_replay.mjs)를 마우스·키로 따라 그리면 넷이 한
 *    덩이로 이어지고 DRC/LVS 가 배선기 결과보다 늘지 않는다. Esc 로 버리기, Delete 로 조각 지우기, Z 로 되돌리기.
 *
 *    보조 그리기: 배선 보기에는 편집 전에도 도구 줄이 보이고 "배선" 을 누르면 편집에 들어간다. 넷을 지우고 핀을 눌러 옆으로,
 *    꺾어서, 다시 꺾어서 끌면 배선이 누른 자리에서 그 궤적대로 따라오고 (굽이가 쌓인다), 놓으면 들어간다. 플라이라인의 한 끝
 *    핀을 눌러 다른 끝까지 끌면 미리보기가 그 핀에 붙고, 놓으면 이어진다 (DRC/LVS 가 늘지 않는다). 플라이라인을 클릭해도,
 *    도구 줄의 "열린 곳 모두 잇기" 로도 이어진다.
 *
 *  실행:  node symplace/web/placer/test/edit-page.mjs [예제=current_mirror_ota] [시작점=48]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve, launchChromium } from "./_browser.mjs";
import { replay } from "./_replay.mjs";
import { buildGraph, worldShapes } from "../../../../src/edit/wires.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..", "..");
const [example = "current_mirror_ota", batch = "48"] = process.argv.slice(2);

const { srv, port } = await serve(ROOT);
const browser = await launchChromium({ gpu: false });
let fails = 0;
const bad = (m) => { fails++; console.log("  실패: " + m); };
const ok = (c, m) => { if (!c) bad(m); };
try {
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
  page.on("pageerror", (e) => bad("pageerror " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/404|ERR_/.test(m.text())) console.log("  console.error:", m.text()); });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => document.querySelector("#ex option") && globalThis.__page?.editor, null, { timeout: 30000 });
  await page.selectOption("#ex", example);
  await page.waitForTimeout(500);
  await page.click("#adv > summary");
  await page.selectOption("#batch", batch);
  const runPlace = async () => {
    await page.click("#run");
    await page.waitForFunction(() => /완료|실패/.test(document.querySelector("#status").textContent), null, { timeout: 600000 });
    return (await page.textContent("#status")).trim();
  };
  const t0 = Date.now();
  console.log(`배치: ${await runPlace()}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  const before = await page.evaluate(() => JSON.stringify(globalThis.__page.ours.rects));

  // --- 편집 토글 ---
  ok(!(await page.$eval("#modeSeg", (e) => e.hidden)), "편집 토글이 안 보인다");
  await page.click('#modeSeg button[data-mode="edit"]');
  await page.waitForTimeout(200);
  ok(!(await page.$eval("#editCard", (e) => e.hidden)), "편집 카드가 안 뜬다");
  ok(await page.evaluate(() => globalThis.__page.editor.active), "편집기가 켜지지 않았다");
  const kit = await page.evaluate(() => globalThis.__page.ours.edit ? Object.keys(globalThis.__page.ours.edit.subTemplates).length : null);
  ok(kit !== null, "done 에 편집 키트가 없다");
  console.log(`  편집 켬 · 키트 템플릿 ${kit} 개`);
  // 편집 카드가 결과 카드 자리에 오고 나머지 카드는 접힌다. 보기로 돌아가면 되돌아온다.
  const layout = () => page.evaluate(() => {
    const ec = document.querySelector("#editCard"), rc = document.querySelector("#resultCard");
    const folds = [...document.querySelectorAll(".card.fold")];
    return { editShown: !ec.hidden, editFirst: ec.nextElementSibling === rc, folded: folds.filter((c) => c.classList.contains("collapsed")).length, cards: folds.length };
  });
  const l1 = await layout();
  ok(l1.editShown && l1.editFirst, "편집 카드가 결과 카드 자리에 안 왔다");
  ok(l1.folded === l1.cards, `다른 카드가 다 안 접혔다 (${l1.folded}/${l1.cards})`);
  await page.click("#resultCard > h2");
  ok((await layout()).folded === l1.cards - 1, "제목을 클릭해도 카드가 안 펴진다");
  await page.click('#modeSeg button[data-mode="view"]');
  const l2 = await layout();
  ok(!l2.editShown && !l2.editFirst && l2.folded === l1.cards, `보기로 돌아가도 카드가 안 돌아온다 (편집 ${l2.editShown}, 접힘 ${l2.folded}/${l1.cards})`);
  await page.click("#resultCard > h2");                       // 보기에서 결과를 열어 두고
  await page.click('#modeSeg button[data-mode="edit"]');       // 편집에 들어가면 다 접히고
  await page.waitForTimeout(100);
  ok((await layout()).folded === l1.cards, "다시 편집을 켜면 다시 접혀야 한다");
  await page.click('#modeSeg button[data-mode="view"]');       // 나오면 열어 둔 것이 돌아온다
  ok((await layout()).folded === l1.cards - 1, "보기로 돌아가면 열어 둔 카드가 열려 있어야 한다");
  await page.click('#modeSeg button[data-mode="edit"]');
  await page.waitForTimeout(100);
  // 캔버스는 카드 안을 좌우로 다 채우고 (카드는 왼쪽 열 그대로 — 편집 카드가 옆에 보인다), 그림도 캔버스 좌우를 채운다
  const fill = await page.evaluate(() => {
    const cols = document.querySelector("#cols"), cv = document.querySelector("#cv"), m = globalThis.__page.lastMap?.m, bb = globalThis.__page.ours?.bbox;
    const cvW = cv.getBoundingClientRect().width;
    const ec = document.querySelector("#editCard").getBoundingClientRect(), cc = cv.parentElement.getBoundingClientRect();
    return { cvW, cardW: cv.parentElement.clientWidth, colsW: cols.clientWidth, drawn: m && bb ? (m.X(bb[2]) - m.X(bb[0])) / cvW : 0, beside: ec.left > cc.right && ec.top < cc.bottom };
  });
  ok(fill.cvW >= fill.cardW - 2 && fill.cardW < fill.colsW - 100, `캔버스가 카드 안을 다 안 채운다 (${fill.cvW}/${fill.cardW}/${fill.colsW})`);
  ok(fill.drawn >= 0.85, `그림이 캔버스 좌우를 다 안 채운다 (${(fill.drawn * 100).toFixed(0)} %)`);
  ok(fill.beside, "편집 카드가 캔버스 옆에 안 보인다");
  console.log(`  카드: 기본 접힘 ${l2.folded}/${l1.cards}, 편집 카드가 캔버스 옆 결과 자리에, 보기로 가면 되돌아옴 · 캔버스 ${fill.cvW}/${fill.cardW} px, 그림 ${(fill.drawn * 100).toFixed(0)} %`);

  // --- 끌기: 자유 블록(대칭 밖)이 있으면 그것, 없으면 아무 블록 ---
  const pick = await page.evaluate(() => {
    const ed = globalThis.__page.editor, m = ed.state.pl.model;
    const free = m.P.names.find((nm) => !m.roles.get(nm)) ?? m.P.names[0];
    const px = ed.probe.rectPx(free);
    return { name: free, free: !m.roles.get(free), px };
  });
  const box = await page.$eval("#cv", (c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top }; });
  const cx = box.x + pick.px.cx, cy = box.y + pick.px.cy;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 40, cy - 30, { steps: 6 });
  await page.mouse.move(cx + 80, cy - 60, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const afterDrag = await page.evaluate((nm) => {
    const ed = globalThis.__page.editor, pl = ed.state.pl;
    const r = pl.live.rects.find((q) => q.name === nm), o = globalThis.__page.ours.rects.find((q) => q.name === nm);
    return { dirty: pl.dirty, sel: [...pl.sel], dx: r.x - o.x, dy: r.y - o.y, S: ed.probe.map().m.S, edits: pl.edits,
             overlap: pl.live.overlap.pairs, moved: pl.live.rects.filter((q) => { const p = globalThis.__page.ours.rects.find((z) => z.name === q.name); return Math.abs(p.x - q.x) + Math.abs(p.y - q.y) > 1e-6; }).map((q) => q.name) };
  }, pick.name);
  console.log(`  끌기 ${pick.name}${pick.free ? " (자유)" : ""}: (${afterDrag.dx.toFixed(0)}, ${afterDrag.dy.toFixed(0)}) · 움직인 블록 ${afterDrag.moved.join(" ")} · 겹침 ${afterDrag.overlap} 쌍 · 정리 전 ${afterDrag.dirty}`);
  ok(afterDrag.dirty && afterDrag.sel.includes(pick.name), "끌기가 안 잡혔다");
  ok(Math.abs(afterDrag.dx - 80 / afterDrag.S) < 1 && Math.abs(afterDrag.dy - 60 / afterDrag.S) < 1, `끈 만큼 안 움직였다 (${afterDrag.dx}, ${afterDrag.dy}, S ${afterDrag.S})`);
  if (pick.free) ok(afterDrag.moved.length === 1, "자유 블록을 끌었는데 다른 블록도 움직였다: " + afterDrag.moved.join(" "));
  ok(JSON.stringify(await page.evaluate(() => globalThis.__page.ours.rects)) === before, "정리 전인데 배치(ours)가 바뀌었다");

  // --- 정리 (Enter) ---
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const settled = await page.evaluate(() => {
    const o = globalThis.__page.ours, pl = globalThis.__page.editor.state.pl;
    let blockArea = 0; for (const r of o.rects) blockArea += r.w * r.h;
    return { edited: o.edited, overlap: o.overlap / blockArea, resid: o.resid, offgrid: o.offgrid, orderBad: o.orderBad, dirty: pl.dirty,
             hist: pl.hist.length, area: o.area / o.base.area, hpwl: o.hpwl / o.base.hpwl, metrics: document.querySelector("#metrics").textContent };
  });
  console.log(`  정리: 편집 ${settled.edited} 회 · 겹침 ${settled.overlap.toExponential(1)} · 잔차 ${settled.resid.toExponential(1)} · 격자밖 ${settled.offgrid} · Order 위반 ${settled.orderBad} · 면적 ${settled.area.toFixed(3)}x · HPWL ${settled.hpwl.toFixed(3)}x`);
  ok(settled.edited === 1 && !settled.dirty, "정리가 안 됐다");
  ok(settled.overlap < 1e-9 && settled.resid < 1e-9 && settled.offgrid === 0 && settled.orderBad === 0, "정리 결과가 규칙을 어긴다");
  ok(/편집/.test(settled.metrics), "결과 표에 편집 줄이 없다");
  ok(await page.$eval("#dlBar", (e) => /-edited\.place\.json/.test([...e.querySelectorAll("a")].map((a) => a.download).join(" "))), "내려받기 이름에 -edited 가 없다");

  // --- 반전 (F) 과 되돌리기 (Z) ---
  const flipInfo = await page.evaluate((nm) => {
    const ed = globalThis.__page.editor, pl = ed.state.pl, i = pl.model.idx.get(nm);
    const g = pl.model.plan.find((p) => p.members.includes(pl.model.P.keep[i]));
    return { xFree: g?.xFree, sx: pl.sx[i] };
  }, pick.name);
  await page.keyboard.press("f");
  await page.waitForTimeout(200);
  const afterFlip = await page.evaluate((nm) => { const pl = globalThis.__page.editor.state.pl; return { sx: pl.sx[pl.model.idx.get(nm)], edited: globalThis.__page.ours.edited }; }, pick.name);
  if (flipInfo.xFree) ok(afterFlip.sx === -flipInfo.sx && afterFlip.edited === 2, `x 반전이 안 됐다 (${flipInfo.sx} -> ${afterFlip.sx}, 편집 ${afterFlip.edited})`);
  else ok(afterFlip.sx === flipInfo.sx, "제약에 묶인 반전이 뒤집혔다");
  console.log(`  반전 F: ${flipInfo.xFree ? `${flipInfo.sx} -> ${afterFlip.sx}` : "묶여 있어 그대로"}`);
  await page.keyboard.press("z");
  await page.waitForTimeout(200);
  const afterUndo = await page.evaluate(() => ({ edited: globalThis.__page.ours.edited ?? 0, hist: globalThis.__page.editor.state.pl.hist.length, fut: globalThis.__page.editor.state.pl.fut.length }));
  ok(afterUndo.fut === 1, "되돌리기가 이력을 안 남겼다");
  console.log(`  되돌리기: 편집 ${afterUndo.edited} 회, 이력 ${afterUndo.hist}, 다시 실행 ${afterUndo.fut}`);

  // --- variant 고정: 후보가 둘 이상인 블록을 골라 다른 variant 로 ---
  const vpick = await page.evaluate(() => {
    const ed = globalThis.__page.editor, m = ed.state.pl.model;
    for (const g of m.groups) if (g.choices.length > 1) {
      const nm = m.design.instances[g.members[0]].name;
      const cur = m.P.concrete[m.idx.get(nm)];
      return { name: nm, other: g.choices.find((c) => c !== cur), cur, px: ed.probe.rectPx(nm) };
    }
    return null;
  });
  if (vpick) {
    await page.mouse.click(box.x + vpick.px.cx, box.y + vpick.px.cy);
    await page.waitForTimeout(150);
    await page.selectOption('#editBody select[data-act="variant"]', vpick.other);
    await page.waitForTimeout(200);
    const v = await page.evaluate((nm) => { const pl = globalThis.__page.editor.state.pl; return { c: pl.model.P.concrete[pl.model.idx.get(nm)], pinned: [...pl.pinned], dirty: pl.dirty }; }, vpick.name);
    ok(v.c === vpick.other, `variant 가 안 바뀌었다 (${v.c})`);
    ok(v.pinned.some(([n, c]) => n === vpick.name && c === vpick.other), "variant 가 고정되지 않았다");
    console.log(`  variant ${vpick.name}: ${vpick.cur} -> ${v.c} (고정 ${v.pinned.length} 개) · 정리 전 ${v.dirty}`);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    ok(!(await page.evaluate(() => globalThis.__page.editor.state.pl.dirty)), "variant 뒤 정리가 안 됐다");
    // 다음 Placement 실행이 고정 variant 를 쓴다
    const t1 = Date.now();
    console.log(`  고정 variant 로 다시 배치: ${await runPlace()}  (${((Date.now() - t1) / 1000).toFixed(0)}s)`);
    const again = await page.evaluate((nm) => { const o = globalThis.__page.ours; return { c: o.rects.find((r) => r.name === nm)?.concrete, fixed: o.fixedVariants, edited: o.edited ?? 0, pinned: globalThis.__page.editor.state.pl.pinned.size }; }, vpick.name);
    ok(again.c === vpick.other, `다시 배치했는데 고정 variant 를 안 썼다 (${again.c})`);
    ok(again.fixed && again.fixed[vpick.name] === vpick.other, "done 에 고정 variant 가 없다");
    ok(again.edited === 0 && again.pinned > 0, "새 배치는 편집 0 회여야 하고 고정은 남아야 한다");
  } else console.log("  variant 후보가 하나뿐인 설계 — variant 고정은 건너뛴다");

  // --- 위상 유지 최적화 (워커 retry) ---
  await page.click('#editBody button[data-act="retry"]');
  await page.waitForFunction(() => /variant 다시|실패/.test(document.querySelector("#status").textContent), null, { timeout: 120000 });
  const rs = (await page.textContent("#status")).trim();
  console.log(`  위상 유지 최적화: ${rs}`);
  ok(/variant 다시 —/.test(rs), "variant 다시가 실패했다");
  ok(await page.$eval("#editBody", (e) => !!e.querySelector("table.rank")), "순위 표가 없다");

  // --- 편집 끄기: 편집이 없으면 그대로 ---
  await page.click('#modeSeg button[data-mode="view"]');
  await page.waitForTimeout(100);
  ok(await page.$eval("#editCard", (e) => e.hidden), "편집 카드가 안 닫힌다");

  // ---------------------------------------------------------------- 배선 편집
  await page.click("#routeRun");
  await page.waitForFunction(() => /Routing 완료|Routing 실패/.test(document.querySelector("#status").textContent), null, { timeout: 180000 });
  const rs0 = (await page.textContent("#status")).trim();
  console.log(`배선: ${rs0}`);
  ok(/Routing 완료/.test(rs0), "배선이 실패했다");
  ok(await page.evaluate(() => globalThis.__page.what === "route"), "배선 보기로 안 옮겨졌다");
  // 도구 줄 — 배선 보기면 편집 전에도 보인다
  const tb0 = await page.$eval("#editTools", (e) => ({ hidden: e.hidden, text: e.textContent }));
  console.log(`  도구 줄 (보기): ${tb0.hidden ? "안 보임" : tb0.text.replace(/\s+/g, " ").trim()}`);
  ok(!tb0.hidden && /배선/.test(tb0.text), "배선 보기에서 도구 줄이 안 보인다");
  await page.click('#modeSeg button[data-mode="edit"]');
  await page.waitForTimeout(200);
  ok(await page.evaluate(() => globalThis.__page.editor.active), "배선 보기에서 편집기가 안 켜졌다");
  const segs = await page.evaluate(() => globalThis.__page.editor.probe.segmentsPx());
  const mov = segs.filter((q) => !q.locked && q.tracks.length > 1);
  console.log(`  조각 ${segs.length} 개, 옮길 수 있는 것 ${mov.length} 개`);
  const box2 = await page.$eval("#cv", (c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top }; });
  if (mov.length) {
    const sg = mov[0];
    await page.mouse.click(box2.x + sg.cx, box2.y + sg.cy);
    await page.waitForTimeout(150);
    ok(await page.evaluate((n) => globalThis.__page.editor.state.rt.net === n, sg.net), `넷 ${sg.net} 이 안 골라졌다`);
    const i = sg.tracks.indexOf(sg.t), t2 = sg.tracks[i + 1] ?? sg.tracks[i - 1];
    const dpx = ((t2 - sg.t) / 2) * sg.S;                 // PnRDB -> PDK -> px
    await page.mouse.move(box2.x + sg.cx, box2.y + sg.cy);
    await page.mouse.down();
    for (const f of [0.5, 1]) {
      if (sg.dir === "v") await page.mouse.move(box2.x + sg.cx + dpx * f, box2.y + sg.cy, { steps: 4 });
      else await page.mouse.move(box2.x + sg.cx, box2.y + sg.cy - dpx * f, { steps: 4 });
    }
    await page.mouse.up();
    await page.waitForFunction(() => !globalThis.__page.editor.state.rt.busy && globalThis.__page.editor.state.rt.hist.length > 0, null, { timeout: 60000 });
    const has = (t) => page.evaluate(([n, layer, t]) => globalThis.__page.editor.state.rt.graphs.get(n).segs.some((q) => q.layer === layer && q.t === t), [sg.net, sg.layer, t]);
    const after = await page.evaluate(() => { const rt = globalThis.__page.editor.state.rt; return { frozen: [...rt.frozen], hist: rt.hist.length, status: document.querySelector("#status").textContent.trim() }; });
    console.log(`  조각 ${sg.net} ${sg.layer} ${sg.t / 2} -> ${t2 / 2} · 고정 ${after.frozen.join(" ")} · ${after.status}`);
    ok(await has(t2), "조각이 목표 트랙으로 안 갔다");
    ok(after.frozen.includes(sg.net), "편집한 넷이 고정되지 않았다");
    ok(/재검사 — DRC\/LVS \d+ 건/.test(after.status), "재검사 상태가 없다");
    ok(await page.$eval("#dlBar", (e) => /-wires\.gds/.test([...e.querySelectorAll("a")].map((a) => a.download).join(" "))), "내려받기 이름에 -wires 가 없다");
    await page.keyboard.press("z");
    await page.waitForFunction(() => !globalThis.__page.editor.state.rt.busy && globalThis.__page.editor.state.rt.fut.length > 0, null, { timeout: 60000 });
    const undone = await page.evaluate(() => [...globalThis.__page.editor.state.rt.frozen]);
    ok(await has(sg.t), "되돌렸는데 조각이 제자리가 아니다");
    ok(!undone.includes(sg.net), "되돌렸는데 고정이 남았다");
    await page.keyboard.press("y");
    await page.waitForFunction(() => !globalThis.__page.editor.state.rt.busy && globalThis.__page.editor.state.rt.fut.length === 0, null, { timeout: 60000 });
    ok(await has(t2), "다시 실행이 안 됐다");
    await page.click('#editBody button[data-act="rnet"]');
    await page.waitForFunction(() => !globalThis.__page.editor.state.rt.busy && /다시 배선 —|실패/.test(document.querySelector("#status").textContent), null, { timeout: 180000 });
    const rr = await page.evaluate(() => ({ status: document.querySelector("#status").textContent.trim(), hist: globalThis.__page.editor.state.rt.hist.length }));
    console.log(`  이 넷만 다시 배선: ${rr.status} · 이력 ${rr.hist}`);
    ok(/다시 배선 —/.test(rr.status), "재배선이 실패했다");
    ok(rr.hist === 2, `이력이 ${rr.hist} 이다`);
    // --- 정돈 (C: 이 넷, Shift+C: 전부) — 위상 그대로, 오류가 늘지 않는다 ---
    const keys = (n) => page.evaluate((n) => { const rt = globalThis.__page.editor.state.rt; const g = rt.graphs.get(n); return { key: g.segs.map((q) => q.layer + q.dir + q.lo + ":" + q.hi).length + "/" + g.vias.length, nerr: rt.nerr, hist: rt.hist.length }; }, n);
    const k0 = await keys(sg.net);
    await page.keyboard.press("c");
    await page.waitForFunction(() => !globalThis.__page.editor.state.rt.busy && /정돈/.test(document.querySelector("#status").textContent), null, { timeout: 60000 });
    const c1 = await page.evaluate(() => document.querySelector("#status").textContent.trim());
    const k1 = await keys(sg.net);
    console.log(`  정돈: ${c1} · 오류 ${k0.nerr} -> ${k1.nerr} · 이력 ${k0.hist} -> ${k1.hist}`);
    ok(k1.key === k0.key, "정돈이 조각·비아 수를 바꿨다");
    ok(k1.nerr <= k0.nerr, `정돈 뒤 오류가 늘었다 ${k0.nerr} -> ${k1.nerr}`);
    await page.keyboard.press("Shift+C");
    await page.waitForFunction(() => !globalThis.__page.editor.state.rt.busy && /정돈/.test(document.querySelector("#status").textContent), null, { timeout: 60000 });
    const c2 = await page.evaluate(() => ({ status: document.querySelector("#status").textContent.trim(), nerr: globalThis.__page.editor.state.rt.nerr }));
    console.log(`  정돈 (전부): ${c2.status} · 오류 ${c2.nerr}`);
    ok(c2.nerr <= k1.nerr, `전부 정돈 뒤 오류가 늘었다 ${k1.nerr} -> ${c2.nerr}`);
  } else console.log("  옮길 수 있는 조각이 없다 — 옮기기는 건너뛴다");

  // ---------------------------------------------------------------- 배선 그리기
  // Routing 을 다시 실행해 배선기 결과에서 시작하고, 비아가 가장 많은 넷의 배선을 지운 뒤(rip-up) 노드 검사(edit-draw.mjs)와 같은 차례(_replay.mjs)를
  // 진짜 마우스·키로 따라 그린다 — 층은 숫자 키, 꺾는 쪽은 T, 끝은 이 넷 도형 클릭 또는 더블클릭. 다 그리면 넷이 한 덩이로
  // 이어지고 DRC/LVS 가 배선기 결과보다 늘지 않는다. 그리다 Esc 로 버리기, 조각 지우기(Delete), 되돌리기도 본다.
  const rtNow = (f) => page.evaluate(f);
  const idle = () => page.waitForFunction(() => !globalThis.__page.editor.state.rt.busy, null, { timeout: 60000 });
  await page.click("#routeRun");
  await page.waitForFunction(() => /Routing 완료|Routing 실패/.test(document.querySelector("#status").textContent), null, { timeout: 180000 });
  await page.click('#modeSeg button[data-mode="edit"]');
  await page.waitForTimeout(150);
  const model = await rtNow(() => JSON.parse(JSON.stringify(globalThis.__page.editor.state.rt.model)));
  const graphs = new Map(model.nets.map((n) => [n.name, buildGraph(n)]));
  const target = model.nets.filter((n) => n.path_metal.length).sort((a, b) => graphs.get(b.name).vias.length - graphs.get(a.name).vias.length)[0];
  if (target) {
    const plan = replay(target, graphs.get(target.name), { world: worldShapes(model, graphs, target.name), area: model.area });
    const base = await rtNow(() => globalThis.__page.editor.state.rt.baseErrors);
    // 캔버스의 my 자리가 화면 가운데 오게 굴리고 캔버스 상자를 다시 잰다
    const at = async (x, y) => {
      const p = await page.evaluate(([x, y]) => globalThis.__page.editor.probe.px(x, y), [x, y]);
      await page.evaluate((my) => { const r = document.querySelector("#cv").getBoundingClientRect(); window.scrollTo(0, Math.max(0, r.top + window.scrollY + my - window.innerHeight / 2)); }, p.y);
      const b = await page.$eval("#cv", (c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top }; });
      return { x: b.x + p.x, y: b.y + p.y };
    };
    // 조각을 클릭해 넷을 고르고 지운다
    const pick = (await page.evaluate((n) => globalThis.__page.editor.probe.segmentsPx(n), target.name)).sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h))[0];
    const box3 = await page.$eval("#cv", (c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top }; });
    await page.mouse.click(box3.x + pick.cx, box3.y + pick.cy);
    await page.waitForTimeout(100);
    ok(await page.evaluate((n) => globalThis.__page.editor.state.rt.net === n, target.name), `${target.name} 이 안 골라졌다`);
    await page.click('#editBody button[data-act="rrip"]');
    await idle();
    const ripped = await rtNow(() => { const rt = globalThis.__page.editor.state.rt; return { nerr: rt.nerr, card: document.querySelector("#editBody").textContent }; });
    console.log(`  그리기: ${target.name} 배선 지우기 — DRC/LVS ${ripped.nerr} (기준 ${base}) · 차례 ${plan.steps.length} (비아만 ${plan.viaOnly})`);
    ok(ripped.nerr > base && /열린 곳/.test(ripped.card), "배선을 지웠는데 열린 곳이 안 보인다");
    // Esc 로 버리기 — 아무것도 안 남는다. 이 차례는 꺾을 자리마다 클릭하는 수동이다 (A 로 보조 <-> 수동)
    await page.keyboard.press("w");
    await page.keyboard.press("a");
    ok(await rtNow(() => globalThis.__page.editor.state.rt.tool === "wire" && !globalThis.__page.editor.state.rt.assist), "A 로 수동이 안 됐다");
    const s0 = plan.steps[0], hist0 = await rtNow(() => globalThis.__page.editor.state.rt.hist.length);
    let p = await at(s0.start.x, s0.start.y);
    await page.mouse.click(p.x, p.y);
    p = await at(s0.end.x, s0.end.y);
    await page.mouse.move(p.x, p.y, { steps: 4 });
    const drawing = await rtNow(() => !!globalThis.__page.editor.state.rt.draw);
    await page.keyboard.press("Escape");
    const dropped = await rtNow(() => ({ draw: !!globalThis.__page.editor.state.rt.draw, hist: globalThis.__page.editor.state.rt.hist.length, tool: globalThis.__page.editor.state.rt.tool }));
    ok(drawing && !dropped.draw && dropped.hist === hist0 && dropped.tool === "wire", "Esc 로 그리던 것을 버리지 못했다");
    // 차례대로 그린다
    const keyOf = await page.evaluate(async () => (await import("./src/edit/draw.mjs")).DRAW_LAYERS);
    let dbl = 0, snapped = 0;
    for (const st of plan.steps) {
      await page.keyboard.press(String(keyOf.indexOf(st.layer) + 1));
      if ((await rtNow(() => globalThis.__page.editor.state.rt.turn)) !== st.turn) await page.keyboard.press("t");
      const h = await rtNow(() => globalThis.__page.editor.state.rt.hist.length);
      p = await at(st.start.x, st.start.y);
      await page.mouse.move(p.x, p.y);
      await page.mouse.click(p.x, p.y);
      p = await at(st.end.x, st.end.y);
      await page.mouse.move(p.x, p.y, { steps: 3 });
      const pv = await rtNow(() => { const q = globalThis.__page.editor.state.rt.preview; return q ? { ok: q.ok, target: !!q.target, why: q.why } : null; });
      if (pv?.target) { snapped++; await page.mouse.click(p.x, p.y); }
      else { dbl++; await page.mouse.dblclick(p.x, p.y); }
      await page.waitForFunction((h) => { const rt = globalThis.__page.editor.state.rt; return !rt.busy && !rt.draw && rt.hist.length > h; }, h, { timeout: 60000 })
        .catch(() => bad(`차례 ${JSON.stringify(st)} 가 안 끝났다 (${pv?.why ?? ""})`));
    }
    const drawn = await page.evaluate(async (n) => {
      const rt = globalThis.__page.editor.state.rt, D = await import("./src/edit/draw.mjs");
      const net = rt.model.nets.find((q) => q.name === n), g = rt.graphs.get(n);
      return { nerr: rt.nerr, comps: D.netComponents(net, g).comps, segs: g.segs.length, vias: g.vias.length, frozen: rt.frozen.has(n), status: document.querySelector("#status").textContent.trim() };
    }, target.name);
    console.log(`  그리기: 클릭으로 다시 그림 (붙어서 끝 ${snapped}, 더블클릭 ${dbl}) — 조각 ${drawn.segs} 비아 ${drawn.vias} · 덩이 ${drawn.comps} · DRC/LVS ${drawn.nerr} (기준 ${base}) · ${drawn.status}`);
    ok(drawn.comps === 1, `다시 그린 ${target.name} 이 ${drawn.comps} 덩이다`);
    ok(drawn.nerr <= base, `다시 그린 뒤 오류가 늘었다 ${base} -> ${drawn.nerr}`);
    ok(drawn.frozen, "그린 넷이 고정되지 않았다");
    ok(/그리기 \(토막/.test(drawn.status), "그리기 상태 줄이 없다");
    // 조각 지우기 (고르기 도구에서 조각을 클릭하고 Delete) 와 되돌리기
    await page.keyboard.press("Escape");
    const sg = (await page.evaluate((n) => globalThis.__page.editor.probe.segmentsPx(n), target.name)).sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h))[0];
    const seg0 = await page.evaluate(([n, id]) => { const s = globalThis.__page.editor.state.rt.graphs.get(n).segs[id]; return { x: s.dir === "v" ? s.t : (s.lo + s.hi) / 2, y: s.dir === "v" ? (s.lo + s.hi) / 2 : s.t }; }, [target.name, sg.id]);
    p = await at(seg0.x, seg0.y);
    await page.mouse.click(p.x, p.y);                                       // 넷 (이미 골라져 있으면 조각)
    if (!(await rtNow(() => !!globalThis.__page.editor.state.rt.seg))) await page.mouse.click(p.x, p.y);
    const before = await rtNow(() => ({ segs: globalThis.__page.editor.state.rt.graphs.get(globalThis.__page.editor.state.rt.net).segs.length, hist: globalThis.__page.editor.state.rt.hist.length, picked: !!globalThis.__page.editor.state.rt.seg }));
    await page.keyboard.press("Delete");
    await page.waitForFunction((h) => { const rt = globalThis.__page.editor.state.rt; return !rt.busy && rt.hist.length > h; }, before.hist, { timeout: 60000 }).catch(() => bad("Delete 가 안 됐다"));
    const del = await rtNow(() => { const rt = globalThis.__page.editor.state.rt; return { segs: rt.graphs.get(rt.net).segs.length, nerr: rt.nerr }; });
    console.log(`  지우기: 조각 ${before.segs} -> ${del.segs} · DRC/LVS ${del.nerr}`);
    ok(before.picked && del.segs < before.segs, "Delete 로 조각이 안 지워졌다");
    await page.keyboard.press("z");
    await idle();
    const undone = await rtNow(() => { const rt = globalThis.__page.editor.state.rt; return { segs: rt.graphs.get(rt.net).segs.length, nerr: rt.nerr }; });
    ok(undone.segs === before.segs && undone.nerr === drawn.nerr, `되돌렸는데 조각 ${undone.segs} / 오류 ${undone.nerr}`);

    // ---------------------------------------------------------------- 보조 그리기
    // 도구 줄의 "배선" 으로 들어가 보조(기본)로. 넷을 지우고 플라이라인의 한 끝 핀을 눌러 다른 끝까지 끌면 미리보기가 그
    // 핀에 붙고(클릭 없이), 놓으면 이어진다. 넷이 한 덩이가 될 때까지 되풀이한다. 그 다음 플라이라인 클릭, 모두 잇기.
    const rip = async (n) => {
      await page.keyboard.press("Escape"); await page.keyboard.press("Escape");          // 고르기 도구로
      await page.evaluate((n) => { const rt = globalThis.__page.editor.state.rt; rt.net = n; rt.seg = null; }, n);
      await page.click('#editTools button[data-tool="select"]');                          // 카드를 다시 그린다
      const h = await rtNow(() => globalThis.__page.editor.state.rt.hist.length);
      await page.click('#editBody button[data-act="rrip"]');
      await page.waitForFunction((h) => { const rt = globalThis.__page.editor.state.rt; return !rt.busy && rt.hist.length > h; }, h, { timeout: 60000 });
    };
    const flyOf = (n) => page.evaluate(async (n) => {
      const rt = globalThis.__page.editor.state.rt, D = await import("./src/edit/draw.mjs");
      const c = D.netComponents(rt.model.nets.find((q) => q.name === n), rt.graphs.get(n));
      return { comps: c.comps, lines: c.lines.map((l) => ({ a: l.a, b: l.b })), nerr: rt.nerr };
    }, n);
    // 두 점이 다 보이게 그 가운데를 화면 가운데로 굴리고 둘의 화면 자리를
    const at2 = async (a, b) => {
      const pa = await page.evaluate(([x, y]) => globalThis.__page.editor.probe.px(x, y), a), pb = await page.evaluate(([x, y]) => globalThis.__page.editor.probe.px(x, y), b);
      await page.evaluate((my) => { const r = document.querySelector("#cv").getBoundingClientRect(); window.scrollTo(0, Math.max(0, r.top + window.scrollY + my - window.innerHeight / 2)); }, (pa.y + pb.y) / 2);
      const bx = await page.$eval("#cv", (c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top }; });
      return [{ x: bx.x + pa.x, y: bx.y + pa.y }, { x: bx.x + pb.x, y: bx.y + pb.y }];
    };
    const routedNames = model.nets.filter((n) => n.path_metal.length).map((n) => n.name);
    const aNet = model.nets.filter((n) => n.path_metal.length).sort((a, b) => b.pins.length - a.pins.length || graphs.get(b.name).vias.length - graphs.get(a.name).vias.length)[0].name;
    await rip(aNet);
    await page.click('#editTools button[data-tool="wire"]');
    if (!(await rtNow(() => globalThis.__page.editor.state.rt.assist))) await page.click('#editTools button[data-act="assist"][data-on="1"]');
    ok(await rtNow(() => globalThis.__page.editor.state.rt.tool === "wire" && globalThis.__page.editor.state.rt.assist), "도구 줄로 보조 그리기가 안 켜졌다");
    let fly = await flyOf(aNet);
    console.log(`  보조: ${aNet} 배선 지우기 — 덩이 ${fly.comps} · DRC/LVS ${fly.nerr} (기준 ${base})`);
    // 따라 긋기 — 핀을 누른 자리에서 시작해 끄는 궤적대로: 옆으로, 위(아래)로, 다시 옆으로 끌면 첫 토막은 가로, 꺾으면 세로,
    // 다시 꺾은 자리는 고정되어 굽이가 쌓인다 (곧장 갈 수 있을 때). 놓으면 들어가고 오류가 늘지 않는다. Z 로 무른다
    {
      const pinInfo = await page.evaluate(async (n) => {
        const rt = globalThis.__page.editor.state.rt, D = await import("./src/edit/draw.mjs");
        const s = D.netShapes(rt.model.nets.find((q) => q.name === n), rt.graphs.get(n)).find((q) => q.kind === "pin");
        return { rect: s.rect, layer: s.layer };
      }, aNet);
      const pc = [(pinInfo.rect[0] + pinInfo.rect[2]) / 2, (pinInfo.rect[1] + pinInfo.rect[3]) / 2];
      const [p0] = await at2(pc, pc);
      const cvb = await page.$eval("#cv", (c) => { const r = c.getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; });
      const sx = p0.x < cvb.cx ? 1 : -1, sy = p0.y < cvb.cy ? 1 : -1;            // 캔버스 가운데 쪽으로
      const h0 = await rtNow(() => globalThis.__page.editor.state.rt.hist.length), n0 = fly.nerr;
      await page.mouse.move(p0.x, p0.y);
      const top0 = await page.$eval("#cv", (c) => c.getBoundingClientRect().top);
      await page.mouse.down();
      const anchorIn = await page.evaluate(async (r) => {
        const d = globalThis.__page.editor.state.rt.draw, A = await import("./src/edit/assist.mjs");
        if (!d?.assist) return null;
        const p = A.nodePoint(d.assist.G, d.assist.anchor);
        return p.x >= r[0] - 1e-6 && p.x <= r[2] + 1e-6 && p.y >= r[1] - 1e-6 && p.y <= r[3] + 1e-6;
      }, pinInfo.rect);
      // 그은 길의 움직임 차례 (점 줄에서 — 가로 h, 세로 v, 같은 쪽이 이어지면 하나로)
      const look = () => rtNow(() => { const rt = globalThis.__page.editor.state.rt, q = rt.preview, d = rt.draw;
        const pts = [...(d?.nodes ?? []), ...(q?.nodes ?? [])];
        let legs = "";
        for (let k = 1; k < pts.length; k++) {
          if (pts[k].x === pts[k - 1].x && pts[k].y === pts[k - 1].y) continue;
          const dir = pts[k].y === pts[k - 1].y ? "h" : "v";
          if (!legs.endsWith(dir)) legs += dir;
        }
        return { ok: !!q?.ok, detour: !!q?.detour, flipped: !!q?.flipped, legs, corners: d ? d.clicks.length - 1 : -1,
                 top: document.querySelector("#cv").getBoundingClientRect().top }; });
      const seen = [];
      for (const [dx, dy] of [[45, 0], [45, 45], [95, 45]]) { await page.mouse.move(p0.x + sx * dx, p0.y + sy * dy, { steps: 8 }); seen.push(await look()); }
      await page.mouse.up();
      await page.waitForFunction((h) => { const rt = globalThis.__page.editor.state.rt; return !rt.busy && !rt.draw && rt.hist.length > h; }, h0, { timeout: 60000 })
        .catch(() => bad("따라 긋기 — 놓았는데 안 들어갔다"));
      const after = await flyOf(aNet);
      console.log(`  보조: 따라 긋기 (닻이 누른 핀 위 ${anchorIn}) — 옆 ${seen[0].legs || "-"}${seen[0].detour ? " (돌아감)" : ""}, 꺾어 ${seen[1].legs || "-"}${seen[1].detour ? " (돌아감)" : ""}, ` +
                  `다시 꺾어 ${seen[2].legs || "-"} 고정한 굽이 ${seen[2].corners} · 놓으니 DRC/LVS ${n0} -> ${after.nerr}`);
      ok(anchorIn === true, "따라 긋기 — 누른 핀에서 시작하지 않았다");
      // 그리는 동안 캔버스가 화면에서 움직이면 (카드가 줄어 스크롤이 당겨지면) 같은 마우스 자리가 다른 점이 된다
      ok(seen.every((q) => Math.abs(q.top - top0) < 0.5), `따라 긋기 — 그리는 동안 캔버스가 움직였다 (${top0} -> ${seen.map((q) => q.top).join(", ")})`);
      if (!seen[0].detour && !seen[0].flipped) ok(seen[0].legs === "h", `따라 긋기 — 옆으로 끌었는데 ${seen[0].legs}`);
      if (!seen[0].detour && !seen[1].detour && !seen[1].flipped) {
        ok(/^hv/.test(seen[1].legs), `따라 긋기 — 옆으로 끌고 꺾었는데 ${seen[1].legs}`);
        ok(seen[2].corners >= 1, "따라 긋기 — 다시 꺾었는데 굽이가 고정되지 않았다");
      }
      ok(after.nerr <= n0, `따라 긋기 — 넣으니 오류가 늘었다 ${n0} -> ${after.nerr}`);
      await page.keyboard.press("z");
      await idle();
      fly = await flyOf(aNet);
      ok(fly.nerr === n0, `따라 긋기를 무른 뒤 오류 ${fly.nerr} (지운 뒤 ${n0})`);
    }
    let tapped = 0, drags = 0;
    for (let k = 0; k < 12 && fly.comps > 1; k++) {
      const ln = fly.lines[0];
      const [pa, pb] = await at2(ln.a, ln.b);
      const h = await rtNow(() => globalThis.__page.editor.state.rt.hist.length);
      await page.mouse.move(pa.x, pa.y);
      await page.mouse.down();
      const started = await rtNow(() => !!globalThis.__page.editor.state.rt.draw?.assist);
      await page.mouse.move(pb.x, pb.y, { steps: 8 });
      const pv = await rtNow(() => { const q = globalThis.__page.editor.state.rt.preview; return q ? { ok: q.ok, target: !!q.target, why: q.why, issues: q.issues.length } : null; });
      await page.mouse.up();
      drags++;
      if (started && pv?.target) tapped++;
      else bad(`끌기 ${k + 1}: ${started ? "" : "누른 핀에서 시작 안 함 · "}미리보기 ${JSON.stringify(pv)}`);
      await page.waitForFunction((h) => { const rt = globalThis.__page.editor.state.rt; return !rt.busy && !rt.draw && rt.hist.length > h; }, h, { timeout: 60000 })
        .catch(() => bad(`끌기 ${k + 1} 가 안 끝났다`));
      fly = await flyOf(aNet);
    }
    const as = await rtNow(() => ({ status: document.querySelector("#status").textContent.trim(), hint: document.querySelector("#hint").textContent.trim() }));
    console.log(`  보조: 끌기 ${drags} 번 (핀에 붙음 ${tapped}) — 덩이 ${fly.comps} · DRC/LVS ${fly.nerr} (기준 ${base}) · ${as.status}`);
    ok(fly.comps === 1, `보조로 이은 ${aNet} 이 ${fly.comps} 덩이다`);
    ok(fly.nerr <= base, `보조로 이은 뒤 오류가 늘었다 ${base} -> ${fly.nerr}`);
    ok(/보조 그리기 \(토막/.test(as.status), "보조 그리기 상태 줄이 없다");
    // 플라이라인 클릭 — 선 가운데를 가리키면 굵어지고, 클릭하면 길찾기로 잇는다
    await rip(aNet);
    await page.click('#editTools button[data-tool="wire"]');
    fly = await flyOf(aNet);
    for (let k = 0; k < 12 && fly.comps > 1; k++) {
      const ln = fly.lines[0];
      const [pa, pb] = await at2(ln.a, ln.b);
      const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
      const h = await rtNow(() => globalThis.__page.editor.state.rt.hist.length);
      await page.mouse.move(mid.x, mid.y);
      const hot = await rtNow(() => globalThis.__page.editor.state.rt.flyHover?.net ?? null);
      if (hot !== aNet) { bad(`플라이라인 가운데를 가리켰는데 ${hot}`); break; }
      await page.mouse.click(mid.x, mid.y);
      await page.waitForFunction((h) => { const rt = globalThis.__page.editor.state.rt; return !rt.busy && rt.hist.length > h; }, h, { timeout: 60000 })
        .catch(() => bad(`플라이라인 클릭 ${k + 1} 이 안 끝났다`));
      fly = await flyOf(aNet);
    }
    console.log(`  보조: 플라이라인 클릭 — 덩이 ${fly.comps} · DRC/LVS ${fly.nerr}`);
    ok(fly.comps === 1 && fly.nerr <= base, `플라이라인 클릭으로 못 이었다 (덩이 ${fly.comps}, 오류 ${fly.nerr})`);
    // 열린 곳 모두 잇기 — 두 넷을 지우고 도구 줄 버튼 하나로
    const two = routedNames.slice(0, 2);
    for (const n of two) await rip(n);
    const open0 = await page.$eval('#editTools button[data-act="rconnectall"]', (b) => ({ text: b.textContent.trim(), disabled: b.disabled }));
    const h2 = await rtNow(() => globalThis.__page.editor.state.rt.hist.length);
    await page.click('#editTools button[data-act="rconnectall"]');
    await page.waitForFunction((h) => { const rt = globalThis.__page.editor.state.rt; return !rt.busy && rt.hist.length > h; }, h2, { timeout: 60000 }).catch(() => bad("모두 잇기가 안 끝났다"));
    const allc = await page.evaluate(async () => {
      const rt = globalThis.__page.editor.state.rt, D = await import("./src/edit/draw.mjs");
      return { open: rt.model.nets.filter((q) => D.netComponents(q, rt.graphs.get(q.name)).comps > 1).map((q) => q.name), nerr: rt.nerr, status: document.querySelector("#status").textContent.trim() };
    });
    console.log(`  보조: 모두 잇기 (${open0.text}) — 열린 넷 ${allc.open.length} · DRC/LVS ${allc.nerr} (기준 ${base}) · ${allc.status}`);
    ok(!open0.disabled && !allc.open.length && allc.nerr <= base, `모두 잇기 — 열린 넷 ${allc.open.join(" ")}, 오류 ${allc.nerr}`);
  } else console.log("  배선된 넷이 없다 — 그리기는 건너뛴다");
} finally {
  await browser.close();
  srv.close();
}
console.log(fails ? `\n실패 ${fails} 건` : "\n통과");
process.exit(fails ? 1 : 0);
