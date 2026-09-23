/** src/route/compose.mjs 가 ALIGN 의 gen_viewer_json 과 같은 도형을 모으는가.
 *
 *  1. 격자 검사 고정값 — fixtures/grid.json (checkref.mjs grid): 여러 층·여러 자리의 배선 도형에
 *     ALIGN 의 add_terminal 격자 검사가 찍는 문구와 offGrid 의 문구가 글자 그대로 같다.
 *
 *  2. 예제 배선 기록(~/.cache/symplace/check/<예제>.json — checkref.mjs capture)의 모듈마다 (없으면 건너뛴다):
 *    - 블록 도형: 리프는 data/<예제>.leaves.json, 하위 모듈은 그 모듈의 정리된 도형(기록)을
 *      기록된 배치 변환으로 옮기고, 넷 이름은 hier.mjs 의 pgHierarchy + fa_map 으로 바꾼다.
 *      ALIGN 이 검사기에 넣은 도형 목록의 앞부분과 순서·이름·좌표가 같아야 한다.
 *    - 검사기 subinsts 가 같은 순서다.
 *    - 나머지(ALIGN 배선기의 금속·비아)는 add_terminal 모양이고, 격자 검사가 ALIGN 과 같다
 *      (ALIGN 이 찍은 격자 오류 수와 우리 수가 같다).
 *
 *    node symplace/web/placer/test/compose.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { composeModule, metalGrids, offGrid } from "../../../../src/route/compose.mjs";
import { faMapOf, pgHierarchy, powerNetsOf } from "../../../../src/route/hier.mjs";
import { readLeaves, unpackLeaf } from "../../../../src/route/leaves.mjs";
import { MOCK_PDK } from "../../../../src/route/pdk.mjs";
import { canon } from "./checkcases.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const CACHE = process.env.SYMPLACE_CACHE ?? path.join(process.env.HOME ?? "", ".cache/symplace");
const J = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const grids = metalGrids(MOCK_PDK);

let bad = 0, n = 0;

// 1. 격자 검사
{
  const g = J(path.join(ROOT, "symplace/web/placer/fixtures/grid.json"));
  let wrong = 0;
  g.cases.forEach((t, i) => {
    const mine = offGrid(t, grids, t.tag ?? null);
    if (JSON.stringify(mine) !== JSON.stringify(g.results[i])) {
      if (!wrong++) console.log(`    #${i} ${canon(t)}\n      ALIGN ${canon(g.results[i])}\n      JS    ${canon(mine)}`);
    }
  });
  console.log(`${"fixtures/grid.json".padEnd(57)} 도형 ${g.cases.length}  격자 오류 ${g.results.flat().length}  ${wrong ? "틀림 " + wrong : "OK"}`);
  n++; if (wrong) bad++;
}

// 2. 예제 배선 기록
const capDir = path.join(CACHE, "check");
const capFiles = fs.existsSync(capDir) ? fs.readdirSync(capDir).filter((f) => f.endsWith(".json")).sort() : [];
if (!capFiles.length)
  console.log(`(예제 배선 기록 없음: ${capDir} — symplace/scripts/route/node 에서 setup.sh, place.mjs, checkref.mjs capture)`);
for (const f of capFiles) {
  const cap = J(path.join(capDir, f));
  const ex = J(path.join(ROOT, "data", cap.example + ".json"));
  const leaves = readLeaves(J(path.join(ROOT, "data", cap.example + ".leaves.json")));
  const hier = pgHierarchy(ex.topology, cap.top);
  const power = powerNetsOf(hier);
  for (const c of cap.cases) {
    const errs = [];
    const mod = hier.modules.find((m) => m.name === c.module);
    if (!mod) { errs.push(`pgHierarchy 에 ${c.module} 가 없다`); }
    const blocks = [];
    for (const b of c.blocks) {
      if (b.tr2x.slice(0, 2).some((v) => v % 2)) errs.push(`${b.name}: 변환이 반 단위다 ${b.tr2x}`);
      const tr = { oX: b.tr2x[0] / 2, oY: b.tr2x[1] / 2, sX: b.tr2x[2], sY: b.tr2x[3] };
      if (leaves[b.lefmaster]) {
        const L = unpackLeaf(leaves[b.lefmaster]);
        blocks.push({ name: b.name, tr, terminals: L.terminals, subinsts: L.subinsts });
      } else {
        const sub = cap.cases.find((k) => `${k.module}_0` === b.lefmaster);
        if (!sub) { errs.push(`${b.name}: ${b.lefmaster} 의 도형이 없다`); continue; }
        blocks.push({ name: b.name, tr, terminals: sub.terminalsOut });    // 하위 모듈 JSON 에는 subinsts 가 없다
      }
    }
    if (mod && !errs.length) {
      const res = composeModule({ blocks, faMap: faMapOf(mod), powerNets: power });
      const k = res.terminals.length;
      const i = res.terminals.findIndex((t, j) => canon(t) !== canon(c.terminals[j]));
      if (i >= 0) errs.push(`블록 도형 #${i}\n      ALIGN ${canon(c.terminals[i])}\n      JS    ${canon(res.terminals[i])}`);
      if (JSON.stringify(res.subinsts) !== JSON.stringify(c.subinsts))
        errs.push(`subinsts\n      ALIGN ${c.subinsts.join(" ")}\n      JS    ${res.subinsts.join(" ")}`);
      const rest = c.terminals.slice(k);
      const odd = rest.filter((t) => canon(Object.keys(t).sort()) !== canon(["layer", "netName", "netType", "rect"]) || t.netType !== "drawing");
      if (odd.length) errs.push(`배선 도형 ${odd.length} 개가 add_terminal 모양이 아니다: ${canon(odd[0])}`);
      const grid = rest.flatMap((t) => offGrid(t, grids));
      const alignGrid = c.viewerErrors.filter((e) => e.startsWith("Off grid"));
      if (grid.length !== alignGrid.length) errs.push(`격자 오류 ALIGN ${alignGrid.length}, JS ${grid.length}: ${grid[0] ?? alignGrid[0]}`);
      console.log(`${cap.example.padEnd(28)} ${c.module.padEnd(28)} 블록 ${String(c.blocks.length).padStart(2)}  블록 도형 ${String(k).padStart(5)}` +
                  `  배선 도형 ${String(rest.length).padStart(4)}  ${errs.length ? "틀림" : "OK"}`);
    } else console.log(`${cap.example.padEnd(28)} ${c.module.padEnd(28)} 틀림`);
    for (const e of errs) console.log("    " + e);
    n++; if (errs.length) bad++;
  }
}
if (bad) { console.error(`\n${n} 건 중 ${bad} 건 틀림`); process.exit(1); }
console.log(`\n${n} 건 모두 같다`);
