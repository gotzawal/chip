/** SPICE 넷리스트 -> ALIGN 앞단(1_topology + 2_primitives)을 브라우저에서.
 *
 *  배치기의 입력은 앞단 출력이다. 회로(.sp)부터 시작하려면 ALIGN 의 앞단을
 *  브라우저에서 돌려야 하고, 그게 이 워커다. **.sp 를 올릴 때만 뜬다** — 예제를 고르고
 *  배치·배선하는 데는 안 쓴다 (배선은 routeworker.mjs: JS + Rust wasm).
 *
 *  올리는 것 (원본 크기 합계 약 39 MB, 첫 방문에만)
 *    Pyodide 0.27.8  13.9 MB   CPython 을 wasm 으로
 *    networkx, pydantic 1.10.13, python-gdsii  2.1 MB    앞단이 실제로 쓰는 것만
 *    libz3 22.4 MB             직접 빌드한 side module.
 *                              **사용자가 쓴 제약을 받으려면 진짜로 필요하다**
 *                              (제약이 없으면 no-op 이지만 그건 목표가 아니다)
 *    align-front.zip 0.2 MB    align 파이썬 소스 + PDK (PDK 의 PDF·PPT 와 예제는 뺐다)
 *
 *  ALIGN 의 C++ 배선기(PnR 휠)는 안 싣는다. 앞단은 align/PnR.py 스텁으로 충분하다
 *  (5 예제에서 휠이 있을 때와 출력이 바이트까지 같다). 휠을 싣는 것은 "배선 · ALIGN 원본"
 *  버튼의 alignworker.mjs 다. 올리는 순서는 src/pyodide.mjs, 앞단 원문은 py/front.py.
 *
 *  메인 스레드가 아니라 워커여야 한다: libz3 가 22 MB 라
 *  "RangeError: WebAssembly.Compile is disallowed on the main thread" 가 난다.
 */
import { bootAlignPy, pyText } from "./src/pyodide.mjs";

let py = null;
const say = (text, step) => postMessage({ type: "log", text, step });

/** Pyodide 스택을 올리고 앞단(py/front.py)을 정의한다. 한 번만. */
async function boot() {
  if (py) return py;
  const r = await bootAlignPy({ pnr: false, say });
  r.py.runPython(await pyText("front.py"));
  py = r.py;
  return py;
}

self.onmessage = async (e) => {
  const { sp, name, subckt, constraints } = e.data;
  try {
    const p = await boot();
    say("앞단 실행 — 1_topology · 2_primitives", 5);
    const t0 = performance.now();
    const out = p.globals.get("run")(sp, name, subckt, constraints ?? "");
    const blob = JSON.parse(out);
    const nInst = (blob.topology.modules.at(-1).instances ?? []).length;
    postMessage({
      type: "front", blob, name,
      secs: (performance.now() - t0) / 1000,
      modules: blob.topology.modules.length,
      instances: nInst,
      concrete: Object.keys(blob.primitives).length,
    });
  } catch (err) {
    // wasm 이 죽으면(null function, memory access ...) 그 Pyodide 인스턴스는 다시 못 쓴다.
    // 메시지에 "fatal" 이 없을 때가 있어서 표시를 따로 붙인다 — 페이지가 워커를 새로 띄운다.
    postMessage({ type: "error", msg: String(err?.message ?? err).slice(0, 1500),
                  fatal: !!err?.pyodide_fatal_error || /fatal/i.test(String(err?.message ?? err)) });
  }
};
