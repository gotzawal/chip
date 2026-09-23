// Runs the dumped ILP instances through the *reference* lp_solve (the one linked into the
// emscripten 3.1.58 PnR wheel) via Pyodide ctypes, using the same API call sequence as
// GcellGlobalRouter::ILPSolveRouting, and prints the solutions as JSON lines.
import fs from "node:fs";
import path from "node:path";

const CACHE = path.join(process.env.HOME, ".cache/symplace/pyodide-0.27.8");
const WHL = path.resolve(path.dirname(new URL(import.meta.url).pathname),
                         "../../../wasm/pnr/pnr-0.9.8-cp312-cp312-emscripten_3_1_58_wasm32.whl");
const [inFile, outFile] = process.argv.slice(2);

const { loadPyodide } = await import(path.join(CACHE, "package/pyodide.mjs"));
const py = await loadPyodide({ indexURL: path.join(CACHE, "package") + "/" });
const M = py._module;
const site = "/lib/python3.12/site-packages";
py.unpackArchive(new Uint8Array(fs.readFileSync(WHL)), "zip", { extractDir: site });
// same BLAS workaround as the reference harness (symplace/scripts/route/node/align.mjs)
Object.defineProperty(M.LDSO.loadedLibsByName, "libmyBLAS.so", {
  get() { return undefined; }, set() {}, configurable: true });
await py._api.loadDynlib(site + "/PnR.cpython-312-wasm32-emscripten.so", false);
py.FS.writeFile("/lps.jsonl", fs.readFileSync(inFile));
py.runPython(String.raw`
import ctypes, json
lib = ctypes.CDLL("${site}/PnR.cpython-312-wasm32-emscripten.so")
vp = ctypes.c_void_p
D = ctypes.c_double
lib.make_lp.restype = vp; lib.make_lp.argtypes = [ctypes.c_int, ctypes.c_int]
lib.set_verbose.argtypes = [vp, ctypes.c_int]
lib.set_outputfile.argtypes = [vp, ctypes.c_char_p]; lib.set_outputfile.restype = ctypes.c_ubyte
lib.add_constraintex.argtypes = [vp, ctypes.c_int, ctypes.POINTER(D), ctypes.POINTER(ctypes.c_int), ctypes.c_int, D]
lib.add_constraintex.restype = ctypes.c_ubyte
lib.set_binary.argtypes = [vp, ctypes.c_int, ctypes.c_ubyte]
lib.set_bounds.argtypes = [vp, ctypes.c_int, D, D]
lib.set_obj_fnex.argtypes = [vp, ctypes.c_int, ctypes.POINTER(D), ctypes.POINTER(ctypes.c_int)]
lib.set_minim.argtypes = [vp]
lib.set_timeout.argtypes = [vp, ctypes.c_long]
lib.get_presolveloops.argtypes = [vp]; lib.get_presolveloops.restype = ctypes.c_int
lib.set_presolve.argtypes = [vp, ctypes.c_int, ctypes.c_int]
lib.solve.argtypes = [vp]; lib.solve.restype = ctypes.c_int
lib.get_objective.argtypes = [vp]; lib.get_objective.restype = D
lib.get_variables.argtypes = [vp, ctypes.POINTER(D)]; lib.get_variables.restype = ctypes.c_ubyte
lib.delete_lp.argtypes = [vp]
out = []
for line in open("/lps.jsonl"):
    inst = json.loads(line)
    N = inst["N"]
    lp = lib.make_lp(0, N + 1)
    lib.set_verbose(lp, 3)
    lib.set_outputfile(lp, b"/dev/null")
    for typ, rhs, ent in inst["rows"]:
        n = len(ent)
        vals = (D * n)(*[e[1] for e in ent]); cols = (ctypes.c_int * n)(*[e[0] for e in ent])
        lib.add_constraintex(lp, n, vals, cols, typ, rhs)
    for i in range(1, N + 1):
        lib.set_binary(lp, i, 1)
    lib.set_bounds(lp, N + 1, 0.0, 1.0)
    one = (D * 1)(1.0); col = (ctypes.c_int * 1)(N + 1)
    lib.set_obj_fnex(lp, 1, one, col)
    lib.set_minim(lp)
    lib.set_timeout(lp, 60)
    lib.set_presolve(lp, 2048 | 8192, lib.get_presolveloops(lp))
    ret = lib.solve(lp)
    obj = lib.get_objective(lp)
    V = (D * (N + 1))()
    lib.get_variables(lp, V)
    out.append(json.dumps({"ret": ret, "obj": repr(obj), "vars": [repr(v) for v in V]}))
    lib.delete_lp(lp)
open("/out.jsonl", "w").write("\n".join(out) + "\n")
`);
fs.writeFileSync(outFile, py.FS.readFile("/out.jsonl"));
console.log("done", outFile);
