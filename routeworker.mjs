/** 배선 · Rust 이식 — ALIGN 의 배선 단계를 옮긴 것으로 배선하는 워커 (src/route/pipeline.mjs). 파이썬은 안 뜬다.
 *
 *    postMessage({ design: {topology, primitives}, leaves: {format: "leaves/1", leaves}, placement })
 *      -> { type: "log", text }                  모듈마다 한 줄
 *      -> { type: "route", ok, name, secs, gds (ArrayBuffer), gdsName, errors, nerrors, geo, stats, records, warnings }
 *      -> { type: "error", msg }
 *
 *  받는 것은 배선기 wasm 하나 (src/route/alignroute.wasm — ALIGN C++ 배선기를 Rust 로 옮긴 것)와 예제의
 *  리프 도형 (data/<예제>.leaves.json, 페이지가 넘긴다). records 는 RouteWork 마다 배선기가 쓴 필드라
 *  "배선 · ALIGN 원본"(alignworker.mjs) 의 기록과 모듈·단계·넷 단위로 견줄 수 있다.
 */
import { loadAlignRouter } from "./src/route/alignroute.mjs";
import { routeDesign, routeMessage } from "./src/route/pipeline.mjs";

let routerP = null;
const getRouter = () => (routerP ??= (async () => {
  const r = await fetch(new URL("./src/route/alignroute.wasm", import.meta.url));
  if (!r.ok) throw new Error(`src/route/alignroute.wasm -> ${r.status}`);
  return loadAlignRouter(await r.arrayBuffer());
})().catch((err) => { routerP = null; throw err; }));      // 받다가 실패했으면 다음 번에 다시 받는다

self.onmessage = async (e) => {
  try {
    const t0 = performance.now();
    const router = await getRouter();
    const out = await routeDesign({ ...e.data, router, say: (text) => postMessage({ type: "log", text }) });
    const msg = routeMessage(out, (performance.now() - t0) / 1000);
    postMessage(msg, [msg.gds]);
  } catch (err) {
    // 첫 줄이 메시지다 — Safari·Firefox 의 stack 에는 메시지 없이 자리만 있다
    postMessage({ type: "error", msg: `${err?.message ?? err}\n${err?.stack ?? ""}`.slice(0, 1500) });
  }
};
