/** data/<예제>.leaves.json 이 예제 파일과 어긋나지 않는가.
 *
 *    1. 리프가 예제의 primitives 와 같은 이름들이다
 *    2. bbox 와 핀(netType "pin")이 예제의 templates 와 같다 — 배치기가 본 것과 같은 리프다
 *    3. 풀고(unpackLeaf) 다시 묶으면(packLeaf) 같다
 *    4. subinsts 이름들이 V0 접점의 단자 이름들과 같은 집합이다
 *
 *    node symplace/web/placer/test/leaves.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLeaves, unpackLeaf, packLeaf } from "../../../../src/route/leaves.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const J = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const key = (t) => JSON.stringify([t.netName, t.layer, t.rect]);

let bad = 0;
const rows = J(path.join(ROOT, "data/index.json")).map((x) => (typeof x === "string" ? { name: x } : x));
for (const { name } of rows) {
  const lp = path.join(ROOT, "data", name + ".leaves.json");
  if (!fs.existsSync(lp)) { console.log(`${name.padEnd(28)} 리프 도형 없음 (배선 안 됨)`); continue; }
  const ex = J(path.join(ROOT, "data", name + ".json"));
  const leaves = readLeaves(J(lp));
  const errs = [];
  const want = Object.keys(ex.primitives).sort(), have = Object.keys(leaves).sort();
  if (JSON.stringify(want) !== JSON.stringify(have)) errs.push(`이름이 다르다: ${want.length} vs ${have.length}`);
  let shapes = 0;
  for (const [cn, tpl] of Object.entries(ex.templates)) {
    const e = leaves[cn];
    if (!e) continue;
    const L = unpackLeaf(e);
    shapes += L.terminals.length;
    if (JSON.stringify(L.bbox) !== JSON.stringify(tpl.bbox)) errs.push(`${cn}: bbox`);
    const pins = L.terminals.filter((t) => t.netType === "pin" && t.netName).map(key).sort();
    const mine = tpl.terminals.map(key).sort();
    if (JSON.stringify(pins) !== JSON.stringify(mine)) errs.push(`${cn}: 핀이 다르다`);
    const again = packLeaf({ ...L, subinsts: Object.fromEntries(L.subinsts.map((k) => [k, {}])) });
    if (JSON.stringify(again) !== JSON.stringify(e)) errs.push(`${cn}: 왕복이 안 맞는다`);
    const inV0 = new Set(L.terminals.filter((t) => t.terminal).map((t) => t.terminal[0]));
    if (L.subinsts.length !== inV0.size || !L.subinsts.every((k) => inV0.has(k))) errs.push(`${cn}: subinsts 가 V0 단자와 다르다`);
  }
  bad += errs.length;
  console.log(`${name.padEnd(28)} 리프 ${have.length} 종, 도형 ${shapes}  ` +
              (errs.length ? "틀림\n    " + errs.slice(0, 6).join("\n    ") : "OK"));
}
if (bad) { console.error(`\n${bad} 건 틀림`); process.exit(1); }
