/** 회로도·묶음 보기 — headless Chromium 에서 index.html 을 열어 예제마다 두 보기를 켜 본다.
 *
 *  배치·배선은 돌리지 않는다 (page.mjs 가 한다). 보는 것: 페이지 오류가 없는가, 예제마다 회로도와
 *  묶음이 만들어졌는가(소자 수 > 0), 묶음 표가 채워졌는가, 회로도에서 hover 가 넷을 찾는가.
 *
 *  실행:  node symplace/web/placer/test/views.mjs [예제 ...]     (없으면 전부)
 *         SHOT=폴더  를 주면 보기마다 PNG 를 남긴다
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve, launchChromium } from "./_browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..", "..");
const all = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "index.json"), "utf8")).map((x) => x.name);
const names = process.argv.slice(2).length ? process.argv.slice(2) : all;
const shot = process.env.SHOT ? path.resolve(process.env.SHOT) : null;
if (shot) fs.mkdirSync(shot, { recursive: true });

const { srv, port } = await serve(ROOT);
const browser = await launchChromium({ gpu: false });
let fails = 0;
const bad = (msg) => { fails++; console.log("  실패: " + msg); };
try {
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
  page.on("pageerror", (e) => bad("pageerror " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/404|ERR_/.test(m.text())) console.log("  console.error:", m.text()); });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => document.querySelector("#ex option"), null, { timeout: 30000 });
  for (const name of names) {
    console.log(name);
    await page.selectOption("#ex", name);
    await page.click('#whatSeg button[data-what="schem"]');
    await page.waitForFunction((n) => {
      const v = globalThis.__views?.get(n);
      return v && (v.schem || v.schemErr) && (v.group || v.groupErr);
    }, name, { timeout: 20000 });
    const v = await page.evaluate((n) => {
      const v = globalThis.__views.get(n);
      return { top: v.top, schem: v.schem?.stats ?? null, schemErr: v.schemErr, group: v.group?.stats ?? null,
               groupErr: v.groupErr, blocks: v.blocks.length, rows: document.querySelectorAll("#bt tr").length,
               title: document.querySelector("#cvTitle").textContent };
    }, name);
    console.log(`  top ${v.top} · 회로도 ${v.schem ? `소자 ${v.schem.devices} 넷 ${v.schem.nets} 열 ${v.schem.columns}${v.schem.symmetric ? " 대칭" : ""}` : "없음: " + v.schemErr}` +
                ` · 묶음 ${v.group ? `소자 ${v.group.devices} 묶음 ${v.group.hulls}` : "없음: " + v.groupErr} · 블록 ${v.blocks} (표 ${v.rows} 줄)`);
    if (!v.schem) bad("회로도가 없다: " + v.schemErr);
    if (!v.group) bad("묶음이 없다: " + v.groupErr);
    if (!v.blocks || v.rows !== v.blocks) bad(`묶음 표 ${v.rows} 줄 (블록 ${v.blocks})`);
    if (!/Schematic/.test(v.title)) bad("제목이 Schematic 이 아니다: " + v.title);
    await page.waitForTimeout(150);
    // hover: 캔버스 위를 훑어 넷이나 소자가 하나는 잡혀야 한다
    const box = await page.$eval("#cv", (c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    let hint = "";
    for (let k = 0; k < 40 && !hint; k++) {
      await page.mouse.move(box.x + box.w * (0.1 + 0.8 * ((k * 7) % 40) / 40), box.y + box.h * (0.15 + 0.7 * ((k * 3) % 10) / 10));
      hint = await page.$eval("#hint", (e) => e.textContent);
    }
    if (!hint) bad("hover 가 아무것도 못 잡았다");
    else console.log("  hover: " + hint.slice(0, 90));
    if (shot) await page.screenshot({ path: path.join(shot, name + ".schem.png") });
    await page.click('#whatSeg button[data-what="group"]');
    await page.waitForTimeout(150);
    if (shot) await page.screenshot({ path: path.join(shot, name + ".group.png") });
    await page.click('#whatSeg button[data-what="place"]');
  }
  // 앞단 출력만 올린 설계: 묶음은 되고 회로도는 "원문이 없다" 고 말해야 한다
  if (names.length === all.length || names.includes("five_transistor_ota")) {
    console.log("올리기 (앞단 출력 JSON)");
    await page.setInputFiles("#file", path.join(ROOT, "data", "five_transistor_ota.json"));
    await page.waitForFunction(() => {
      const v = globalThis.__views?.get("__upload__");
      return v && (v.schem || v.schemErr) && (v.group || v.groupErr);
    }, null, { timeout: 20000 });
    const u = await page.evaluate(() => {
      const v = globalThis.__views.get("__upload__");
      return { group: v.group?.stats ?? null, groupErr: v.groupErr, schemErr: v.schemErr, schem: !!v.schem,
               rows: document.querySelectorAll("#bt tr").length, sel: document.querySelector("#ex").value };
    });
    console.log(`  선택 ${u.sel} · 묶음 ${u.group ? "소자 " + u.group.devices : "없음: " + u.groupErr} · 회로도 ${u.schem ? "있음(?)" : u.schemErr} · 표 ${u.rows} 줄`);
    if (u.sel !== "__upload__") bad("올린 설계가 선택되지 않았다");
    if (!u.group || u.group.devices !== 5) bad("올린 설계의 묶음이 없다");
    if (u.schem || !/원문/.test(u.schemErr ?? "")) bad("앞단 출력만 올렸는데 회로도 처리가 이상하다: " + u.schemErr);
    if (u.rows !== 3) bad(`올린 설계의 묶음 표가 ${u.rows} 줄`);
    await page.click('#whatSeg button[data-what="schem"]');
    await page.waitForTimeout(200);
    const drawn = await page.evaluate(() => ({ key: globalThis.__drawn?.key, lay: !!globalThis.__drawn?.lay }));
    if (drawn.key !== "__upload__" || drawn.lay) bad(`올린 설계의 회로도 자리에 다른 것을 그렸다 (${drawn.key}, 그림 ${drawn.lay})`);
    await page.click('#whatSeg button[data-what="group"]');
    await page.waitForTimeout(200);
    const drawn2 = await page.evaluate(() => ({ key: globalThis.__drawn?.key, dev: globalThis.__drawn?.lay?.devices?.length ?? 0 }));
    if (drawn2.key !== "__upload__" || drawn2.dev !== 5) bad(`올린 설계의 묶음이 이상하다 (${drawn2.key}, 소자 ${drawn2.dev})`);
    if (shot) await page.screenshot({ path: path.join(shot, "upload.group.png") });
  }
} finally {
  await browser.close();
  srv.close();
}
console.log(fails ? `\n실패 ${fails} 건` : "\n통과");
process.exit(fails ? 1 : 0);
