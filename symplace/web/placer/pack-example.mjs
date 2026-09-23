/** ALIGN 작업 디렉터리(또는 앞단 출력 폴더)를 **예제**로 묶는다.
 *
 *      node symplace/web/placer/pack-example.mjs <폴더> [이름] [--label "이름표"] [--leaves-only]
 *
 *  <폴더> 는 둘 중 아무거나:
 *    - ALIGN 작업 디렉터리   1_topology/, 2_primitives/, (있으면) 3_pnr/   — scripts/align-baseline.sh 가 만든다
 *    - 앞단 출력을 한 폴더에 펼쳐 둔 것 (*.verilog.json, __primitives__.json, <concrete>.json)
 *
 *  쓰는 것
 *    data/<이름>.json          {topology, primitives, templates, place} — 페이지와 검사가 읽는 예제 한 덩이.
 *                              templates 의 terminals 는 netType == "pin" 만 남긴다 (배치기가 보는 것은 그것뿐이고,
 *                              나머지는 파일 크기의 대부분이다 — 예제 하나가 84K -> 13K).
 *    data/<이름>.leaves.json   리프 전체 도형 (src/route/leaves.mjs 형식). 배선할 때만 받으므로 첫 화면은 가볍다.
 *    data/index.json           목록 한 줄 (있으면 갱신).
 *    routed/<이름>.align.json  ALIGN 배선 기하 {bbox, terminals} — 3_pnr/<TOP>_0.json 이 있을 때만.
 *    routed/index.json         {name, align: {geo, rects, gdsName, gdsBytes, errors: [{file, text}]}} 한 줄.
 *
 *  기준선은 ALIGN 이 낸 것이 있을 때만 담긴다: 배치는 3_pnr/Results/<TOP>_*.scaled_placement_verilog.json
 *  (또는 펼친 폴더의 __align_place__.json), 배선은 3_pnr/<TOP>_0.json. 없으면 페이지의 왼쪽 패널이 빈 채로 돈다 —
 *  배치·배선에는 안 쓰이므로 없어도 된다.
 *
 *      --leaves-only   리프 도형만 쓴다. data/<이름>.json 과 index 는 안 건드린다
 *                      (ALIGN 기준선이 든 예제 파일을 앞단 출력만 있는 폴더로 덮지 않게).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packLeaves } from "../../../src/route/leaves.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");      // 저장소 루트
const DATA = path.join(ROOT, "data");
const ROUTED = path.join(ROOT, "routed");

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
const top = path.basename(vfiles[vfiles.length - 1], ".verilog.json");
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

// --- 배치 기준선 (있으면) ---
let place = null;
const flat = path.join(dir, "__align_place__.json");
if (fs.existsSync(flat)) place = J(flat);
else if (hasStages) {
  const res = path.join(dir, "3_pnr", "Results");
  const hit = fs.existsSync(res)
    ? fs.readdirSync(res)
        .filter((f) => f.startsWith(top + "_") && f.endsWith(".scaled_placement_verilog.json"))
        .sort()[0]
    : null;
  if (hit) place = J(path.join(res, hit));
}

const out = path.join(DATA, name + ".json");
fs.writeFileSync(out, JSON.stringify({ topology, primitives, templates, place }));
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
console.log(`  ALIGN 배치 기준선 ${place ? "있음" : "없음 (왼쪽 패널이 빈다)"}`);
if (missing.length) console.log(`  템플릿 없음 ${missing.length} 개: ${missing.slice(0, 4).join(", ")}`);
console.log(`  data/index.json 갱신 — 목록 ${nList} 개`);

// --- 배선 기준선 (있으면): ALIGN 배선기가 낸 도형과 DRC/LVS 문구 ---
//
//   3_pnr/<TOP>_0.json      gen_viewer_json 의 출력 — 그중 {bbox, terminals} 만 그린다
//   3_pnr/<모듈>_0.errors    검사기가 찍은 문구, 한 줄이 한 건 (하위 모듈 것도 같이 담는다)
//   <TOP>_0.gds             작업 디렉터리 루트 (<TOP>_0.python.gds 는 파이썬이 쓴 사본이라 뺀다)
const pnr = path.join(dir, "3_pnr");
const geoPath = path.join(pnr, `${top}_0.json`);
if (!hasStages || !fs.existsSync(geoPath)) {
  console.log(`  ALIGN 배선 기준선 없음 (${hasStages ? "3_pnr/" + top + "_0.json 이 없다" : "작업 디렉터리가 아니다"}) — 배선 보기의 왼쪽이 빈다`);
  process.exit(0);
}
const geo = J(geoPath);
fs.mkdirSync(ROUTED, { recursive: true });
const geoOut = path.join(ROUTED, `${name}.align.json`);
fs.writeFileSync(geoOut, JSON.stringify({ bbox: geo.bbox, terminals: geo.terminals }));
const errors = [];
for (const f of fs.readdirSync(pnr).filter((f) => f.endsWith(".errors")).sort())
  for (const line of fs.readFileSync(path.join(pnr, f), "utf8").split("\n"))
    if (line.trim()) errors.push({ file: f, text: line });
const gdsName = `${top}_0.gds`;
const gdsPath = path.join(dir, gdsName);
const gdsBytes = fs.existsSync(gdsPath) ? fs.statSync(gdsPath).size : 0;
const nRouted = upsert(path.join(ROUTED, "index.json"),
  { name, align: { errors, gdsBytes, gdsName, geo: `${name}.align.json`, rects: geo.terminals.length } });
console.log(`routed/${name}.align.json  ${(fs.statSync(geoOut).size / 1024).toFixed(1)}K  사각형 ${geo.terminals.length}` +
            `  DRC/LVS ${errors.length} 건  GDS ${gdsBytes ? (gdsBytes / 1024).toFixed(0) + "K" : "없음"}`);
console.log(`  routed/index.json 갱신 — 목록 ${nRouted} 개`);
