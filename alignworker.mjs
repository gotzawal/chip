/** 배선 · ALIGN 원본 — ALIGN 의 파이썬 흐름과 C++ 배선기(축소 PnR 휠)로 배선하는 워커.
 *
 *  Rust 로 옮긴 배선기(routeworker.mjs)와 **같은 배치로 번갈아 돌려 결과가 같은지** 보려고 둔다.
 *  예전 페이지의 배선 경로 그대로다: Pyodide + ALIGN 파이썬 + C++ PnR 휠 (받는 것 약 40 MB, 처음만).
 *
 *    postMessage({ name, sp, constraints, subckt, placement })
 *      -> { type: "log", text, step }                  1~5 준비, 6 앞단, 7 배선
 *      -> { type: "route", ok: true, name, secs, gds, gdsName, gdsCxx, geo, errors, nerrors, records }
 *      -> { type: "error", msg, fatal }
 *
 *  - 앞단(py/front.py)은 이 워커 안에서 설계마다 한 번 돈다 — 배선이 그 작업 디렉터리를 읽는다.
 *  - 배선은 py/pyroute.py (우리 배치를 ALIGN place 단계의 산출물로 넣고 route 단계를 bottom_up 으로).
 *  - RouteWork 마다 py/aligntap.py 가 배선기가 쓴 필드를 기록한다 — Rust 이식이 돌려주는 기록과
 *    같은 모양이라 모듈·단계·넷 단위로 견줄 수 있다 (src/route/align/records.mjs).
 *  - gds 는 ALIGN 의 파이썬 GDS (우리 src/route/gds.mjs 가 바이트까지 맞추는 쪽), gdsCxx 는 C++ GDS.
 */
import { bootAlignPy, pyText } from "./src/pyodide.mjs";

let py = null, frontFor = null;
const say = (text, step) => postMessage({ type: "log", text, step });
// pyroute.py 가 ALIGN 로그를 흘려보내는 곳 (모듈마다 "bottom up routing for ...")
self.routeLog = (t) => say(String(t).slice(0, 200), 7);

async function boot() {
  if (py) return py;
  const { py: p } = await bootAlignPy({ pnr: true, say });
  p.runPython(await pyText("front.py"));
  p.runPython(await pyText("pyroute.py"));
  p.FS.mkdirTree("/alignref");
  p.FS.writeFile("/alignref/aligntap.py", await pyText("aligntap.py"));
  p.runPython("import sys; sys.path.insert(0, '/alignref'); import aligntap; aligntap.install()");
  py = p;
  return py;
}

const unb64 = (s) => {
  if (!s) return new Uint8Array(0);
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
};

self.onmessage = async (e) => {
  const { name, sp, constraints, subckt, placement } = e.data;
  try {
    const p = await boot();
    const t0 = performance.now();
    const key = `${name}\n${subckt}\n${sp}\n${constraints ?? ""}`;
    if (frontFor !== key) {
      say("앞단 — 1_topology · 2_primitives", 6);
      frontFor = null;
      p.globals.get("run")(sp, name, subckt, constraints ?? "");
      frontFor = key;
    }
    say("배선 — RouteWork 4·5 (모듈마다), 2·3 (최상위)", 7);
    p.runPython("aligntap.RECORDS.clear()");
    const r = JSON.parse(p.globals.get("route")("/work/" + name, name, subckt, JSON.stringify(placement)));
    if (!r.ok) {
      const lines = (r.error || "").split("\n").filter((l) => l.trim());
      throw new Error((lines.at(-1) || "알 수 없는 오류").slice(0, 300) + "\n" + r.error);
    }
    const records = JSON.parse(p.runPython("import json, aligntap; json.dumps(aligntap.RECORDS)"));
    const gds = unb64(r.pyGdsB64), gdsCxx = unb64(r.gdsB64);
    postMessage({
      type: "route", ok: true, name, secs: (performance.now() - t0) / 1000,
      gds: gds.buffer, gdsName: r.pyGdsName ?? name + ".gds", gdsCxx: gdsCxx.buffer,
      geo: r.geo, errors: r.errors ?? [], nerrors: r.nerrors ?? 0, records,
    }, [gds.buffer, gdsCxx.buffer]);
  } catch (err) {
    // wasm 이 죽으면 그 Pyodide 인스턴스는 다시 못 쓴다 — 페이지가 워커를 새로 띄운다.
    const msg = String(err?.message ?? err);
    postMessage({ type: "error", msg: msg.slice(0, 3000),
                  fatal: !!err?.pyodide_fatal_error || /fatal|null function|memory access/i.test(msg) });
  }
};
