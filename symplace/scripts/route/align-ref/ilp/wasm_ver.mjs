import fs from "node:fs";
import path from "node:path";
const CACHE = path.join(process.env.HOME, ".cache/symplace/pyodide-0.27.8");
const WHL = path.resolve(path.dirname(new URL(import.meta.url).pathname),
                         "../../../../../py/pnr/pnr-0.9.8-cp312-cp312-emscripten_3_1_58_wasm32.whl");
const { loadPyodide } = await import(path.join(CACHE, "package/pyodide.mjs"));
const py = await loadPyodide({ indexURL: path.join(CACHE, "package") + "/" });
const site = "/lib/python3.12/site-packages";
py.unpackArchive(new Uint8Array(fs.readFileSync(WHL)), "zip", { extractDir: site });
await py._api.loadDynlib(site + "/PnR.cpython-312-wasm32-emscripten.so", false);
console.log(py.runPython(String.raw`
import ctypes
lib = ctypes.CDLL("${site}/PnR.cpython-312-wasm32-emscripten.so")
a,b,c,d = (ctypes.c_int(), ctypes.c_int(), ctypes.c_int(), ctypes.c_int())
lib.lp_solve_version(ctypes.byref(a), ctypes.byref(b), ctypes.byref(c), ctypes.byref(d))
lib.make_lp.restype = ctypes.c_void_p
lp = lib.make_lp(0, 2)
for f in ["get_bb_floorfirst","get_bb_rule","get_scaling","get_improve","get_pivoting","get_simplextype","get_anti_degen","get_bb_depthlimit"]:
    getattr(lib, f).argtypes=[ctypes.c_void_p]
vals = {f: getattr(lib,f)(lp) for f in ["get_bb_floorfirst","get_bb_rule","get_scaling","get_improve","get_pivoting","get_simplextype","get_anti_degen","get_bb_depthlimit"]}
f"lp_solve {a.value}.{b.value}.{c.value}.{d.value} defaults {vals} sizeof(long double)={ctypes.sizeof(ctypes.c_longdouble)} sizeof(long)={ctypes.sizeof(ctypes.c_long)}"
`));
