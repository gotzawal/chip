/** src/route/gds.mjs 가 ALIGN 의 파이썬 GDS 경로(gen_gds_json.translate + json2gds)와 같은 바이트를 쓰는가.
 *
 *  고정값 fixtures/gds-*.json: 검사기 고정 사례(fixtures/check-*.json)의 한 사례를 JS 검사기로 정리해
 *  GDS 로 쓰고, 파이썬이 같은 입력으로 쓴 바이트의 sha256 과 맞춘다.
 *
 *    node symplace/web/placer/test/gds.mjs
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { check, checkerRules } from "../../../../src/route/check.mjs";
import { gdsBytes, gdsJson, topGds } from "../../../../src/route/gds.mjs";
import { MOCK_PDK } from "../../../../src/route/pdk.mjs";
import { expandCase } from "./checkcases.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "../fixtures");
const J = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const rules = checkerRules(MOCK_PDK);
let bad = 0, n = 0;
const report = (what, ok, note = "") => { n++; if (!ok) bad++; console.log(`${what.padEnd(52)} ${ok ? "OK" : "틀림"}  ${note}`); };

for (const f of fs.readdirSync(FIX).filter((f) => /^gds-.*\.json$/.test(f)).sort()) {
  const g = J(path.join(FIX, f)), fx = J(path.join(FIX, g.check));
  const input = expandCase(fx.base, fx.cases.find((c) => c.label === g.label));
  const res = check(input.terminals, rules, { netsAllowedToBeOpen: input.netsAllowedToBeOpen, postprocess: input.postprocess, subinsts: input.subinsts });
  const bytes = g.pinSwitch
    ? topGds({ name: g.name, terminals: res.terminals, bbox: g.bbox, time: g.time }, MOCK_PDK)
    : gdsBytes(gdsJson({ name: g.name, terminals: res.terminals, bbox: g.bbox, pinSwitch: false, time: g.time }, MOCK_PDK));
  report(`${f} (${g.name})`, sha(bytes) === g.sha256 && bytes.length === g.bytes, `${bytes.length} 바이트`);
}

if (bad) { console.error(`\n${n} 건 중 ${bad} 건 틀림`); process.exit(1); }
console.log(`\n${n} 건 모두 같다`);
