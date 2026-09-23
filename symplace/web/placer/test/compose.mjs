/** src/route/compose.mjs 의 격자 검사(offGrid)가 ALIGN 의 gen_viewer_json 과 같은 문구를 내는가.
 *
 *  fixtures/grid.json: 여러 층·여러 자리의 배선 도형에 ALIGN 의 add_terminal 격자 검사가 찍는 문구와
 *  offGrid 의 문구가 글자 그대로 같다. 블록 도형을 모으는 쪽(composeModule)은 배선 한 판이 쓴다.
 *
 *    node symplace/web/placer/test/compose.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { metalGrids, offGrid } from "../../../../src/route/compose.mjs";
import { MOCK_PDK } from "../../../../src/route/pdk.mjs";
import { canon } from "./checkcases.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const J = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const grids = metalGrids(MOCK_PDK);

let bad = 0, n = 0;

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

if (bad) { console.error(`\n${n} 건 중 ${bad} 건 틀림`); process.exit(1); }
console.log(`\n${n} 건 모두 같다`);
