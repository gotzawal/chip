/** 배선 — ALIGN 의 배선 단계를 옮긴 것으로 배선하는 워커 (src/route/pipeline.mjs). 파이썬은 안 뜬다.
 *
 *    postMessage({ design: {topology, primitives}, leaves: {format: "leaves/1", leaves}, placement, frozen? })
 *      -> { type: "log", text }                  모듈마다 한 줄
 *      -> { type: "route", ok, name, secs, gds (ArrayBuffer), gdsName, errors, nerrors, geo, stats, warnings, wires, frozen }
 *      -> { type: "error", msg }
 *
 *  편집기가 쓰는 두 가지 (kind) — 워커가 마지막 판의 **세션**(모듈마다의 hierNode 와 검사 도형)을 쥐고 있어야 한다:
 *    { kind: "recheck", edits: [{net, path_metal, path_via} | {net, restore: true}] }   배선기 없이 다시 검사·GDS
 *    { kind: "reroute", frozen: [{net, path_metal, path_via}] }                          고정 넷은 그대로, 나머지 다시 배선
 *  kind 가 없으면 배선 한 판이다 (지금 그대로).
 *
 *  받는 것은 배선기 wasm 하나 (src/route/alignroute.wasm — ALIGN C++ 배선기를 Rust 로 옮긴 것)와 예제의
 *  리프 도형 (data/<예제>.leaves.json, 페이지가 넘긴다).
 */
import { loadAlignRouter } from "./src/route/alignroute.mjs";
import { routeSession, sessionOutput, recheck, routeMessage } from "./src/route/pipeline.mjs";

let routerP = null;
const getRouter = () => (routerP ??= (async () => {
  const r = await fetch(new URL("./src/route/alignroute.wasm", import.meta.url));
  if (!r.ok) throw new Error(`src/route/alignroute.wasm -> ${r.status}`);
  return loadAlignRouter(await r.arrayBuffer());
})().catch((err) => { routerP = null; throw err; }));      // 받다가 실패했으면 다음 번에 다시 받는다

let session = null;                                        // 마지막 판

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    const t0 = performance.now();
    const say = (text) => postMessage({ type: "log", text });
    let out;
    if (msg.kind === "recheck") {
      if (!session) throw new Error("배선 세션이 없습니다 — Routing 실행을 먼저 하세요");
      out = recheck(session, msg.edits ?? []);
    } else if (msg.kind === "reroute") {
      if (!session) throw new Error("배선 세션이 없습니다 — Routing 실행을 먼저 하세요");
      const router = await getRouter();
      session = await routeSession({ design: session.design, leaves: session.lv, placement: session.placement,
                                     router, say, frozen: msg.frozen ?? [] });
      out = sessionOutput(session);
    } else {
      const router = await getRouter();
      session = await routeSession({ ...msg, router, say });
      out = sessionOutput(session);
    }
    const m = routeMessage(out, (performance.now() - t0) / 1000);
    postMessage(m, [m.gds]);
  } catch (err) {
    // 첫 줄이 메시지다 — Safari·Firefox 의 stack 에는 메시지 없이 자리만 있다
    postMessage({ type: "error", msg: `${err?.message ?? err}\n${err?.stack ?? ""}`.slice(0, 1500) });
  }
};
