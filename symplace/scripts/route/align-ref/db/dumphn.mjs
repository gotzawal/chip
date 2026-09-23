/** Run the reference ALIGN route flow (node + Pyodide, same as symplace/scripts/route/node/route.mjs)
 *  with instrument.py injected, and copy the PnRDB dumps out.
 *
 *    node dumphn.mjs <example> <outdir> [--place=align]
 *
 *  Placement: ~/.cache/symplace/place-<example>.json (the page's placer, cached by ../../node/place.mjs),
 *  or with --place=align ALIGN's own placement from data/<example>.json (same as test/route.mjs).
 *  Reads (never writes) the project harness in ../../node.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE = path.resolve(HERE, "../../node");
const { bootAlign, runFront, workerPython, WORK_CACHE } = await import(NODE + "/align.mjs");

const [ex, out] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const alignPlace = process.argv.includes("--place=align");
if (!ex || !out) { console.error("usage: node dumphn.mjs <example> <outdir>"); process.exit(2); }
const t0 = performance.now();
const log = (...a) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const { py } = await bootAlign({ log });
const { top } = runFront(py, ex);
log("front done, top =", top);

globalThis.routeLog = (t) => { for (const l of String(t).split("\n")) if (/bottom up routing|Traceback|Error|instrumentation/i.test(l)) log("  |", l.slice(0, 200)); };
py.setStdout({ batched: globalThis.routeLog });
py.setStderr({ batched: globalThis.routeLog });
py.runPython(workerPython("PYROUTE"));
py.runPython(fs.readFileSync(path.join(HERE, "instrument.py"), "utf8"));

const placement = alignPlace
  ? JSON.stringify((await import(path.resolve(HERE, "../../../../../src/route/problem.mjs")))
      .placementFromAlign(JSON.parse(fs.readFileSync(path.resolve(HERE, `../../../../../data/${ex}.json`), "utf8")).place))
  : fs.readFileSync(path.join(WORK_CACHE, `place-${ex}.json`), "utf8");
const r = JSON.parse(py.globals.get("route")("/work/" + ex, ex, top, placement));
log("route ok =", r.ok, r.ok ? `errors ${r.nerrors}` : r.error.slice(-1500));

fs.mkdirSync(out, { recursive: true });
for (const n of py.FS.readdir("/work/_hn")) {
  if (n === "." || n === "..") continue;
  fs.writeFileSync(path.join(out, n), py.FS.readFile("/work/_hn/" + n));
}
// also keep the ALIGN outputs we compare against
const pnr = `/work/${ex}/3_pnr`;
for (const n of py.FS.readdir(pnr)) {
  if (/\.json$/.test(n) && !/^__/.test(n)) fs.writeFileSync(path.join(out, "align_" + n), py.FS.readFile(pnr + "/" + n));
}
for (const n of py.FS.readdir(pnr + "/inputs")) {
  if (/(\.pnr\.const\.json|\.lef|\.map|verilog\.json)$/.test(n)) fs.writeFileSync(path.join(out, "inputs_" + n), py.FS.readFile(pnr + "/inputs/" + n));
}
log("dumped to", out);
