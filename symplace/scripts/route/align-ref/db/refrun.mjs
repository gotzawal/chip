/** 배치(와 제약)를 골라 ALIGN 을 앞단부터 돌리고, src/route/align 대조에 쓰는 기준 덤프를 한 캐시 뿌리에 모은다.
 *  5 예제에 없는 경우(한 하위 모듈의 두 모양, Route·DoNotRoute·MultiConnection·NetConst·Boundary 제약 ...)를
 *  시험할 때 쓴다.
 *
 *    node refrun.mjs <예제> <배치.json> <out 뿌리> [--const=<제약.json>]
 *
 *    <out>/data/<예제>.json, <예제>.leaves.json   앞단 결과 (frontworker 의 run — 페이지가 받는 것과 같은 모양)
 *    <out>/tap/<예제>/ours/                        RouteWork 앞뒤 hierNode, drc.json, calls.json (../tap/tap.py), result.json (DRC/LVS)
 *    <out>/aligndb/<예제>/ours/                    PnRDB 단계 덤프와 inputs_* (instrument.py), align_<모듈>_<j>.json·.python.gds.json
 *    <out>/check/<예제>.json                       검사기 입력 기록 (../../node/checkref.mjs 의 capture)
 *    <out>/place-<예제>.json                       쓴 배치
 *
 *  대조:  SYMPLACE_CACHE=<out> node symplace/web/placer/test/aligndb.mjs --ex=<예제> --tag=ours --data=<out>/data
 *         node symplace/web/placer/test/route.mjs --root=<out> [--router=wasm]
 *  --const 가 없으면 netlists/<예제>.const.json 을 쓴다.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { bootAlign, workerPython, topSubckt, ROOT } = await import(path.resolve(HERE, "../../node/align.mjs"));

const args = process.argv.slice(2);
const [ex, placeFile, OUT] = args.filter((a) => !a.startsWith("--"));
const constFile = args.find((a) => a.startsWith("--const="))?.slice(8) ?? path.join(ROOT, "netlists", ex + ".const.json");
if (!ex || !placeFile || !OUT) { console.error("사용법: node refrun.mjs <예제> <배치.json> <out 뿌리> [--const=<제약.json>]"); process.exit(2); }
const t0 = performance.now();
const log = (...a) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const { py } = await bootAlign({ blasfix: true });
const spText = fs.readFileSync(path.join(ROOT, "netlists", ex + ".sp"), "utf8");
const top = topSubckt(spText);
py.runPython(workerPython("FRONT"));
const blob = JSON.parse(py.globals.get("run")(spText, ex, top, fs.existsSync(constFile) ? fs.readFileSync(constFile, "utf8") : ""));
fs.mkdirSync(path.join(OUT, "data"), { recursive: true });
fs.writeFileSync(path.join(OUT, "data", ex + ".json"),
                 JSON.stringify({ topology: blob.topology, primitives: blob.primitives, templates: blob.templates, place: null }));
fs.writeFileSync(path.join(OUT, "data", ex + ".leaves.json"), JSON.stringify(blob.leaves));
log("앞단", top, blob.topology.modules.map((m) => `${m.name}[${m.constraints.map((c) => c.constraint).join(",")}]`).join(" "));

// 검사기 기록 (checkref.mjs 의 파이썬을 그대로), 배선 경로 (pyroute.py), 덤프 (tap.py, instrument.py)
const ck = fs.readFileSync(path.resolve(HERE, "../../node/checkref.mjs"), "utf8");
py.runPython(/const PY = String\.raw`([\s\S]*?)`;/.exec(ck)[1]);
py.runPython("install_capture()");
py.setStdout({ batched: () => {} });
py.setStderr({ batched: () => {} });
py.runPython(workerPython("PYROUTE"));
py.runPython(fs.readFileSync(path.resolve(HERE, "../tap/tap.py"), "utf8"));
py.runPython(fs.readFileSync(path.join(HERE, "instrument.py"), "utf8"));
const placementText = fs.readFileSync(placeFile, "utf8");
const r = JSON.parse(py.globals.get("route")("/work/" + ex, ex, top, placementText));
log("배선 ok =", r.ok, r.ok ? `DRC/LVS ${r.nerrors}` : r.error?.slice(-2500));
if (!r.ok) process.exit(3);

const tapOut = path.join(OUT, "tap", ex, "ours"), dbOut = path.join(OUT, "aligndb", ex, "ours"), ckOut = path.join(OUT, "check");
for (const d of [tapOut, dbOut, ckOut]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }
const copyDir = (from, to, keep = () => true, prefix = "") => {
  for (const n of py.FS.readdir(from)) if (!n.startsWith(".") && keep(n)) fs.writeFileSync(path.join(to, prefix + n), py.FS.readFile(from + "/" + n));
};
copyDir("/work/tap", tapOut);
copyDir("/work/_hn", dbOut);
copyDir(`/work/${ex}/3_pnr/inputs`, dbOut, (n) => /(\.pnr\.const\.json|\.lef|\.map|verilog\.json)$/.test(n), "inputs_");
// ALIGN 이 낸 것: 모듈마다 <모듈>_<j>.json (검사기 출력), .python.gds.json, 오류 문구 (test/route.mjs 가 견준다)
copyDir(`/work/${ex}/3_pnr`, dbOut, (n) => /\.json$/.test(n) && !n.startsWith("__"), "align_");
fs.writeFileSync(path.join(tapOut, "result.json"), JSON.stringify({ ok: r.ok, nerrors: r.nerrors, errors: r.errors, error: r.error }, null, 1));
fs.writeFileSync(path.join(ckOut, ex + ".json"),
                 JSON.stringify({ example: ex, top, placement: JSON.parse(placementText), cases: JSON.parse(py.runPython("captured()")) }));
fs.writeFileSync(path.join(OUT, `place-${ex}.json`), placementText);
for (const c of JSON.parse(fs.readFileSync(path.join(tapOut, "calls.json"), "utf8")))
  log(`  #${c.k} m${c.mode} ${c.node.padEnd(26)} L${c.Lmetal}-${c.Hmetal}`);
log("->", OUT);
