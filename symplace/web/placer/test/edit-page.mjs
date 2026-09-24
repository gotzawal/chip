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
 *  실행:  node symplace/web/placer/test/edit-page.mjs [예제=current_mirror_ota] [시작점=48]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve, launchChromium } from "./_browser.mjs";

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
} finally {
  await browser.close();
  srv.close();
}
console.log(fails ? `\n실패 ${fails} 건` : "\n통과");
process.exit(fails ? 1 : 0);
