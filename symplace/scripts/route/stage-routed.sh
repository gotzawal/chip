#!/usr/bin/env bash
# 배선 결과(레이어별 기하)와 DRC 에러 파일을 페이지 쪽으로 옮긴다.
# 페이지가 손으로 적은 표 대신 **실제 결과**를 읽게 하려는 것.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# 환경은 꾸러미면 env.sh, 소스 트리면 align-env.sh 다 (둘 다 같은 깊이).
for e in "$ROOT/env.sh" "$ROOT/align-env.sh"; do
  [ -f "$e" ] && { . "$e" >/dev/null 2>&1; break; }
done
SPIKES=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DST=$ROOT/web/placer/site/routed
mkdir -p "$DST"

python3 - "$ALIGN_WORK" "$DST" <<'PY'
import glob, json, os, sys
work, dst = sys.argv[1], sys.argv[2]
index = []
for ex in ("telescopic_ota", "current_mirror_ota", "five_transistor_ota",
           "cascode_current_mirror_ota", "high_speed_comparator"):
    rec = {"name": ex}
    for who, suffix in (("ours", "_js"), ("align", "_base")):
        d = os.path.join(work, ex + suffix)
        if not os.path.isdir(d):
            continue
        # 배선 결과 기하 (최상위 것)
        cands = [f for f in sorted(glob.glob(os.path.join(d, "3_pnr", "*_0.json")))
                 if ".python." not in f and ".gds." not in f]
        top = [f for f in cands if os.path.basename(f).startswith(ex.upper()[:8])] or cands
        geo = None
        if top:
            with open(top[-1], encoding="utf8") as f:
                j = json.load(f)
            geo = {"bbox": j.get("bbox"), "terminals": j.get("terminals", [])}
        # DRC 에러
        errs = []
        for p in sorted(glob.glob(os.path.join(d, "3_pnr", "*.errors"))) + \
                 sorted(glob.glob(os.path.join(d, "*.errors"))):
            with open(p, encoding="utf8", errors="replace") as f:
                for line in f:
                    if line.strip():
                        errs.append({"file": os.path.basename(p), "text": line.strip()[:400]})
        gds = [f for f in glob.glob(os.path.join(d, "*.gds")) if ".python." not in f]
        rec[who] = {
            "errors": errs,
            "gdsBytes": os.path.getsize(gds[0]) if gds else None,
            "gdsName": os.path.basename(gds[0]) if gds else None,
        }
        if geo:
            out = os.path.join(dst, "%s.%s.json" % (ex, who))
            with open(out, "w", encoding="utf8") as f:
                json.dump(geo, f, separators=(",", ":"))
            rec[who]["geo"] = os.path.basename(out)
            rec[who]["rects"] = len(geo["terminals"])
    index.append(rec)
    o, a = rec.get("ours", {}), rec.get("align", {})
    print("%-28s 우리 %4s 사각형 DRC %-3s | ALIGN %4s 사각형 DRC %s"
          % (ex, o.get("rects", "-"), len(o.get("errors", [])),
             a.get("rects", "-"), len(a.get("errors", []))))

with open(os.path.join(dst, "index.json"), "w", encoding="utf8") as f:
    json.dump(index, f)
tot = sum(os.path.getsize(os.path.join(dst, f)) for f in os.listdir(dst))
print("\n합계 %.0f KB" % (tot / 1024))
PY
