/** 5 예제 x (ALIGN 배치, 우리 배치) 를 ALIGN 으로 배선하며 RouteWork 앞뒤 덤프를 캐시에 모은다.
 *
 *    node runall.mjs [예제]      -> ~/.cache/symplace/tap/<예제>/{align,ours}/
 *
 *  호출마다 NN_<모듈>_m<모드>_in.json / _out.json (hierNode 전체), drc.json (Drc_info), calls.json
 *  (모드·층 범위·넷 수·C++ 시간), Results/ (ALIGN 중간 덤프), result.json (DRC/LVS). power/ 의 대조가 읽는다.
 *  우리 배치는 ../../node/place.mjs 가 캐시에 쓴 것 (없으면 ALIGN 배치만).
 */
import fs from "node:fs";
import path from "node:path";
import { bootAlign, runFront, workerPython, WORK_CACHE, ROOT } from "../../node/align.mjs";
import { placementFromAlign } from "../../../../../src/route/problem.mjs";
const J = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const only = process.argv[2];
const rows = J(path.join(ROOT, "data/index.json")).map((x) => (typeof x === "string" ? x : x.name));
const HERE = path.dirname(new URL(import.meta.url).pathname);
for (const ex of rows) {
  if (only && ex !== only) continue;
  if (!fs.existsSync(path.join(ROOT, "data", ex + ".leaves.json"))) continue;
  const design = J(path.join(ROOT, "data", ex + ".json"));
  const runs = [["align", placementFromAlign(design.place)]];
  const pf = path.join(WORK_CACHE, `place-${ex}.json`);
  if (fs.existsSync(pf)) runs.push(["ours", J(pf)]);
  for (const [tag, placement] of runs) {
    const t0 = performance.now();
    const { py } = await bootAlign({ blasfix: true });
    const { top } = runFront(py, ex);
    py.setStdout({ batched: () => {} }); py.setStderr({ batched: () => {} });
    py.runPython(workerPython("PYROUTE"));
    py.runPython(fs.readFileSync(path.join(HERE, "tap.py"), "utf8"));
    const r = JSON.parse(py.globals.get("route")("/work/" + ex, ex, top, JSON.stringify(placement)));
    const out = path.join(WORK_CACHE, "tap", ex, tag);
    fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
    for (const n of py.FS.readdir("/work/tap")) if (!n.startsWith(".")) fs.writeFileSync(path.join(out, n), py.FS.readFile("/work/tap/" + n));
    const res = "/work/" + ex + "/3_pnr/Results";
    fs.mkdirSync(path.join(out, "Results"));
    for (const n of py.FS.readdir(res)) if (!n.startsWith(".")) fs.writeFileSync(path.join(out, "Results", n), py.FS.readFile(res + "/" + n));
    fs.writeFileSync(path.join(out, "result.json"), JSON.stringify({ ok: r.ok, nerrors: r.nerrors, errors: r.errors, error: r.error }, null, 1));
    const calls = r.ok ? J(path.join(out, "calls.json")) : [];
    console.log(`${ex.padEnd(28)} ${tag.padEnd(5)} ok=${r.ok} DRC/LVS ${r.nerrors ?? "-"}  ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    for (const c of calls) console.log(`    #${c.k} m${c.mode} ${c.node.padEnd(26)} top=${c.isTop ? 1 : 0} L${c.Lmetal}-${c.Hmetal} nets ${c.nets} blocks ${c.blocks} snets ${c.snets} pnets ${c.powerNets} -> metal ${c.path_metal} via ${c.path_via} vdd ${c.vdd} gnd ${c.gnd} pwr ${c.pwr_metal}  ${c.secs}s`);
    if (!r.ok) console.log(String(r.error).split("\n").slice(-4).join("\n"));
  }
}
