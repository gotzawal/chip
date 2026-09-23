/** alignroute.wasm (ALIGN 배선기를 Rust 로 옮긴 것) 을 기준 덤프와 단계별로 견준다.
 *
 *  기준 덤프는 ALIGN 을 node 에서 돌리며 RouteWork 호출마다 앞뒤 hierNode 를 뜬 것이다
 *  (symplace/scripts/route/align-ref/tap/runall.mjs -> ~/.cache/symplace/tap/<예제>/<배치>/).
 *  같은 입력을 Rust 에 넣고, 배선기가 쓴 필드("기록", src/route/align/records.mjs)를 견준다.
 *
 *    echo   배선 없이 덤프를 읽고 도로 쓴다 — 자료형이 덤프를 빠짐없이 읽고 쓰는가
 *    4      모드 4 (전역 배선)            m4 입력 -> m4 출력
 *    45     모드 4 + 5 (상세 배선)        m4 입력 -> m4, m5 출력
 *    2      모드 2 (전원 격자)            m2 입력 -> m2 출력              (최상위만)
 *    23     모드 2 + 3 (전원 배선)        m2 입력 -> m2, m3 출력          (최상위만)
 *
 *    node symplace/web/placer/test/alignroute.mjs [--stage=echo,4,45,2,23] [--ex=예제] [--tag=align|ours] [-v]
 *                                                  [--tap=<덤프 뿌리, 기본 ~/.cache/symplace/tap>] [--wasm=<파일>]
 *
 *  합격: 고른 단계가 전부 "같다". 아직 안 옮긴 모드는 "없음" 으로 적고 실패로 센다
 *  (--allow-missing 이면 넘긴다).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAlignRouter } from "../../../../src/route/alignroute.mjs";
import { recordOf, diffRecord, MODES } from "../../../../src/route/align/records.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const CACHE = process.env.SYMPLACE_CACHE ?? path.join(process.env.HOME ?? "", ".cache/symplace");
const args = process.argv.slice(2);
const opt = (k, d) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const verbose = args.includes("-v");
const allowMissing = args.includes("--allow-missing");
const stages = opt("stage", "echo,4,45,2,23").split(",");
const J = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

const router = await loadAlignRouter(fs.readFileSync(opt("wasm", path.join(ROOT, "src/route/alignroute.wasm"))));
const TAP = opt("tap", path.join(CACHE, "tap"));
if (!fs.existsSync(TAP)) {
  console.error(`기준 덤프가 없다: ${TAP}\n  node symplace/scripts/route/align-ref/tap/runall.mjs 를 먼저 돌린다`);
  process.exit(2);
}

let bad = 0, missing = 0, n = 0;
const tally = {};
for (const ex of fs.readdirSync(TAP).sort()) {
  if (opt("ex") && opt("ex") !== ex) continue;
  for (const tag of fs.readdirSync(path.join(TAP, ex)).sort()) {
    if (opt("tag") && opt("tag") !== tag) continue;
    const dir = path.join(TAP, ex, tag);
    if (!fs.existsSync(path.join(dir, "calls.json"))) continue;
    const calls = J(path.join(dir, "calls.json"));
    const drc = J(path.join(dir, "drc.json"));
    const file = (c, io) => path.join(dir, `${String(c.k).padStart(2, "0")}_${c.node}_m${c.mode}_${io}.json`);
    const skip = [drc.Design_info.h_skip_factor, drc.Design_info.v_skip_factor];
    // 모듈마다 부른 순서대로
    const mods = [];
    for (const c of calls) {
      if (!mods.length || mods.at(-1).name !== c.node || mods.at(-1).calls.some((d) => d.mode === c.mode)) mods.push({ name: c.node, calls: [] });
      mods.at(-1).calls.push(c);
    }
    for (const m of mods) {
      const by = Object.fromEntries(m.calls.map((c) => [c.mode, c]));
      const job = (node, modes, extra = {}) => ({
        drc, node, modes, skip,
        signal: by[4] ? [by[4].Lmetal, by[4].Hmetal] : [0, 0],
        powerGrid: by[2] ? [by[2].Lmetal, by[2].Hmetal] : [0, 0],
        powerRouting: by[3] ? [by[3].Lmetal, by[3].Hmetal] : [0, 0],
        ...extra,
      });
      const plan = [];
      for (const st of stages) {
        if (st === "echo") for (const c of m.calls) plan.push({ st: `echo${c.mode}`, job: job(J(file(c, "out")), [], { echo: [c.mode] }), want: [[c.mode, file(c, "out")]] });
        if (st === "4" && by[4]) plan.push({ st, job: job(J(file(by[4], "in")), [4]), want: [[4, file(by[4], "out")]] });
        if (st === "45" && by[4] && by[5]) plan.push({ st, job: job(J(file(by[4], "in")), [4, 5]), want: [[4, file(by[4], "out")], [5, file(by[5], "out")]] });
        if (st === "2" && by[2]) plan.push({ st, job: job(J(file(by[2], "in")), [2]), want: [[2, file(by[2], "out")]] });
        if (st === "23" && by[2] && by[3]) plan.push({ st, job: job(J(file(by[2], "in")), [2, 3]), want: [[2, file(by[2], "out")], [3, file(by[3], "out")]] });
      }
      for (const { st, job: jb, want } of plan) {
        n++;
        let res, err = null;
        try { res = await router.route(jb); } catch (e) { err = e.message; }
        const where = `${ex.padEnd(27)} ${tag.padEnd(5)} ${m.name.padEnd(28)} ${st.padEnd(6)}`;
        const t = (tally[st] ??= { same: 0, diff: 0, none: 0 });
        if (err) {
          const nyi = /아직 옮기지 않았다/.test(err);
          if (nyi) { missing++; t.none++; } else { bad++; t.diff++; }
          if (!nyi || verbose) console.log(`${where} ${nyi ? "없음" : "오류"}  ${err.slice(0, 160)}`);
          continue;
        }
        const lines = [];
        let diff = 0;
        for (const [mode, f] of want) {
          const rec = res.records.find((r) => r.mode === mode);
          const d = diffRecord(rec?.out, recordOf(J(f), mode), 8);
          if (d.count) {
            diff += d.count;
            lines.push(`    모드 ${mode} (${MODES[mode]}) ${d.count} 곳 다름`);
            if (verbose) for (const x of d.first) lines.push(`      ${x.path}: ${x.a}  /  ALIGN ${x.b}`);
          }
        }
        const ms = res.records.filter((r) => !/^echo/.test(st)).map((r) => `${r.mode}:${r.ms.toFixed(0)}ms`).join(" ");
        if (diff) { bad++; t.diff++; } else t.same++;
        if (diff || verbose) console.log(`${where} ${diff ? "다름" : "같음"}  ${ms}`);
        for (const l of lines) console.log(l);
      }
    }
  }
}
const sum = Object.entries(tally).map(([k, v]) => `${k}: 같음 ${v.same}` + (v.diff ? ` 다름 ${v.diff}` : "") + (v.none ? ` 없음 ${v.none}` : "")).join(" | ");
console.log(`\n${n} 건 — ${sum}`);
if (bad || (missing && !allowMissing)) process.exit(1);
