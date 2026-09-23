/** 배선 워커 — 파이썬 없이 JS 와 Rust(wasm) 로 배선한다 (src/route/pipeline.mjs).
 *
 *    postMessage({ design: {topology}, leaves: {format: "leaves/1", leaves}, placement, options? })
 *      -> { type: "route", ok, name, secs, gds (ArrayBuffer), gdsName, errors, nerrors, geo, stats }
 *      -> { type: "error", msg }
 *
 *  받는 것은 배선기 wasm 하나 (src/route/router.wasm, 약 170 KB, gzip 40 KB 남짓)와 예제의
 *  리프 도형 (data/<예제>.leaves.json, 페이지가 넘긴다). 예전 경로는 Pyodide + ALIGN 파이썬 +
 *  C++ 배선기 wasm 이었다 (약 40 MB) — 지금은 .sp 를 올릴 때의 앞단(frontworker.mjs)만 그것을 쓴다.
 */
import { routeDesign, routeMessage } from "./src/route/pipeline.mjs";
import { loadRouter } from "./src/route/router.mjs";

let routerP = null;
const getRouter = () => (routerP ??= (async () => {
  const r = await fetch(new URL("./src/route/router.wasm", import.meta.url));
  if (!r.ok) throw new Error(`src/route/router.wasm -> ${r.status}`);
  return loadRouter(await r.arrayBuffer());
})());

self.onmessage = async (e) => {
  try {
    const t0 = performance.now();
    const router = await getRouter();
    const out = routeDesign({ ...e.data, router });
    const msg = routeMessage(out, (performance.now() - t0) / 1000);
    postMessage(msg, [msg.gds]);
  } catch (err) {
    routerP = null;         // 받다가 실패했으면 다음 번에 다시 받는다
    postMessage({ type: "error", msg: String(err?.stack ?? err?.message ?? err).slice(0, 1500) });
  }
};
