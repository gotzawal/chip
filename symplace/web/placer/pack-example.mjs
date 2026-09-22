/** 앞단 출력 폴더를 **예제 한 파일**로 묶는다.
 *
 *  페이지가 읽는 예제는 {topology, primitives, templates, place} 한 덩이다
 *  (data/<이름>.json). 이 스크립트가 그걸 만든다.
 *
 *      node symplace/web/placer/pack-example.mjs <폴더> [이름] [--label "이름표"]
 *
 *  <폴더> 는 둘 중 아무거나:
 *    - ALIGN 작업 디렉터리        (1_topology/ 와 2_primitives/ 가 있는 곳)
 *    - 그걸 펼쳐 둔 폴더          (symplace/web/placer/fixtures/design/<이름>)
 *
 *  `__align_place__.json` (또는 3_pnr/Results 의 scaled_placement_verilog) 이
 *  있으면 **비교 기준선**으로 같이 담는다. 없으면 왼쪽 패널이 빈 채로 돈다 —
 *  배치에는 안 쓰이므로 없어도 된다.
 *
 *  terminals 는 `netType == "pin"` 인 것만 남긴다. 나머지는 배선/GDS 단계의
 *  기하라 배치기가 안 읽고, 파일 크기의 대부분이다 (예제 하나가 84KB -> 13KB).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");      // 저장소 루트
const DATA = path.join(ROOT, "data");

const argv = process.argv.slice(2);
const li = argv.indexOf("--label");
const label = li >= 0 ? argv.splice(li, 2)[1] : null;
const [dir, nameArg] = argv;
if (!dir) {
  console.error("쓰기: node symplace/web/placer/pack-example.mjs <폴더> [이름] [--label \"이름표\"]");
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

const templates = {};
let missing = [];
for (const cn of Object.keys(primitives)) {
  const p = path.join(primDir, cn + ".json");
  if (!fs.existsSync(p)) { missing.push(cn); continue; }
  const d = J(p);
  templates[cn] = {
    bbox: d.bbox,
    terminals: (d.terminals ?? []).filter((t) => t.netType === "pin" && t.netName),
  };
}

// 비교 기준선 (있으면).
let place = null;
const flat = path.join(dir, "__align_place__.json");
if (fs.existsSync(flat)) place = J(flat);
else if (hasStages) {
  const res = path.join(dir, "3_pnr", "Results");
  const top = path.basename(vfiles[vfiles.length - 1], ".verilog.json");
  const hit = fs.existsSync(res)
    ? fs.readdirSync(res)
        .filter((f) => f.startsWith(top + "_") && f.endsWith(".scaled_placement_verilog.json"))
        .sort()[0]
    : null;
  if (hit) place = J(path.join(res, hit));
}

fs.mkdirSync(DATA, { recursive: true });
const out = path.join(DATA, name + ".json");
fs.writeFileSync(out, JSON.stringify({ topology, primitives, templates, place }));
const bytes = fs.statSync(out).size;

// 목록에 넣는다 (있으면 갱신).
const idxPath = path.join(DATA, "index.json");
const idx = fs.existsSync(idxPath) ? J(idxPath) : [];
const rows = idx.map((x) => (typeof x === "string" ? { name: x } : x));
const prev = rows.find((r) => r.name === name);
if (prev) Object.assign(prev, { label: label ?? prev.label ?? name, bytes });
else rows.push({ name, label: label ?? name, bytes });
fs.writeFileSync(idxPath, JSON.stringify(rows, null, 1) + "\n");

const nInst = (topology.modules.at(-1).instances ?? []).length;
console.log(`data/${name}.json  ${(bytes / 1024).toFixed(1)}K`);
console.log(`  모듈 ${topology.modules.length}, 인스턴스 ${nInst}, 소자 ${Object.keys(templates).length} 종`);
console.log(`  ALIGN 기준선 ${place ? "있음" : "없음 (왼쪽 패널이 빈다)"}`);
if (missing.length) console.log(`  템플릿 없음 ${missing.length} 개: ${missing.slice(0, 4).join(", ")}`);
console.log(`  data/index.json 갱신 — 목록 ${rows.length} 개`);
