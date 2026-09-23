import fs from "node:fs";
import { WASI } from "node:wasi";
const [wasmPath, inPath, outPath] = process.argv.slice(2);
fs.writeFileSync(outPath, "");
const wasi = new WASI({ version: "preview1", args: ["lptest"], env: {},
  stdin: fs.openSync(inPath, "r"), stdout: fs.openSync(outPath, "w"), stderr: 2, preopens: {} });
const mod = await WebAssembly.compile(fs.readFileSync(wasmPath));
const inst = await WebAssembly.instantiate(mod, wasi.getImportObject());
const t0 = performance.now();
wasi.start(inst);
console.error("ms", (performance.now() - t0).toFixed(0), "imports", WebAssembly.Module.imports(mod).map((i) => i.name).join(","));
