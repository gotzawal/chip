/** 회로도·묶음 배열 — 예제 전부에서 넷리스트와 앞단 출력을 읽어 배열하고 불변식을 본다.
 *
 *  보는 것
 *    - .sp 를 읽어 만든 회로의 소자 수가 넷리스트의 소자 줄 수와 같다 (계층을 펼쳐서)
 *    - 앞단 출력의 잎 트랜지스터가 .sp 소자에 거의 다 맞춰진다 (adoptGroups)
 *    - 좌표가 전부 유한하고, 기호끼리 겹치지 않는다
 *    - 핀마다 그 넷의 선이 단자에 닿는다
 *    - 거울 쌍은 축에 대해 정확히 대칭이고, 묶음 테두리는 소자를 다 담는다
 *
 *  실행:  node symplace/web/placer/test/schematic.mjs [예제 ...]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpice } from "../../../../src/schematic/spice.mjs";
import { circuitFromSpice, circuitFromTopology, adoptGroups, supplyHints, describeBlocks } from "../../../../src/schematic/circuit.mjs";
import { layoutCircuit, ROW } from "../../../../src/schematic/layout.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..", "..");
const all = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "index.json"), "utf8")).map((x) => x.name);
const names = process.argv.slice(2).length ? process.argv.slice(2) : all;

let fails = 0;
const bad = (name, msg) => { fails++; console.log(`  실패 [${name}] ${msg}`); };

/** 넷리스트의 소자 줄 수 — 계층을 펼쳐서 (X 는 그 서브서킷의 소자 수로). */
function countDevices(parsed, sub, seen = new Set()) {
  const s = parsed.subckts.get(sub);
  if (!s || seen.has(sub)) return 0;
  let n = 0;
  for (const d of s.devices) n += d.type === "X" && parsed.subckts.has(d.model) ? countDevices(parsed, d.model, new Set([...seen, sub])) : 1;
  return n;
}

function check(name, tag, c, lay) {
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  for (const d of lay.devices)
    if (![d.x, d.y, d.hw, d.hh].every(Number.isFinite)) bad(name, `${tag} ${d.name} 좌표가 유한하지 않다`);
  for (let i = 0; i < lay.devices.length; i++)
    for (let j = i + 1; j < lay.devices.length; j++) {
      const a = lay.devices[i], b = lay.devices[j];
      if (Math.abs(a.x - b.x) < a.hw + b.hw - 1 && Math.abs(a.y - b.y) < a.hh + b.hh - 1)
        bad(name, `${tag} 기호가 겹친다: ${a.name} (${a.x.toFixed(0)},${a.y.toFixed(0)}) 와 ${b.name} (${b.x.toFixed(0)},${b.y.toFixed(0)})`);
    }
  const segsOf = new Map(lay.nets.map((n) => [n.name, n.segs]));
  for (const d of lay.devices)
    for (const p of d.pins) {
      const segs = segsOf.get(p.net) ?? [];
      const touches = segs.some((s) => (near(s[0], p.x) && near(s[1], p.y)) || (near(s[2], p.x) && near(s[3], p.y)));
      if (!touches) bad(name, `${tag} ${d.name}.${p.name} (넷 ${p.net}) 에 선이 닿지 않는다`);
    }
  // 거울 쌍: x 는 정확히 대칭. y 는 같아야 하되, 구조가 달라 다른 단에 놓인 쌍(한 단의 1/3 넘게 차이)은 봐준다 —
  // 조금 어긋난 것(스프링이 양쪽을 따로 푼 흔적)은 안 된다
  for (const [a, b] of c.mirrors) {
    const A = lay.devices[a], B = lay.devices[b];
    const dy = Math.abs(A.y - B.y);
    if (!near(A.x + B.x, 0) || (dy > 1e-6 && dy < ROW / 3))
      bad(name, `${tag} 거울 쌍이 대칭이 아니다: ${A.name} (${A.x.toFixed(0)},${A.y.toFixed(0)}) ${B.name} (${B.x.toFixed(0)},${B.y.toFixed(0)})`);
  }
  for (const h of lay.hulls) {
    const g = c.groups[h.id];
    for (const m of g.members) {
      const d = lay.devices[m];
      if (d.x - d.hw < h.x0 || d.x + d.hw > h.x1 || d.y - d.hh < h.y0 || d.y + d.hh > h.y1)
        bad(name, `${tag} 묶음 ${g.name} 이 ${d.name} 을 못 담는다`);
    }
  }
  for (const n of lay.nets)
    for (const s of n.segs)
      if (!s.every(Number.isFinite)) bad(name, `${tag} 넷 ${n.name} 의 선 좌표가 유한하지 않다`);
}

for (const name of names) {
  const t0 = performance.now();
  const blob = JSON.parse(fs.readFileSync(path.join(ROOT, "data", name + ".json"), "utf8"));
  const text = fs.readFileSync(path.join(ROOT, "netlists", name + ".sp"), "utf8");
  const parsed = parseSpice(text);
  const topo = circuitFromTopology(blob);
  const sp = circuitFromSpice(parsed, topo.name, { hints: supplyHints(blob) });
  const expect = countDevices(parsed, sp.name);
  if (sp.devices.length !== expect) bad(name, `.sp 소자 ${sp.devices.length} 개, 넷리스트 줄로는 ${expect} 개`);
  if (sp.name !== topo.name) bad(name, `최상위가 다르다: .sp ${sp.name}, 앞단 ${topo.name}`);
  const m = adoptGroups(sp, topo);
  const lg = layoutCircuit(topo), ls = layoutCircuit(sp);
  const blocks = describeBlocks(blob, topo);
  check(name, "묶음", topo, lg);
  check(name, "회로도", sp, ls);
  if (m.matched < m.total * 0.85) bad(name, `앞단 잎 ${m.total} 중 ${m.matched} 만 .sp 소자에 맞췄다`);
  if (!blocks.length) bad(name, "블록 표가 비었다");
  const ms = (performance.now() - t0).toFixed(0);
  console.log(`${name.padEnd(36)} .sp ${String(sp.devices.length).padStart(3)} 소자 ${String(ls.stats.columns).padStart(3)} 열${ls.stats.symmetric ? " 대칭" : "    "}` +
              ` ${String(Math.round(ls.bbox[2] - ls.bbox[0])).padStart(5)}×${String(Math.round(ls.bbox[3] - ls.bbox[1])).padEnd(4)}` +
              ` | 앞단 ${String(topo.devices.length).padStart(3)} 소자 ${String(topo.groups.filter((g) => g.hull).length).padStart(3)} 묶음 ${String(blocks.length).padStart(3)} 블록` +
              ` | 맞춤 ${m.matched}/${m.total} | ${ms} ms`);
}
console.log(fails ? `\n실패 ${fails} 건` : "\n통과");
process.exit(fails ? 1 : 0);
