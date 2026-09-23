/** 배선 기록의 모듈 하나를 바탕으로 일부러 망가뜨린 사례들을 만든다 — 검사기 대조용.
 *
 *    node mutate.mjs <예제> <모듈> <출력.json> [--seed=N] [--each=N]
 *
 *  ~/.cache/symplace/check/<예제>.json (checkref.mjs capture) 에서 모듈을 꺼내
 *  symplace/web/placer/fixtures/check-<이름>.json 꼴(test/checkcases.mjs)로 쓴다. 파이썬 답은 비어 있다 —
 *  node checkref.mjs check <출력.json> <출력.json> 으로 채운다.
 *
 *  조작은 난수로 고르지만 고른 결과를 글자로 적어 두므로 사례는 씨앗과 무관하게 재현된다.
 */
import fs from "node:fs";
import path from "node:path";
import { WORK_CACHE } from "./align.mjs";
import { FIXTURE_FORMAT, toRow } from "../../../web/placer/test/checkcases.mjs";
import { MOCK_PDK } from "../../../../src/route/pdk.mjs";

const args = process.argv.slice(2);
const opt = (k) => (args.find((a) => a.startsWith(`--${k}=`)) ?? "").slice(k.length + 3) || null;
const [ex, mod, outFile] = args.filter((a) => !a.startsWith("--"));
if (!outFile) { console.error("사용법: node mutate.mjs <예제> <모듈> <출력.json> [--seed=N] [--each=N]"); process.exit(2); }

const cap = JSON.parse(fs.readFileSync(path.join(WORK_CACHE, "check", ex + ".json"), "utf8"));
const src = cap.cases.find((c) => c.module === mod);
if (!src) { console.error(`${mod} 가 없다: ${cap.cases.map((c) => c.module).join(", ")}`); process.exit(2); }

// mulberry32
let s = Number(opt("seed") ?? 1) >>> 0;
const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const each = Number(opt("each") ?? 3);

const rows = src.terminals.map(toRow);
const info = Object.fromEntries(MOCK_PDK.Abstraction.map((L) => [L.Layer, L]));
const dirOf = (ly) => info[ly]?.Direction?.toLowerCase();
const idx = (pred) => rows.map((r, i) => (pred(r) ? i : -1)).filter((i) => i >= 0);
const isMetal = (ly) => /^M\d+$/.test(ly), isVia = (ly) => /^V[1-9]\d*$/.test(ly);
const nets = [...new Set(rows.map((r) => r[1]).filter((n) => n && !n.includes(":")))];
const wires = idx((r) => isMetal(r[0]) && r[1] && !r[1].includes(":"));
const vias = idx((r) => isVia(r[0]));
const contacts = idx((r) => r[0] === "V0" && r[1]?.includes(":"));
const pins = idx((r) => r[2] === "pin");
const longWires = wires.filter((i) => { const [ly, , , x0, y0, x1, y1] = rows[i]; return (dirOf(ly) === "h" ? x1 - x0 : y1 - y0) > 2 * info[ly].MinL; });

/** 비아가 앉은 금속 (touching, 같은 중심선) */
function metalUnder(vi, ly) {
  const [, , , x0, y0, x1, y1] = rows[vi];
  return idx((r) => r[0] === ly && !(r[5] < x0 || x1 < r[3] || r[6] < y0 || y1 < r[4]) &&
    (dirOf(ly) === "h" ? r[4] + r[6] === y0 + y1 : r[3] + r[5] === x0 + x1));
}

const kinds = {
  "넷 바꿈": () => { const i = pick(wires); return [{ op: "net", i, net: pick(nets.filter((n) => n !== rows[i][1])) }]; },
  "넷 지움": () => [{ op: "net", i: pick(wires), net: null }],
  "단자 바꿈": () => {
    const i = pick(contacts), [inst] = rows[i][1].split(":");
    const others = [...new Set(contacts.map((k) => rows[k][1]).filter((n) => n.startsWith(inst + ":") && n !== rows[i][1]))];
    return [{ op: "net", i, net: others.length ? pick(others) : inst + ":ZZ" }];
  },
  "비아 지움": () => [{ op: "del", i: pick(vias) }],
  "핀 지움": () => [{ op: "del", i: pick(pins) }],
  "비아 밀기": () => [{ op: "move", i: pick(vias), dx: pick([0, -4, 4, 10]), dy: pick([-10, -6, 6, 10, 30]) }],
  "선 밀기": () => {
    const i = pick(wires), d = pick([-12, -4, 4, 12, 20]);
    return [{ op: "move", i, dx: dirOf(rows[i][0]) === "v" ? d : 0, dy: dirOf(rows[i][0]) === "h" ? d : 0 }];
  },
  "선 줄이기": () => {
    const i = pick(wires), [ly, , , x0, y0, x1, y1] = rows[i], L = info[ly].MinL - 20;
    return [{ op: "rect", i, rect: dirOf(ly) === "h" ? [x0, y0, x0 + L, y1] : [x0, y0, x1, y0 + L] }];
  },
  "선 끊기": () => {
    const i = pick(longWires.length ? longWires : wires), [ly, n, t, x0, y0, x1, y1] = rows[i];
    const gap = pick([10, 20, info[ly].EndToEnd - 2, info[ly].EndToEnd]);
    if (dirOf(ly) === "h") { const m = Math.round((x0 + x1) / 2); return [{ op: "rect", i, rect: [x0, y0, m, y1] }, { op: "add", row: [ly, n, t, m + gap, y0, x1, y1] }]; }
    const m = Math.round((y0 + y1) / 2);
    return [{ op: "rect", i, rect: [x0, y0, x1, m] }, { op: "add", row: [ly, n, t, x0, m + gap, x1, y1] }];
  },
  "폭 바꿈": () => {
    const i = pick(wires), [ly, , , x0, y0, x1, y1] = rows[i], w = pick([4, 8]);
    return [{ op: "rect", i, rect: dirOf(ly) === "h" ? [x0, y0 - w, x1, y1 + w] : [x0 - w, y0, x1 + w, y1] }];
  },
  "비아 곁 비아": () => {
    const i = pick(vias), [ly, n, t, x0, y0, x1, y1] = rows[i], d = pick([8, 20, 40, 80]);
    return [{ op: "add", row: [ly, n, t, x0, y1 + d, x1, y1 + d + (y1 - y0)] }, { op: "add", row: [ly, n, t, x1 + d, y0, x1 + d + (x1 - x0), y1] }];
  },
  "막음": () => [{ op: "type", i: pick(wires), type: "blockage" }],
  "비아 밑 금속 지움": () => {
    for (let k = 0; k < 50; k++) {
      const vi = pick(vias), ly = pick(info[rows[vi][0]].Stack), under = metalUnder(vi, ly);
      if (under.length) return under.map((i) => ({ op: "del", i }));
    }
    return [{ op: "del", i: pick(vias) }];
  },
  "선 옮겨 붙이기": () => {             // 다른 넷의 선 위로 겹치게 옮긴다
    const i = pick(wires), [ly] = rows[i], j = pick(wires.filter((k) => rows[k][0] === ly && rows[k][1] !== rows[i][1]));
    return j === undefined ? [] : [{ op: "rect", i, rect: rows[j].slice(3) }];
  },
};

const cases = [];
for (const [name, gen] of Object.entries(kinds))
  for (let k = 0; k < each; k++) cases.push({ label: `${name} ${k + 1}`, ops: gen() });
for (let k = 0; k < each * 2; k++) {
  const names = Object.keys(kinds), ops = [];
  for (let m = 0; m < 3 + Math.floor(rnd() * 4); m++) ops.push(...kinds[pick(names)]());
  // 같은 줄을 지우고 또 고치는 조합은 걸러낸다 (지운 뒤의 조작은 뜻이 없다)
  const dead = new Set(ops.filter((o) => o.op === "del").map((o) => o.i));
  cases.push({ label: `섞음 ${k + 1}`, ops: ops.filter((o) => o.op === "del" || o.op === "add" || !dead.has(o.i)) });
}
// 열려도 되는 넷 — 비아를 지워 연 뒤 그 넷을 허락한다
for (let k = 0; k < each; k++) {
  const i = pick(vias);
  cases.push({ label: `열려도 됨 ${k + 1}`, ops: [{ op: "del", i }], netsAllowedToBeOpen: [...new Set([...src.netsAllowedToBeOpen, rows[i][1]])].filter(Boolean).sort() });
}
cases.push({ label: "그대로", ops: [] });
cases.push({ label: "그대로 후처리 반대", ops: [], postprocess: !src.postprocess });

const fx = {
  format: FIXTURE_FORMAT, source: `${ex} ${mod}`,
  base: { rows, subinsts: src.subinsts, netsAllowedToBeOpen: src.netsAllowedToBeOpen, postprocess: src.postprocess },
  cases, results: [],
};
fs.writeFileSync(outFile, JSON.stringify(fx));
console.log(`${cases.length} 사례 -> ${outFile}`);
