/** 검사를 진짜 브라우저(Chromium, WebGPU 켬)에서 돌리기 위한 도우미.
 *
 *  node 에는 WebGPU 가 없다. dawn 의 node 바인딩(`webgpu` 패키지)도 있지만 (test/gpu.mjs
 *  의 WEBGPU_NODE) GPU 가 없는 기계에서는 SwiftShader 위에서 이따금 죽는다. Playwright 의
 *  Chromium 은 같은 조건에서 안정적이고, 페이지가 실제로 쓰는 경로(워커 안의 navigator.gpu)
 *  그대로라 그쪽을 기본으로 둔다.
 *
 *  Playwright 는 저장소에 안 들어 있다. 전역 설치본을 찾는다:
 *      npm i -g playwright && npx playwright install chromium
 *      PLAYWRIGHT_MODULE=<playwright 의 index.mjs 경로>   (못 찾을 때만)
 *
 *  GPU 가 없는 기계에서는 SwiftShader(소프트웨어 Vulkan)로 돈다 — 느리지만 같은 결과다.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";

const MIME = { ".html": "text/html", ".mjs": "text/javascript", ".js": "text/javascript",
               ".json": "application/json", ".wasm": "application/wasm", ".css": "text/css" };

/** 저장소 루트를 http 로 낸다 (ES 모듈과 워커는 file:// 로 안 뜬다). */
export function serve(root, port = 0) {
  const srv = http.createServer((q, r) => {
    const u = decodeURIComponent(new URL(q.url, "http://x").pathname);
    let p = path.join(root, u);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, "index.html");
    if (!p.startsWith(root) || !fs.existsSync(p)) { r.statusCode = 404; r.end("not found"); return; }
    r.setHeader("content-type", MIME[path.extname(p)] ?? "application/octet-stream");
    fs.createReadStream(p).pipe(r);
  });
  return new Promise((res) => srv.listen(port, "127.0.0.1", () => res({ srv, port: srv.address().port })));
}

async function loadPlaywright() {
  const cands = [process.env.PLAYWRIGHT_MODULE].filter(Boolean);
  try { cands.push(path.join(execSync("npm root -g", { encoding: "utf8" }).trim(), "playwright", "index.mjs")); } catch {}
  cands.push("playwright");
  for (const c of cands) {
    try { return await import(c); } catch {}
  }
  try { return createRequire(import.meta.url)("playwright"); } catch {}
  throw new Error("Playwright 를 못 찾았다 — npm i -g playwright 또는 PLAYWRIGHT_MODULE");
}

/** WebGPU 가 켜진 headless Chromium. Playwright 의 headless shell 은 WebGPU 가 없어
 *  전체 Chromium 을 새 headless 모드로 띄운다. */
export async function launchChromium({ gpu = true } = {}) {
  const { chromium } = await loadPlaywright();
  const args = ["--no-sandbox"];
  if (gpu) args.push("--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan=swiftshader",
                     "--ignore-gpu-blocklist");
  let exe = process.env.CHROMIUM_PATH;
  if (!exe) {
    // headless shell 경로에서 전체 chromium 경로를 만든다 (같은 빌드 번호)
    const shell = chromium.executablePath();
    const full = shell.replace("chromium_headless_shell-", "chromium-").replace(/headless_shell$/, "chrome");
    exe = fs.existsSync(full) ? full : shell;
  }
  return chromium.launch({ executablePath: exe, headless: true, args });
}
