/** ALIGN 앞단 출력(작업 디렉터리의 1_topology/·2_primitives/, 또는 그 파일들을 한 폴더에 펼쳐 둔 것)을 **예제**로 묶는다.
 *
 *      node symplace/web/placer/pack-example.mjs <폴더> [이름] [--label "이름표"] [--leaves-only]
 *
 *  쓰는 것
 *    data/<이름>.json          {topology, primitives, templates} — 페이지와 검사가 읽는 예제 한 덩이.
 *                              templates 의 terminals 는 netType == "pin" 만 남긴다 (배치기가 보는 것은 그것뿐이고,
 *                              나머지는 파일 크기의 대부분이다 — 예제 하나가 84K -> 13K).
 *    data/<이름>.leaves.json   리프 전체 도형 (src/route/leaves.mjs 형식). 배선할 때만 받으므로 첫 화면은 가볍다.
 *    data/index.json           목록 한 줄 (있으면 갱신).
 *
 *  브라우저에서 .sp 를 올려 "예제로 저장" 한 파일은 이 두 파일을 하나로 합친 것이라, 그것을 data/ 에 넣어도 된다.
 *
 *      --leaves-only   리프 도형만 쓴다. data/<이름>.json 과 index 는 안 건드린다.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packLeaves } from "../../../src/route/leaves.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");      // 저장소 루트
const DATA = path.join(ROOT, "data");

const argv = process.argv.slice(2);
const li = argv.indexOf("--label");
const label = li >= 0 ? argv.splice(li, 2)[1] : null;
const lo = argv.indexOf("--leaves-only");
const leavesOnly = lo >= 0 && argv.splice(lo, 1).length > 0;
const [dir, nameArg] = argv;
if (!dir) {
  console.error("쓰기: node symplace/web/placer/pack-example.mjs <폴더> [이름] [--label \"이름표\"] [--leaves-only]");
  process.exit(2);
}
const J = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const name = (nameArg ?? path.basename(path.resolve(dir))).toLowerCase();

// 작업 디렉터리면 1_topology / 2_primitives 에서, 펼친 폴더면 그 자리에서 읽는다.
const hasStages = fs.existsSync(path.join(dir, "2_primitives"));
const topoDir = hasStages ? path.join(dir, "1_topology") : dir;
const primDir = hasStages ? path.join(dir, "2_primitives") : dir;

const vfiles = fs.readdirSync(topoDir).filter((f) => f.endsWith(".verilog.json")).sort();
if (!vfiles.length) throw new Error(`${topoDir}: *.verilog.json 이 없다`);
const topology = J(path.join(topoDir, vfiles[vfiles.length - 1]));
const primitives = J(path.join(primDir, "__primitives__.json"));

const templates = {}, full = {};
const missing = [];
for (const cn of Object.keys(primitives)) {
  const p = path.join(primDir, cn + ".json");
  if (!fs.existsSync(p)) { missing.push(cn); continue; }
  const d = J(p);
  full[cn] = d;
  templates[cn] = {
    bbox: d.bbox,
    terminals: (d.terminals ?? []).filter((t) => t.netType === "pin" && t.netName),
  };
}

fs.mkdirSync(DATA, { recursive: true });
const leavesOut = path.join(DATA, name + ".leaves.json");
fs.writeFileSync(leavesOut, JSON.stringify(packLeaves(full)));
console.log(`data/${name}.leaves.json  ${(fs.statSync(leavesOut).size / 1024).toFixed(1)}K` +
            `  리프 ${Object.keys(full).length} 종`);
if (leavesOnly) process.exit(0);

const out = path.join(DATA, name + ".json");
fs.writeFileSync(out, JSON.stringify({ topology, primitives, templates }));
const bytes = fs.statSync(out).size;

// 목록에 넣는다 (있으면 갱신).
const upsert = (idxPath, row) => {
  const rows = (fs.existsSync(idxPath) ? J(idxPath) : []).map((x) => (typeof x === "string" ? { name: x } : x));
  const prev = rows.find((r) => r.name === row.name);
  if (prev) Object.assign(prev, row);
  else rows.push(row);
  fs.writeFileSync(idxPath, JSON.stringify(rows, null, 1) + "\n");
  return rows.length;
};
const nList = upsert(path.join(DATA, "index.json"), { name, label: label ?? name, bytes });

const nInst = (topology.modules.at(-1).instances ?? []).length;
console.log(`data/${name}.json  ${(bytes / 1024).toFixed(1)}K`);
console.log(`  모듈 ${topology.modules.length}, 인스턴스 ${nInst}, 소자 ${Object.keys(templates).length} 종`);
if (missing.length) console.log(`  템플릿 없음 ${missing.length} 개: ${missing.slice(0, 4).join(", ")}`);
console.log(`  data/index.json 갱신 — 목록 ${nList} 개`);
