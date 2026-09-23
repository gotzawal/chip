/** 배선 한 판 (src/route/pipeline.mjs — 페이지의 "배선 · Rust 이식" 이 부르는 것) 이 ALIGN 과 같은가.
 *
 *  예제마다 (우리 배치, ALIGN 배치) 로 돌리고, ALIGN 이 같은 배치로 낸 것과 견준다:
 *    모듈마다   검사기가 낸 도형 == <모듈>_<j>.json 의 terminals (차례까지), bbox
 *    최상위     GDS JSON == <TOP>_0.python.gds.json (시각만 빼고) — 바이트는 gdsBytes 가 같은 차례로 쓴다
 *    오류       DRC/LVS 문구 == pyroute.py 가 모은 3_pnr/*.errors (앞 40 줄과 개수)
 *    단계 기록   (--router=wasm) Rust 배선기의 기록 == 탭 덤프의 m*_out (records.mjs compareRuns)
 *
 *  배선기: --router=tap (기본) 은 ALIGN 이 낸 기록(탭 덤프)을 그대로 돌려주는 가짜다 — 배선기 밖의 모든 것
 *  (입력, 계층, 도형 모으기, 검사, GDS)을 본다. --router=wasm 은 src/route/alignroute.wasm (Rust 이식) 으로 끝까지.
 *
 *    node symplace/web/placer/test/route.mjs [--ex=예제] [--tag=ours|align|<설정>] [--router=tap|wasm] [--wasm=<파일>]
 *                                            [--tap=<뿌리> | --root=<뿌리>] [-v]
 *
 *  기준: ~/.cache/symplace/tap/<예제>/<ours|align>/ (align-ref/tap/runall.mjs — calls.json, m*_out, result.json),
 *        ~/.cache/symplace/aligndb/<예제>/<ours|align>/align_*.json (align-ref/db/dumphn.mjs).
 *  --tap=~/.cache/symplace/tap-vary 는 흔든 배치 (align-ref/tap/vary.mjs): 배치는 그 폴더의 placement.json 이고
 *  최종 도형 기준(aligndb)이 없어 오류 문구와 단계 기록만 견준다.
 *  --root=<뿌리> 는 align-ref/db/refrun.mjs 가 한 뿌리에 모은 경우 (제약을 바꾼 앞단 등): <뿌리>/data 의 예제,
 *  <뿌리>/place-<예제>.json, <뿌리>/tap, <뿌리>/aligndb.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareRuns, recordOf } from "../../../../src/route/align/records.mjs";
import { loadAlignRouter } from "../../../../src/route/alignroute.mjs";
import { gdsJson } from "../../../../src/route/gds.mjs";
import { placementFromAlign } from "../../../../src/route/hier.mjs";
import { MOCK_PDK } from "../../../../src/route/pdk.mjs";
import { routeDesign } from "../../../../src/route/pipeline.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const CACHE = process.env.SYMPLACE_CACHE ?? path.join(process.env.HOME ?? "", ".cache/symplace");
const args = process.argv.slice(2);
const opt = (k, d) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const verbose = args.includes("-v");
const J = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const home = (p) => p.replace(/^~(?=\/|$)/, process.env.HOME ?? "");

const RROOT = opt("root") ? path.resolve(home(opt("root"))) : null;
const TAP = RROOT ? path.join(RROOT, "tap") : path.resolve(home(opt("tap", path.join(CACHE, "tap"))));
const DB = RROOT ? path.join(RROOT, "aligndb") : TAP === path.join(CACHE, "tap") ? path.join(CACHE, "aligndb") : null;
const DATA = RROOT ? path.join(RROOT, "data") : path.join(ROOT, "data");
const PLACE = RROOT ?? CACHE;
const useWasm = opt("router", "tap") === "wasm";
const wasmPath = opt("wasm") ? path.resolve(home(opt("wasm"))) : path.join(ROOT, "src/route/alignroute.wasm");
const wasm = useWasm || opt("wasm") ? await loadAlignRouter(fs.readFileSync(wasmPath)) : null;

/** 탭 덤프의 호출을 모듈마다 묶는다 (같은 모듈의 같은 모드가 또 나오면 다음 모듈) */
function tapModules(dir) {
  const calls = J(path.join(dir, "calls.json"));
  const file = (c, io) => path.join(dir, `${String(c.k).padStart(2, "0")}_${c.node}_m${c.mode}_${io}.json`);
  const mods = [];
  for (const c of calls) {
    if (!mods.length || mods.at(-1).name !== c.node || mods.at(-1).calls.some((d) => d.mode === c.mode)) mods.push({ name: c.node, calls: [] });
    mods.at(-1).calls.push(c);
  }
  const records = mods.flatMap((m) => m.calls.map((c) => ({ module: m.name, mode: c.mode, out: recordOf(J(file(c, "out")), c.mode) })));
  return { mods, records };
}

/** 가짜 배선기 — 모듈 #k 에 ALIGN 이 낸 기록을 돌려준다 */
function tapRouter(recs) {
  let k = 0;
  const groups = [];
  for (const r of recs) {
    if (!groups.length || groups.at(-1)[0].module !== r.module || groups.at(-1).some((x) => x.mode === r.mode)) groups.push([]);
    groups.at(-1).push(r);
  }
  return {
    async route(job) {
      const g = groups[k++];
      if (!g) throw new Error(`기준에 없는 배선 호출 ${job.node.name}`);
      if (g[0].module !== job.node.name) throw new Error(`모듈 차례: ALIGN ${g[0].module} / JS ${job.node.name}`);
      return { records: job.modes.map((mode) => {
        const r = g.find((x) => x.mode === mode);
        if (!r) throw new Error(`${job.node.name}: 모드 ${mode} 기록이 기준에 없다`);
        return { module: r.module, mode, ms: 0, out: structuredClone(r.out) };
      }), warnings: [] };
    },
  };
}

const tkey = (t) => JSON.stringify([t.layer, t.netName ?? null, t.netType, t.rect, t.terminal ?? null, t.color ?? null]);
/** 도형 목록 두 개 — 차례까지. 처음 다른 자리와 개수 차 */
function diffTerms(mine, ref) {
  const a = mine.map(tkey), b = ref.map(tkey);
  if (a.length === b.length && a.every((x, i) => x === b[i])) return null;
  const i = a.findIndex((x, j) => x !== b[j]);
  const ms = new Map();
  for (const x of a) ms.set(x, (ms.get(x) ?? 0) + 1);
  for (const x of b) ms.set(x, (ms.get(x) ?? 0) - 1);
  const onlyA = [...ms].filter(([, n]) => n > 0).reduce((s, [, n]) => s + n, 0);
  const onlyB = [...ms].filter(([, n]) => n < 0).reduce((s, [, n]) => s - n, 0);
  return `도형 ${a.length} / ALIGN ${b.length}, 차례 ${i} 부터 다름 (${a[i] ?? "없음"} / ALIGN ${b[i] ?? "없음"}), ` +
         `우리만 ${onlyA} ALIGN 만 ${onlyB}`;
}
const noTime = (g) => { const c = structuredClone(g); for (const l of c.bgnlib) { l.time = null; for (const s of l.bgnstr) s.time = null; } return c; };

const index = RROOT ? fs.readdirSync(TAP).sort() : J(path.join(ROOT, "data/index.json")).map((x) => (typeof x === "string" ? x : x.name));
let bad = 0, runs = 0, alignDead = 0;
for (const ex of index) {
  if (opt("ex") && opt("ex") !== ex) continue;
  const exDir = path.join(TAP, ex);
  if (!fs.existsSync(exDir) || !fs.existsSync(path.join(DATA, ex + ".leaves.json"))) continue;
  const design = J(path.join(DATA, ex + ".json"));
  const leaves = J(path.join(DATA, ex + ".leaves.json"));
  for (const tag of fs.readdirSync(exDir).sort()) {
    if (opt("tag") && opt("tag") !== tag) continue;
    const dir = path.join(exDir, tag);
    const alignFailed = !fs.existsSync(path.join(dir, "calls.json")) && fs.existsSync(path.join(dir, "result.json")) &&
      J(path.join(dir, "result.json")).ok === false;
    if (!fs.existsSync(path.join(dir, "calls.json")) && !alignFailed) continue;
    const pf = fs.existsSync(path.join(dir, "placement.json")) ? path.join(dir, "placement.json")
      : tag === "ours" ? path.join(PLACE, `place-${ex}.json`) : null;
    const placement = pf ? (fs.existsSync(pf) ? J(pf) : null) : tag === "align" ? placementFromAlign(design.place) : null;
    const head = `${ex.padEnd(27)} ${tag.padEnd(16)}`;
    if (!placement) { console.log(`${head} (배치가 없다)`); continue; }
    if (alignFailed) {
      // ALIGN 자신이 죽은 배치 — 견줄 기준이 없다. Rust 이식이 어떻게 하는지만 적는다 (다름으로 세지 않는다).
      const why = J(path.join(dir, "result.json")).error;
      if (!wasm) { console.log(`${head} ALIGN 이 죽은 배치 (${why}) — --router=wasm 으로 Rust 쪽을 본다`); continue; }
      let note;
      try {
        const o = await routeDesign({ design: { topology: design.topology, primitives: design.primitives }, leaves, placement, router: wasm });
        note = `Rust 이식은 끝까지 간다 (DRC/LVS ${o.errors.length})`;
      } catch (e) { note = `Rust 이식도 멈춘다: ${e.message.split("\n")[0].slice(0, 120)}`; }
      console.log(`${head} ALIGN 이 죽은 배치 (${why}) — ${note}`);
      alignDead++;
      continue;
    }
    runs++;
    const tap = tapModules(dir);
    const router = wasm ?? tapRouter(tap.records);
    const errs = [];
    let out;
    const t0 = performance.now();
    try {
      out = await routeDesign({ design: { topology: design.topology, primitives: design.primitives }, leaves, placement, router });
    } catch (e) {
      bad++;
      console.log(`${head} 오류  ${e.stack.split("\n").slice(0, 3).join(" | ")}`);
      continue;
    }
    const ms = performance.now() - t0;

    // 모듈마다 검사기 출력과 bbox (aligndb 에 ALIGN 의 <모듈>_<j>.json 이 있으면)
    const dbDir = DB && path.join(DB, ex, tag);
    let nMod = 0;
    if (dbDir && fs.existsSync(dbDir)) {
      for (const [variant, c] of out.outputs) {
        const f = path.join(dbDir, `align_${variant}.json`);
        if (!fs.existsSync(f)) { errs.push(`${variant}: ALIGN 출력이 없다`); continue; }
        const ref = J(f);
        const isTop = variant === `${out.name}_0`;
        const mine = isTop ? out.geo.terminals : c.terminals;
        const d = diffTerms(mine, ref.terminals);
        if (d) errs.push(`${variant}: ${d}`);
        if (JSON.stringify(c.bbox) !== JSON.stringify(ref.bbox)) errs.push(`${variant}: bbox ${c.bbox} / ALIGN ${ref.bbox}`);
        nMod++;
      }
      const gf = path.join(dbDir, `align_${out.name}_0.python.gds.json`);
      if (fs.existsSync(gf)) {
        const top = out.outputs.get(`${out.name}_0`);
        const mine = gdsJson({ name: out.name, terminals: out.geo.terminals, bbox: top.bbox, pinSwitch: true }, MOCK_PDK);
        if (JSON.stringify(noTime(mine)) !== JSON.stringify(noTime(J(gf)))) {
          const a = noTime(mine).bgnlib[0].bgnstr[0].elements, b = noTime(J(gf)).bgnlib[0].bgnstr[0].elements;
          const i = a.findIndex((e, j) => JSON.stringify(e) !== JSON.stringify(b[j]));
          errs.push(`GDS JSON 다름: 요소 ${a.length} / ALIGN ${b.length}, ${i} 번째부터 (${JSON.stringify(a[i])?.slice(0, 120)} / ALIGN ${JSON.stringify(b[i])?.slice(0, 120)})`);
        }
      } else errs.push("(GDS 기준 없음)");
    }

    // 오류 문구 (pyroute.py 는 앞 40 줄만 남긴다)
    const rj = path.join(dir, "result.json");
    let errNote = "";
    if (fs.existsSync(rj)) {
      const r = J(rj);
      if (r.nerrors !== out.errors.length) errs.push(`DRC/LVS ${out.errors.length} 건 / ALIGN ${r.nerrors} 건`);
      const k = r.errors.findIndex((l, i) => l !== out.errors[i]);
      if (k >= 0) errs.push(`오류 문구 ${k} 번째: ${out.errors[k]?.slice(0, 160)} / ALIGN ${r.errors[k].slice(0, 160)}`);
      errNote = `DRC/LVS ${String(r.nerrors).padStart(2)}`;
    }

    // 단계 기록 (Rust 배선기일 때)
    let stNote = "";
    if (wasm) {
      const rows = compareRuns(tap.records, out.records);
      const diffRows = rows.filter((r) => !r.same);
      stNote = `단계 ${rows.length - diffRows.length}/${rows.length}`;
      for (const r of diffRows.slice(0, 6))
        errs.push(`단계 ${r.module} 모드 ${r.mode}: ` + (r.missing ? `한쪽에 없다 (${r.missing})` :
          `${r.count} 곳 — ` + r.first.slice(0, 3).map((d) => `${d.path}: ${d.b} / ALIGN ${d.a}`).join("; ")));
    }
    const ok = !errs.some((e) => !e.startsWith("("));
    if (!ok) bad++;
    console.log(`${head} 모듈 ${String(out.outputs.size).padStart(2)} (도형 대조 ${nMod})  ${errNote}  ${stNote}  ` +
                `GDS ${(out.gds.length / 1024).toFixed(0)}K  ${ms.toFixed(0)} ms  ${ok ? "같다" : "다름"}`);
    for (const e of errs) console.log("    " + e);
    if (verbose) for (const w of out.warnings) console.log("    경고: " + w);
  }
}
console.log(`\n${runs} 판 — ${bad ? `다름 ${bad} 판` : "모두 같다"}` + (alignDead ? ` (ALIGN 이 죽은 배치 ${alignDead} 개는 따로)` : ""));
if (bad || !runs) process.exit(1);
