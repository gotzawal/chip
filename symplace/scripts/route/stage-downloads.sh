#!/usr/bin/env bash
# 페이지에서 받을 수 있게 산출물을 site/downloads/ 로 옮긴다.
#   <예제>.gds          ALIGN 배선기가 낸 GDS
#   <예제>.place.json   우리 배치 (좌표 + 변이 + 반전)
#   <예제>.routed.json  배선 기하 (레이어별 사각형)
#   <예제>.errors.txt   DRC/LVS 원문
#
# GitHub Pages 같은 정적 호스팅에서는 <a download> 가 그대로 동작한다.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# 환경은 꾸러미면 env.sh, 소스 트리면 align-env.sh 다 (둘 다 같은 깊이).
for e in "$ROOT/env.sh" "$ROOT/align-env.sh"; do
  [ -f "$e" ] && { . "$e" >/dev/null 2>&1; break; }
done
SPIKES=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DST=$ROOT/web/placer/site/downloads
mkdir -p "$DST"
rm -f "$DST"/*

python3 - "$ALIGN_WORK" "$ROOT" "$DST" <<'PY'
import glob, json, os, shutil, sys
work, root, dst = sys.argv[1:4]
index = []
for ex in ("telescopic_ota", "current_mirror_ota", "five_transistor_ota",
           "high_speed_comparator", "cascode_current_mirror_ota"):
    d = os.path.join(work, ex + "_js")
    rec = {"name": ex, "files": []}
    def put(src, name, label):
        if not src or not os.path.exists(src):
            return
        shutil.copy2(src, os.path.join(dst, name))
        rec["files"].append({"file": name, "label": label,
                             "bytes": os.path.getsize(src)})
    g = [f for f in glob.glob(os.path.join(d, "*.gds")) if ".python." not in f]
    put(g[0] if g else None, ex + ".gds", "GDS (KLayout)")
    put(os.path.join(root, "web/placer/out", ex + ".place.json"),
        ex + ".place.json", "배치 (좌표·변이·반전)")
    cands = [f for f in sorted(glob.glob(os.path.join(d, "3_pnr", "*_0.json")))
             if ".python." not in f and ".gds." not in f]
    top = [f for f in cands if os.path.basename(f).upper().startswith(ex.upper()[:8])] or cands
    put(top[-1] if top else None, ex + ".routed.json", "배선 기하 (레이어별)")
    errs = sorted(glob.glob(os.path.join(d, "3_pnr", "*.errors")))
    if errs:
        out = os.path.join(dst, ex + ".errors.txt")
        with open(out, "w", encoding="utf8") as f:
            for p in errs:
                f.write("# %s\n" % os.path.basename(p))
                f.write(open(p, encoding="utf8", errors="replace").read())
                f.write("\n")
        rec["files"].append({"file": ex + ".errors.txt", "label": "DRC/LVS 원문",
                             "bytes": os.path.getsize(out)})
    index.append(rec)
    print("%-28s %s" % (ex, ", ".join("%s %.0fK" % (f["label"], f["bytes"] / 1024)
                                      for f in rec["files"])))
with open(os.path.join(dst, "index.json"), "w", encoding="utf8") as f:
    json.dump(index, f)
tot = sum(os.path.getsize(os.path.join(dst, f)) for f in os.listdir(dst))
print("\n합계 %.1f MB" % (tot / 1048576))
PY
