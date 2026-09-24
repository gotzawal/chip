/** 페이지의 편집기 — headless Chromium 에서 index.html 을 열어 배치한 뒤 편집 모드로 고쳐 본다.
 *
 *  보는 것:
 *    편집 토글이 켜지고 카드가 뜬다. 편집이 없으면 배치 결과(rects)가 그대로다.
 *    블록을 끌면 그 블록만 따라오고(자유 블록) 정리 전 상태가 되며, Enter 로 정리하면 겹침 0·편집 1 회,
 *    이 배치의 배선 결과는 지워진다. F 로 반전, Z 로 되돌리기, 카드에서 변이를 고르면 고정되고
 *    다음 Placement 실행이 그 변이를 쓴다. "위상 유지 최적화" 가 순위를 보인다.
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

  // --- 변이 고정: 후보가 둘 이상인 블록을 골라 다른 변이로 ---
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
    ok(v.c === vpick.other, `변이가 안 바뀌었다 (${v.c})`);
    ok(v.pinned.some(([n, c]) => n === vpick.name && c === vpick.other), "변이가 고정되지 않았다");
    console.log(`  변이 ${vpick.name}: ${vpick.cur} -> ${v.c} (고정 ${v.pinned.length} 개) · 정리 전 ${v.dirty}`);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    ok(!(await page.evaluate(() => globalThis.__page.editor.state.pl.dirty)), "변이 뒤 정리가 안 됐다");
    // 다음 Placement 실행이 고정 변이를 쓴다
    const t1 = Date.now();
    console.log(`  고정 변이로 다시 배치: ${await runPlace()}  (${((Date.now() - t1) / 1000).toFixed(0)}s)`);
    const again = await page.evaluate((nm) => { const o = globalThis.__page.ours; return { c: o.rects.find((r) => r.name === nm)?.concrete, fixed: o.fixedVariants, edited: o.edited ?? 0, pinned: globalThis.__page.editor.state.pl.pinned.size }; }, vpick.name);
    ok(again.c === vpick.other, `다시 배치했는데 고정 변이를 안 썼다 (${again.c})`);
    ok(again.fixed && again.fixed[vpick.name] === vpick.other, "done 에 고정 변이가 없다");
    ok(again.edited === 0 && again.pinned > 0, "새 배치는 편집 0 회여야 하고 고정은 남아야 한다");
  } else console.log("  변이 후보가 하나뿐인 설계 — 변이 고정은 건너뛴다");

  // --- 위상 유지 최적화 (워커 retry) ---
  await page.click('#editBody button[data-act="retry"]');
  await page.waitForFunction(() => /변이 다시|실패/.test(document.querySelector("#status").textContent), null, { timeout: 120000 });
  const rs = (await page.textContent("#status")).trim();
  console.log(`  위상 유지 최적화: ${rs}`);
  ok(/변이 다시 —/.test(rs), "변이 다시가 실패했다");
  ok(await page.$eval("#editBody", (e) => !!e.querySelector("table.rank")), "순위 표가 없다");

  // --- 편집 끄기: 편집이 없으면 그대로 ---
  await page.click('#modeSeg button[data-mode="view"]');
  await page.waitForTimeout(100);
  ok(await page.$eval("#editCard", (e) => e.hidden), "편집 카드가 안 닫힌다");
} finally {
  await browser.close();
  srv.close();
}
console.log(fails ? `\n실패 ${fails} 건` : "\n통과");
process.exit(fails ? 1 : 0);
