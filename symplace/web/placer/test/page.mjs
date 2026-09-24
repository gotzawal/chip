/** 페이지를 통째로 — headless Chromium 에서 index.html 을 열어 배치 실행을 누르고 끝까지 본다.
 *
 *  워커, 워커 안의 WebGPU, 화면 갱신, 결과 표까지 페이지가 실제로 하는 그대로다.
 *  GPU 가 없는 기계에서는 SwiftShader 로 돈다 (느리다 — 시작점을 적게 준다).
 *
 *  실행:  node test/page.mjs [예제] [gpu|cpu] [총 시작점 48|96|288] [GPU 설정당 8|32|128]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve, launchChromium } from "./_browser.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..", "..");
const [example = "current_mirror_ota", mode = "gpu", batch = "48", perConfig = "8"] = process.argv.slice(2);

const { srv, port } = await serve(ROOT);
const browser = await launchChromium({ gpu: mode === "gpu" });
let fails = 0;
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => { fails++; console.log("pageerror:", e.message); });
  page.on("console", (m) => { if (m.type() === "error" && !/404|ERR_/.test(m.text())) console.log("console.error:", m.text()); });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => document.querySelector("#ex option"), null, { timeout: 30000 });
  await page.selectOption("#ex", example);
  await page.waitForTimeout(1000);
  const gpuField = await page.$eval("#gpuField", (e) => e.hidden);
  console.log(`WebGPU 칸 ${gpuField ? "숨김" : "보임"}  (모드 ${mode})`);
  await page.click("#adv > summary");            // 상세 placement 설정은 접혀 있다
  await page.selectOption("#batch", batch);
  if (!gpuField) await page.selectOption("#perConfig", perConfig);
  const t0 = Date.now();
  await page.click("#run");
  await page.waitForFunction(() => /완료|실패/.test(document.querySelector("#status").textContent),
                             null, { timeout: 3600000 });
  const status = (await page.textContent("#status")).trim();
  console.log(`상태: ${status}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  const rows = await page.$$eval("#metrics dt", (dts) => dts.map((dt) => dt.textContent + " " + dt.nextElementSibling.textContent));
  for (const r of rows) console.log("  " + r.replace(/\s+/g, " "));
  if (/실패/.test(status)) fails++;
  if (mode === "gpu" && !/WebGPU/.test(status)) { fails++; console.log("  실패: WebGPU 로 돌지 않았다"); }
} finally {
  await browser.close();
  srv.close();
}
console.log(fails ? `\n실패 ${fails} 건` : "\n통과");
process.exit(fails ? 1 : 0);
