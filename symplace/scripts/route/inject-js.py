"""JS 배치기가 낸 좌표를 ALIGN 의 __placer_dump__.json 에 심는다.

ALIGN 의 인수인계는 Results/*.json 이 아니라 3_pnr/__placer_dump__.json 이다.
place 단계가 (top_level, leaf_map, alternatives, metrics) 를 여기 쓰고
route 단계가 이걸 읽는다.

gpuplace/handoff.py 의 inject() 와 다른 점 하나:
**우리 JS 배치기는 ALIGN 과 다른 변이를 고를 수 있다.** 그러면 좌표만 바꿔선
안 되고 concrete_template_name 도 바꿔야 하는데, 그 템플릿의 정의가 그 대안의
leaves 에 없을 수 있다. 그래서 leaves 를 통째로 다시 짠다.

leaves 항목은 2_primitives/<concrete>.json 에서 그대로 만들 수 있다.
실측으로 형식이 같다:
    leaves[i] = {abstract_name, concrete_name, bbox, terminals:[{name, rect}]}
    2_primitives = {bbox, terminals:[{netName, netType, layer, rect}, ...]}
    -> netType == "pin" 인 것만 골라 netName -> name 으로 옮기면 된다.

사용법:
    python3 inject-js.py <place.json> <작업디렉터리> [--variant 0]
"""
import json
import os
import shutil
import sys

args = [a for a in sys.argv[1:] if not a.startswith("--")]
if len(args) < 2:
    sys.exit(__doc__)
PLACE, WORK = args[0], args[1]
VAR = 0
if "--variant" in sys.argv:
    VAR = int(sys.argv[sys.argv.index("--variant") + 1])

with open(PLACE, encoding="utf8") as f:
    pl = json.load(f)

dump_path = os.path.join(WORK, "3_pnr", "__placer_dump__.json")
if not os.path.exists(dump_path):
    sys.exit("덤프가 없다: %s\n  ALIGN place 단계를 먼저 돌려야 한다." % dump_path)
bak = dump_path + ".orig"
if not os.path.exists(bak):
    shutil.copy2(dump_path, bak)

with open(bak, encoding="utf8") as f:
    top_level, leaf_map, alts, metrics = json.load(f)

prim_dir = os.path.join(WORK, "2_primitives")


def leaf_entry(concrete, abstract):
    """2_primitives 의 concrete JSON 에서 덤프용 leaf 항목을 만든다."""
    p = os.path.join(prim_dir, concrete + ".json")
    if not os.path.exists(p):
        return None
    with open(p, encoding="utf8") as f:
        d = json.load(f)
    terms = []
    for t in d.get("terminals", []):
        if t.get("netType") != "pin" or not t.get("netName"):
            continue
        terms.append({"name": t["netName"], "rect": list(t["rect"])})
    return {"abstract_name": abstract, "concrete_name": concrete,
            "bbox": list(d["bbox"]), "terminals": terms}


key = "%s_%d" % (top_level, VAR)
hit = None
for entry in alts:
    if entry[0] == key:
        hit = entry[1]
        break
if hit is None:
    sys.exit("대안 %s 를 못 찾았다. 있는 것: %s" % (key, [e[0] for e in alts][:6]))

# --- 하위 모듈 이름 짝짓기 ---
#
# 계층 설계에서 우리 배치기는 하위 모듈을 여러 모양으로 올리므로 concrete 이름이
# "<모듈>__v0" 꼴이다. 덤프 쪽은 "<모듈>_PG0_2" 꼴이다. 같은 abstract 를 가리키는
# 이름끼리 짝지어 덤프 이름을 그대로 쓴다 — 배선기가 아는 이름이어야 한다.
sub_mods = pl.get("subModules", [])
name_map = {}          # 우리 이름 -> 덤프 이름
if sub_mods:
    # 덤프에 있는 하위 모듈 대안 이름들을 abstract 별로 모은다
    pool = {}
    for entry in alts:
        nm = entry[0]
        if nm.startswith(top_level):
            continue
        # "<abstract>_PG0_2" -> abstract
        ab = nm.rsplit("_PG", 1)[0]
        pool.setdefault(ab, []).append(nm)
    for sm in sub_mods:
        cands = pool.get(sm["abstract"], [])
        if not cands:
            sys.exit("덤프에 하위 모듈 %s 의 대안이 없다" % sm["abstract"])
        taken = set(name_map.values())
        pick = next((c for c in cands if c not in taken), cands[0])
        name_map[sm["concrete"]] = pick

# --- 인스턴스 좌표와 템플릿 이름 ---
by_name = {i["name"]: i for i in pl["instances"]}
changed = 0
for m in hit.get("modules", []):
    if m.get("concrete_name") != key:
        continue
    m["bbox"] = list(pl["bbox"])
    for inst in m.get("instances", []):
        src = by_name.get(inst["instance_name"])
        if src is None:
            print("  경고: %s 가 우리 배치에 없다 — 그대로 둔다" % inst["instance_name"])
            continue
        was = inst["concrete_template_name"]
        cn = name_map.get(src["concrete"], src["concrete"])
        inst["concrete_template_name"] = cn
        inst["transformation"] = {"oX": int(src["oX"]), "oY": int(src["oY"]),
                                  "sX": int(src["sX"]), "sY": int(src["sY"])}
        if was != cn:
            changed += 1

# --- 하위 모듈: module 항목과 **자기 대안**을 둘 다 우리 것으로 ---
#
# 두 군데를 고쳐야 한다.
#   (1) 최상위 대안 안의 사본  — 최상위 배선이 읽는다
#   (2) 그 하위 모듈 자신의 대안 — 하위 모듈 배선이 따로 읽는다
# (2) 를 빠뜨리면 우리가 고른 leaf 변이가 그쪽 leaves 에 없어서
#     "concrete_template_name: ... not found." 로 죽는다 (실제로 그랬다).
def rewrite_module(ent, sm):
    ent["bbox"] = list(sm["bbox"])
    isrc = {i["name"]: i for i in sm["instances"]}
    used = {}
    for inst in ent.get("instances", []):
        q = isrc.get(inst["instance_name"])
        if q is None:
            continue
        inst["concrete_template_name"] = q["concrete"]
        inst["transformation"] = {"oX": int(q["oX"]), "oY": int(q["oY"]),
                                  "sX": int(q["sX"]), "sY": int(q["sY"])}
        used[q["concrete"]] = inst.get("abstract_template_name")
    return used


sub_done = 0
for sm in sub_mods:
    cn = name_map[sm["concrete"]]

    # (1) 최상위 대안 안의 사본
    ent = None
    for m in hit.get("modules", []):
        if m.get("concrete_name") == cn:
            ent = m
            break
    if ent is None:
        for entry in alts:
            if entry[0] != cn:
                continue
            for m in entry[1].get("modules", []):
                if m.get("concrete_name") == cn:
                    ent = json.loads(json.dumps(m))
                    hit.setdefault("modules", []).append(ent)
                    break
            break
    if ent is None:
        sys.exit("하위 모듈 %s 의 module 항목을 못 찾았다" % cn)
    rewrite_module(ent, sm)

    # (2) 하위 모듈 자신의 대안 — module 항목과 leaves 를 같이 고친다
    own = None
    for entry in alts:
        if entry[0] == cn:
            own = entry[1]
            break
    if own is not None:
        used = {}
        for m in own.get("modules", []):
            if m.get("concrete_name") == cn:
                used = rewrite_module(m, sm)
        lv = []
        for c2, a2 in sorted(used.items()):
            e2 = leaf_entry(c2, a2)
            if e2 is None:
                sys.exit("하위 모듈 %s 의 leaf %s 정의를 못 만들었다" % (cn, c2))
            lv.append(e2)
        if lv:
            own["leaves"] = lv
    sub_done += 1

# --- 최상위 대안에서 안 쓰는 모듈 항목을 걷어낸다 ---
#
# 우리가 하위 모듈을 다른 대안(_PG0_0)으로 바꾸면 ALIGN 이 쓰던 것(_PG0_1 등)이
# 참조되지 않은 채 modules 에 남는다. 배선기가 그걸 같이 읽다가
# "concrete_template_name: ... not found." 로 죽는다. 참조되는 것만 남긴다.
if sub_mods:
    keep = {key}
    for m in hit.get("modules", []):
        if m.get("concrete_name") != key:
            continue
        for inst in m.get("instances", []):
            keep.add(inst["concrete_template_name"])
    before = len(hit.get("modules", []))
    hit["modules"] = [m for m in hit.get("modules", [])
                      if m.get("concrete_name") in keep]
    dropped = before - len(hit["modules"])
else:
    dropped = 0

# --- leaves 를 다시 짠다 ---
#
# 모든 층의 인스턴스가 가리키는 concrete 를 모은다. 하위 모듈 자신은 leaf 가
# 아니라 module 이므로 뺀다 (module 항목으로 이미 들어가 있다).
mod_names = {m.get("concrete_name") for m in hit.get("modules", [])}
need = {}
for m in hit.get("modules", []):
    for inst in m.get("instances", []):
        cn = inst["concrete_template_name"]
        if cn in mod_names:
            continue
        need[cn] = inst.get("abstract_template_name")

leaves, missing = [], []
for cn, ab in sorted(need.items()):
    e = leaf_entry(cn, ab)
    if e is None:
        # 기존 leaves 나 다른 대안에서 찾아본다
        for entry in alts:
            for l in entry[1].get("leaves", []):
                if l.get("concrete_name") == cn:
                    e = l
                    break
            if e:
                break
    if e is None:
        missing.append(cn)
    else:
        leaves.append(e)

if missing:
    sys.exit("leaf 정의를 못 만든 템플릿: %s" % missing)
hit["leaves"] = leaves

with open(dump_path, "w", encoding="utf8") as f:
    json.dump([top_level, leaf_map, alts, metrics], f)

# route 단계는 __placements_to_run__.json 도 읽는다 (원래 gui 단계가 쓴다).
# --flow_stop 3_pnr:place 로 끊으면 그 파일이 없어서 FileNotFoundError 가 난다.
# 우리가 심은 대안 하나만 배선하라고 적어둔다.
run_path = os.path.join(WORK, "3_pnr", "__placements_to_run__.json")
with open(run_path, "w", encoding="utf8") as f:
    json.dump([VAR], f)

q = pl.get("quality", {})
print("심었다: %s" % dump_path)
print("  대안 %s  bbox %s" % (key, pl["bbox"]))
print("  인스턴스 %d  변이 바뀐 것 %d  leaves %d  하위모듈 %d"
      % (len(pl["instances"]), changed, len(leaves), sub_done if sub_mods else 0))
if name_map:
    for a, b in name_map.items():
        print("    하위 %s -> %s" % (a, b))
print("  격자밖 %s  겹침 %.2e  대칭잔차 %.2e"
      % (q.get("offgrid"), q.get("overlap", 0), q.get("resid", 0)))
if q.get("alignArea"):
    print("  ALIGN 대비  면적 %.3fx  HPWL %.3fx"
          % (q["area"] / q["alignArea"], q["hpwl"] / q["alignHpwl"]))
if dropped:
    print("  안 쓰는 모듈 항목 %d 개 제거" % dropped)
print("  원본은 %s 로 남겨뒀다" % os.path.basename(bak))
