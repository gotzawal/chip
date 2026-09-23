/** GPU runner 가 CPU 와 같은 계산을 하는가 (검사 본체는 gpu-checks.mjs).
 *
 *  기본은 Playwright 의 Chromium(WebGPU 켬) 안에서 돈다 — 페이지가 실제로 쓰는 경로다.
 *  WEBGPU_NODE=<webgpu 패키지 경로> 를 주면 dawn 의 node 바인딩으로 node 안에서 돈다
 *  (GPU 가 없는 기계에서는 VK_ICD_FILENAMES 로 SwiftShader 를 가리켜야 하고, 그 조합은
 *  이따금 죽는다 — 그래서 기본이 아니다).
 *
 *  실행:  node test/gpu.mjs [예제 이름...]
 */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loadDesign, exampleNames } from "./_load.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..", "..");
const wanted = process.argv.slice(2);
const blobs = [];
for (const ex of exampleNames()) {
  if (wanted.length && !wanted.includes(ex)) continue;
  const { topology, primitives, templates } = loadDesign(ex);
  blobs.push({ name: ex, topology, primitives, templates });
}

let result;
if (process.env.WEBGPU_NODE) {
  const mod = createRequire(import.meta.url)(process.env.WEBGPU_NODE);
  Object.assign(globalThis, mod.globals);
  const { runChecks } = await import("./gpu-checks.mjs");
  result = await runChecks(mod.create([]), blobs);
} else {
  const { serve, launchChromium } = await import("./_browser.mjs");
  const { srv, port } = await serve(ROOT);
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.log("pageerror:", e.message));
    await page.goto(`http://127.0.0.1:${port}/symplace/web/placer/test/gpu.html`);
    result = await page.evaluate(async (blobs) => {
      const m = await import("./gpu-checks.mjs");
      return m.runChecks(navigator.gpu, blobs);
    }, blobs);
  } finally {
    await browser.close();
    srv.close();
  }
}
console.log(result.lines.join("\n"));
process.exit(result.fails ? (result.noGpu ? 2 : 1) : 0);
