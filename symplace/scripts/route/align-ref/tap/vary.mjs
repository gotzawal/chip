/** 흔든 배치로 기준 덤프를 더 모은다 — 페이지 배치기(src/job.mjs)를 설정만 바꿔 여러 번 풀고,
 *  배치마다 ALIGN 으로 배선하며 RouteWork 앞뒤 hierNode 를 뜬다 (runall.mjs 와 같은 탭).
 *
 *    node vary.mjs [예제...] [--n=개수]     -> ~/.cache/symplace/tap-vary/<예제>/<설정>/
 *
 *  설정은 시작점(batch), 면적:배선 저울(hpwlWeight), 배선:퍼뜨리기 저울(lamRatio) 조합이다. 같은 배치가
 *  다시 나오면 건너뛴다. 이미 뜬 설정(result.json 이 있는 폴더)은 다시 돌리지 않고 개수에 넣는다 — 이어서
 *  돌릴 수 있다. 앞의 16 개가 처음 모은 설정이고, 뒤는 넓힌 것이다.
 *  Rust 이식은 test/alignroute.mjs --tap=~/.cache/symplace/tap-vary, test/route.mjs --tap=... 로 견준다.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootAlign, runFront, workerPython, WORK_CACHE, ROOT } from "../../node/align.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { runJob } = await import(path.join(ROOT, "src/job.mjs"));
const args = process.argv.slice(2);
const want = args.filter((a) => !a.startsWith("--"));
const nMax = Number((args.find((a) => a.startsWith("--n=")) ?? "--n=12").slice(4));
const OUT = path.join(WORK_CACHE, "tap-vary");
const J = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const rows = J(path.join(ROOT, "data/index.json")).map((x) => (typeof x === "string" ? x : x.name));

// 작은 설계부터 넓게, 큰 설계(배치가 몇 분)는 좁게
const SETS = [];
for (const batch of [48, 96]) for (const hw of [0.5, 1, 2, 4]) for (const lam of [0.5, 2]) SETS.push({ batch, hw, lam });
for (const batch of [24, 64]) for (const hw of [0.125, 1, 8]) for (const lam of [0.25, 1, 4]) SETS.push({ batch, hw, lam });
for (const batch of [32, 128]) for (const hw of [0.25, 2, 16]) for (const lam of [0.5, 2]) SETS.push({ batch, hw, lam });

for (const ex of rows) {
  if (want.length && !want.includes(ex)) continue;
  if (!fs.existsSync(path.join(ROOT, "data", ex + ".leaves.json"))) continue;
  const blob = J(path.join(ROOT, "data", ex + ".json"));
  const seen = new Set();
  let py = null, top = null, done = 0;
  for (const s of SETS) {
    if (done >= nMax) break;
    const tag = `b${s.batch}-w${s.hw}-l${s.lam}`;
    const dir = path.join(OUT, ex, tag);
    if (fs.existsSync(path.join(dir, "result.json")) && fs.existsSync(path.join(dir, "placement.json"))) {
      seen.add(fs.readFileSync(path.join(dir, "placement.json"), "utf8"));
      done++;
      continue;
    }
    const t0 = performance.now();
    let ours = null;
    await runJob({ name: ex, blob, batch: s.batch, hpwlWeight: s.hw, lamRatio: s.lam }, (m) => {
      if (m.type === "done") ours = m;
      if (m.type === "error") throw new Error(m.msg);
    });
    const placement = {
      bbox: [0, 0, Math.round(ours.bbox[2] - ours.bbox[0]), Math.round(ours.bbox[3] - ours.bbox[1])],
      instances: ours.rects.map((r) => ({
        name: r.name, concrete: r.concrete,
        oX: Math.round(r.sx > 0 ? r.x : r.x + r.w), oY: Math.round(r.sy > 0 ? r.y : r.y + r.h),
        sX: r.sx > 0 ? 1 : -1, sY: r.sy > 0 ? 1 : -1,
      })),
      subModules: ours.subModules ?? [],
    };
    const key = JSON.stringify(placement);
    if (seen.has(key)) { console.log(`${ex.padEnd(27)} ${tag.padEnd(16)} 같은 배치 — 건너뜀`); continue; }
    seen.add(key);
    const tp = ((performance.now() - t0) / 1000).toFixed(0);
    if (!py) {
      ({ py } = await bootAlign({ blasfix: true }));
      ({ top } = runFront(py, ex));
      py.setStdout({ batched: () => {} }); py.setStderr({ batched: () => {} });
      py.runPython(workerPython("PYROUTE"));
      py.runPython(fs.readFileSync(path.join(HERE, "tap.py"), "utf8"));
    }
    py.runPython("import shutil, os; shutil.rmtree('/work/tap', ignore_errors=True); os.makedirs('/work/tap'); CALLS.clear()");
    const r = JSON.parse(py.globals.get("route")("/work/" + ex, ex, top, key));
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    for (const n of py.FS.readdir("/work/tap")) if (!n.startsWith(".")) fs.writeFileSync(path.join(dir, n), py.FS.readFile("/work/tap/" + n));
    fs.writeFileSync(path.join(dir, "placement.json"), key);
    fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({ ok: r.ok, nerrors: r.nerrors, errors: r.errors, error: r.error }, null, 1));
    done++;
    console.log(`${ex.padEnd(27)} ${tag.padEnd(16)} 배치 ${tp}s  ALIGN ${r.ok ? "ok" : "실패"}  DRC/LVS ${r.nerrors ?? "-"}` +
                `  ${((performance.now() - t0) / 1000).toFixed(0)}s`);
  }
}
