/** src/route/check.mjs 가 ALIGN 의 파이썬 검사기(cell_fabric)와 같은 답을 내는가.
 *
 *  같은 도형을 넣고 SHORT · OPEN · DIFFERENT WIDTH · DRC · 후처리 오류와 정리된 도형을
 *  글자 그대로 맞춰 본다. 파이썬 쪽 답은 symplace/scripts/route/node/checkref.mjs 가 만든다.
 *
 *    1. 저장소의 고정 사례 — fixtures/check-*.json (test/checkcases.mjs 꼴: 바탕 모듈 + 망가뜨리는 조작)
 *    2. 예제 배선 기록 — ~/.cache/symplace/check/<예제>.json (checkref.mjs capture 가 쓴다).
 *       없으면 건너뛴다.
 *
 *  원본이 죽는 입력(비아 밑에 금속이 없음)에서 JS 는 죽지 않고 DRC 오류로 적는다. 그런 사례는
 *  (가) JS 가 그 까닭을 짚었는지, (나) 나머지가 너그러운 파이썬(죽는 두 곳만 고친 것)과 같은지 본다.
 *
 *    node symplace/web/placer/test/check.mjs [파일...]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { check, checkerRules } from "../../../../src/route/check.mjs";
import { MOCK_PDK } from "../../../../src/route/pdk.mjs";
import { FIXTURE_FORMAT, canon, expandCase, summarize } from "./checkcases.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = process.env.SYMPLACE_CACHE ?? path.join(process.env.HOME ?? "", ".cache/symplace");
const J = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const rules = checkerRules(MOCK_PDK);

function firstDiff(name, want, have, show = canon) {
  const i = want.findIndex((w, k) => canon(w) !== canon(have[k]));
  if (want.length === have.length && i < 0) return [];
  const at = i >= 0 ? i : want.length;
  return [`${name}: 파이썬 ${want.length} 건, JS ${have.length} 건, #${at} 부터 다르다` +
          `\n      파이썬 ${want[at] === undefined ? "-" : show(want[at]).slice(0, 300)}` +
          `\n      JS     ${have[at] === undefined ? "-" : show(have[at]).slice(0, 300)}`];
}

/** 원본이 죽은 까닭을 JS 도 짚었는가. */
function sameCause(crash, res, thrown) {
  if (/^AssertionError: netName for pin/.test(crash)) return !!thrown;
  if (thrown) return false;
  if (/^AssertionError/.test(crash)) return res.drc.some((e) => /^No M\d+ metal touching V\d+ /.test(e));
  if (/^KeyError/.test(crash)) return res.drc.some((e) => /No metal found surrounding/.test(e));
  return false;
}

/** @param input 검사기 입력  @param py 파이썬 답 (summarize 꼴)  @param pyOut 파이썬의 정리된 도형 (있으면 틀린 곳을 짚는다) */
function compare(input, py, pyOut) {
  let res, thrown = null;
  try {
    res = check(input.terminals, rules, {
      netsAllowedToBeOpen: input.netsAllowedToBeOpen, postprocess: input.postprocess, subinsts: input.subinsts });
  } catch (e) { thrown = e; }
  const errs = [];
  if (py.crash && !sameCause(py.crash, res, thrown))
    errs.push(`파이썬은 죽었는데 (${py.crash.slice(0, 100)}) JS 는 ${thrown ? "다른 까닭으로 죽었다: " + thrown.message : "그 까닭을 못 짚었다"}`);
  if (!py.crash && thrown) errs.push(`JS 가 죽음: ${thrown.message}`);
  if (thrown || !py.shorts) return errs;
  const js = summarize(res);
  errs.push(
    ...firstDiff("SHORT", py.shorts, js.shorts),
    ...firstDiff("OPEN", py.opens, js.opens),
    ...firstDiff("DIFFERENT WIDTH", py.differentWidths, js.differentWidths),
    ...firstDiff("DRC", py.drc, js.drc, String),
    ...firstDiff("후처리", py.post, js.post, String));
  if (py.out !== js.out)
    errs.push(...(pyOut ? firstDiff("정리된 도형", pyOut, res.terminals) : [`정리된 도형: 파이썬 ${py.nOut} 개, JS ${js.nOut} 개, 지문이 다르다`]));
  return errs;
}

/** 파일 하나 -> [{label, input, py, pyOut?}] */
function casesOf(file) {
  const d = J(file);
  if (d.format === FIXTURE_FORMAT) {
    if (d.results?.length !== d.cases.length) throw new Error(`${file}: 파이썬 답이 비었다 (checkref.mjs check 로 채운다)`);
    return d.cases.map((c, i) => ({ label: c.label, input: expandCase(d.base, c), py: d.results[i] }));
  }
  return d.cases.map((c) => ({ label: c.module, input: c, py: summarize(c), pyOut: c.terminalsOut }));
}

const files = process.argv.slice(2);
if (!files.length) {
  const fx = path.join(HERE, "../fixtures");
  if (fs.existsSync(fx))
    files.push(...fs.readdirSync(fx).filter((f) => /^check-.*\.json$/.test(f)).sort().map((f) => path.join(fx, f)));
  const cap = path.join(CACHE, "check");
  if (fs.existsSync(cap))
    files.push(...fs.readdirSync(cap).filter((f) => f.endsWith(".json")).sort().map((f) => path.join(cap, f)));
  else console.log(`(예제 배선 기록 없음: ${cap} — checkref.mjs capture 로 만든다)`);
}

let bad = 0, n = 0;
for (const f of files) {
  for (const { label, input, py, pyOut } of casesOf(f)) {
    const t0 = performance.now();
    const errs = compare(input, py, pyOut);
    const ms = performance.now() - t0;
    n++;
    if (errs.length) bad++;
    const summary = (py.crash ? "죽음 " : "") + (py.shorts ?
      `S ${py.shorts.length} O ${py.opens.length} W ${py.differentWidths.length} D ${py.drc.length} P ${py.post.length}` : "");
    console.log(`${path.basename(f, ".json").padEnd(28)} ${String(label).padEnd(30)} 도형 ${String(input.terminals.length).padStart(5)}` +
                `  ${summary.padEnd(30)} ${ms.toFixed(0).padStart(4)}ms  ${errs.length ? "틀림" : "OK"}`);
    for (const e of errs) console.log("    " + e);
  }
}
if (!n) { console.error("대조할 사례가 없다"); process.exit(1); }
if (bad) { console.error(`\n${n} 건 중 ${bad} 건 틀림`); process.exit(1); }
console.log(`\n${n} 건 모두 같다`);
