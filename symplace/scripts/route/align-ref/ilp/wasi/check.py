"""wasm32-wasi 로 빌드한 lp_solve 가 기준 휠의 lp_solve 와 같은 답을 내는지 본다.

    python3 check.py <lps.jsonl> <ref.jsonl> [lptest.wasm]

lps.jsonl 은 ../harness.cpp 가 DUMP=<파일> 로 쓴 ILP (GcellGlobalRouter::ILPSolveRouting 과 같은 모양),
ref.jsonl 은 ../wasm_lp.mjs 가 기준 휠(emscripten 3.1.58) 의 lp_solve 로 푼 답이다.
반환값·목적값·변수 전부가 비트까지 같은지 센다 (2026-09-23: 410/410).
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
lps, ref = sys.argv[1], sys.argv[2]
wasm = sys.argv[3] if len(sys.argv) > 3 else os.path.expanduser("~/.cache/symplace/lpsolve-wasi/lptest.wasm")

lines = []
for line in open(lps):
    d = json.loads(line)
    parts = [str(d["N"]), str(len(d["rows"]))]
    for typ, rhs, ent in d["rows"]:
        parts += [str(typ), repr(float(rhs)), str(len(ent))]
        for c, v in ent:
            parts += [str(c), repr(float(v))]
    lines.append(" ".join(parts))
tmp_in, tmp_out = wasm + ".in.txt", wasm + ".out.txt"
open(tmp_in, "w").write("\n".join(lines) + "\n")
subprocess.run(["node", os.path.join(HERE, "run.mjs"), wasm, tmp_in, tmp_out], check=True)

refs = [json.loads(l) for l in open(ref)]
mine = [l.split() for l in open(tmp_out)]
same = picks = 0
for r, m in zip(refs, mine):
    ret, obj, vs = int(m[0]), float(m[1]), [float(x) for x in m[2:]]
    rv = [float(x) for x in r["vars"]]
    same += ret == r["ret"] and obj == float(r["obj"]) and vs == rv
    picks += [v == 1.0 for v in vs[:-1]] == [v == 1.0 for v in rv[:-1]]
print(f"사례 {len(refs)}  풀이 전부 같음 {same}  고른 후보 같음 {picks}")
sys.exit(0 if same == len(refs) == len(mine) else 1)
