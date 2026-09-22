"""우리 배치를 ALIGN 배선 단계에 넘긴다.

ALIGN 의 흐름은 3_pnr:place -> 3_pnr:route 인데, 둘 사이의 인수인계는
Results/*.scaled_placement_verilog.json 이 아니라
    3_pnr/__placer_dump__.json
으로 이뤄진다. place 단계가 (top_level, leaf_map, alternatives, metrics) 를
여기에 쓰고, route 단계가 이걸 읽는다. Results 쪽은 사람이 보라고 남기는 사본이다.

그래서 우리 좌표를 __placer_dump__.json 안의 alternatives 에 심는다.
그러면 ALIGN 은 자기가 만든 배치인 줄 알고 배선을 시작한다.
"""
from __future__ import annotations

import json
import pathlib
import shutil
import subprocess

import numpy as np


def transformation(cx, cy, tbox, sX, sY):
    """중심 좌표에서 ALIGN 의 transformation 을 역산한다.

    placed_center = sX * (tx0 + tx1) / 2 + oX  이므로
        oX = cx - sX * (tx0 + tx1) / 2
    """
    tx0, ty0, tx1, ty1 = tbox
    return {
        "oX": cx - sX * (tx0 + tx1) / 2,
        "oY": cy - sY * (ty0 + ty1) / 2,
        "sX": sX,
        "sY": sY,
    }


def grid_anchors(pl, mod):
    """(X_i - ax_i) 가 정수여야 oX 가 정수가 된다. 그 ax 를 만든다."""
    ax, ay = [], []
    for inst in mod.instances:
        tb = pl.template_bbox(inst.concrete_template)
        if tb is None:
            continue
        ax.append(inst.sX * (tb[0] + tb[2]) / 2)
        ay.append(inst.sY * (tb[1] + tb[3]) / 2)
    return ax, ay


def prepare(src_work: str, dst_work: str) -> pathlib.Path:
    """ALIGN 이 만든 작업 디렉터리를 복사한다. 원본은 비교용으로 남긴다.

    shutil.copytree 는 /mnt/c (drvfs) 에서 파일마다 왕복이 생겨 느리다.
    7MB 짜리를 옮기다 프로세스가 죽는 일이 있어 cp -a 로 바꿨다.
    """
    src, dst = pathlib.Path(src_work), pathlib.Path(dst_work)
    if dst.exists():
        subprocess.run(["rm", "-rf", str(dst)], check=True)
    dst.mkdir(parents=True)
    for sub in ("1_topology", "2_primitives", "3_pnr"):
        if (src / sub).exists():
            subprocess.run(["cp", "-a", str(src / sub), str(dst / sub)], check=True)
    return dst


def pdk_grid(pdk_dir, default=(80, 84)):
    """배치 격자를 PDK 에서 읽는다.

    세로 배선층(M1)의 pitch 가 x 격자, 가로 배선층(M2)의 pitch 가 y 격자다.
    여기 안 맞으면 배선이 "Wire to color is offgrid" 로 거부한다.
    FinFET14nm_Mock_PDK 기준 (80, 84) 이고, ALIGN 자신의 좌표도 이 배수다.
    """
    try:
        ab = json.load(open(f"{pdk_dir}/layers.json", encoding="utf8"))["Abstraction"]
    except Exception:
        return default
    qx = qy = None
    for e in ab:
        if "Pitch" not in e or not str(e.get("Layer", "")).startswith("M"):
            continue
        if e.get("Direction") == "V" and qx is None:
            qx = int(e["Pitch"])
        if e.get("Direction") == "H" and qy is None:
            qy = int(e["Pitch"])
    return (qx or default[0], qy or default[1])


def normalize(pl, mod, cx, cy, w, h, grid=(80, 84)):
    """ALIGN 이 받을 수 있는 좌표로 다듬는다.

    세 가지가 필요하다.
      1. 정확한 정수 — MILP 는 정수 조건을 걸어도 1e-11 쯤 찌꺼기를 남긴다.
         ALIGN 의 render_placement 는 "not a whole number" 로 거부한다.
      2. 원점 정렬 — 모듈 bbox 는 (0,0) 에서 시작한다. 음수 좌표가 있으면
         AssignBboxVariables 검증에서 충돌한다.
      3. 배선 격자 — 금속 pitch 의 배수여야 한다 (M1 80, M2 84).
         여기 안 맞으면 "Wire to color is offgrid" 로 배선이 거부한다.

    대칭은 깨지지 않는다. 같은 값이던 좌표는 같은 값으로 반올림되고,
    전체를 같은 양만큼 평행이동하는 것은 대칭축도 함께 옮긴다.
    """
    qx, qy = grid
    ax, ay = grid_anchors(pl, mod)
    ax, ay = np.array(ax, float), np.array(ay, float)
    # oX = cx - ax 가 격자의 배수여야 하므로, 맞추는 대상은 cx 가 아니라 cx - ax 다.
    x0 = min(cx - w / 2)
    y0 = min(cy - h / 2)
    ncx = np.round((cx - x0 - ax) / qx) * qx + ax
    ncy = np.round((cy - y0 - ay) / qy) * qy + ay
    # 원점이 음수로 밀렸으면 격자 단위로 되돌린다
    sx = np.ceil(-min(ncx - w / 2) / qx) * qx if min(ncx - w / 2) < 0 else 0
    sy = np.ceil(-min(ncy - h / 2) / qy) * qy if min(ncy - h / 2) < 0 else 0
    ncx, ncy = ncx + sx, ncy + sy
    bw = int(np.ceil(max(ncx + w / 2) / qx) * qx)
    bh = int(np.ceil(max(ncy + h / 2) / qy) * qy)
    return ncx, ncy, [0, 0, bw, bh]


def inject(work: pathlib.Path, pl, mod, cx, cy, variant=0, bbox=None) -> str:
    """__placer_dump__.json 의 배치 좌표를 우리 것으로 바꾼다."""
    dump_path = work / "3_pnr" / "__placer_dump__.json"
    top_level, leaf_map, alts, metrics = json.load(open(dump_path, encoding="utf8"))

    key = f"{top_level}_{variant}"
    hit = False
    for entry in alts:
        nm, vd = entry[0], entry[1]
        if nm != key:
            continue
        for m in vd.get("modules", []):
            if m.get("concrete_name") != key:
                continue
            by_name = {i.name: i for i in mod.instances}
            k = 0
            for inst in m.get("instances", []):
                src_inst = by_name.get(inst["instance_name"])
                if src_inst is None:
                    continue
                tb = pl.template_bbox(src_inst.concrete_template)
                if tb is None:
                    continue
                t = transformation(float(cx[k]), float(cy[k]), tb,
                                   src_inst.sX, src_inst.sY)
                # 정확한 정수여야 한다. 위에서 다듬었으니 반올림은 안전하다.
                t["oX"] = int(round(t["oX"]))
                t["oY"] = int(round(t["oY"]))
                inst["transformation"] = t
                k += 1
            if bbox is not None:
                m["bbox"] = [int(v) for v in bbox]
            hit = True
        if hit:
            break
    if not hit:
        raise RuntimeError(f"{key} 를 __placer_dump__.json 에서 못 찾음")

    json.dump([top_level, leaf_map, alts, metrics],
              open(dump_path, "w", encoding="utf8"), indent=2, default=str)

    # 배선은 이 목록에 적힌 변형만 돈다
    with open(work / "3_pnr" / "__placements_to_run__.json", "w") as fp:
        json.dump([variant], fp)

    return key
