"""ALIGN 배치 결과(*.scaled_placement_verilog.json)를 읽고 쓴다.

M0 의 목적은 최적화가 아니라 입출력 왕복이다. ALIGN 이 낸 파일을 읽어
우리 자료구조로 옮긴 뒤 다시 써서 원본과 같은지 확인한다. 이게 맞아야
나중에 좌표만 우리 것으로 바꿔 끼울 수 있다.

그래서 dump() 는 raw 를 그대로 복사하지 않고, 우리가 실제로 다룰 값
(transformation, bbox)은 자료구조에서 재구성한다. 그래야 왕복 검사가
"복사했더니 같더라"가 아니라 "모델이 필요한 걸 다 담았다"의 증거가 된다.
"""
from __future__ import annotations

import copy
import json
from dataclasses import dataclass


@dataclass
class Instance:
    name: str
    abstract_template: str
    concrete_template: str
    oX: float
    oY: float
    sX: float
    sY: float
    raw: dict           # fa_map 등 우리가 안 건드리는 필드 보존


@dataclass
class Module:
    abstract_name: str
    concrete_name: str
    bbox: list          # [x0, y0, x1, y1]
    constraints: list
    instances: list
    raw: dict


@dataclass
class Placement:
    leaf_bbox: dict     # concrete_name -> [x0, y0, x1, y1]
    leaf_terms: dict    # concrete_name -> [{name, rect}]  (핀 위치)
    modules: list
    raw: dict

    def module(self, concrete_name: str) -> Module | None:
        for m in self.modules:
            if m.concrete_name == concrete_name:
                return m
        return None

    def top(self, stem: str | None = None) -> Module:
        """top 모듈. 파일명 stem 이 알려주며, 없으면 마지막 모듈."""
        if stem:
            m = self.module(stem)
            if m:
                return m
        return self.modules[-1]

    def template_bbox(self, concrete_name: str) -> list | None:
        """인스턴스가 가리키는 템플릿의 bbox.

        계층 설계에서는 leaf 가 아니라 하위 모듈을 가리키기도 한다.
        """
        if concrete_name in self.leaf_bbox:
            return self.leaf_bbox[concrete_name]
        m = self.module(concrete_name)
        return m.bbox if m else None

    def template_pins(self, concrete_name: str) -> dict:
        """템플릿의 포트 위치. {포트명: (dx, dy)} — bbox 중심 기준 오프셋.

        leaf 는 terminals 에 핀 사각형이 그대로 있다.
        하위 모듈에는 terminals 가 없고 parameters(포트 목록)만 있어서,
        그 안의 인스턴스를 뒤져 같은 넷에 붙은 핀들의 무게중심을 쓴다.
        모듈이 모듈을 품는 경우도 있으므로 재귀로 내려간다.
        """
        if not hasattr(self, "_pin_cache"):
            self._pin_cache = {}
        if concrete_name in self._pin_cache:
            return self._pin_cache[concrete_name]

        out = {}
        bb = self.template_bbox(concrete_name)
        if bb is None:
            self._pin_cache[concrete_name] = out
            return out
        cx0, cy0 = (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2

        terms = self.leaf_terms.get(concrete_name)
        if terms:
            for t in terms:
                r = t["rect"]
                out[t["name"]] = ((r[0] + r[2]) / 2 - cx0, (r[1] + r[3]) / 2 - cy0)
            self._pin_cache[concrete_name] = out
            return out

        m = self.module(concrete_name)
        if m is None:
            self._pin_cache[concrete_name] = out
            return out

        # 포트마다 내부 핀 위치를 모아 평균낸다
        acc = {}
        self._pin_cache[concrete_name] = out      # 재귀 중 무한루프 방지
        for inst in m.instances:
            child = self.template_pins(inst.concrete_template)
            if not child:
                continue
            tb = self.template_bbox(inst.concrete_template)
            ccx = inst.sX * (tb[0] + tb[2]) / 2 + inst.oX      # 모듈 좌표계에서의 자식 중심
            ccy = inst.sY * (tb[1] + tb[3]) / 2 + inst.oY
            fa = {f["formal"]: f["actual"] for f in inst.raw.get("fa_map", [])}
            for formal, (dx, dy) in child.items():
                net = fa.get(formal)
                if net is None:
                    continue
                px = ccx + inst.sX * dx
                py = ccy + inst.sY * dy
                acc.setdefault(net, []).append((px, py))

        for port in m.raw.get("parameters", []):
            pts = acc.get(port)
            if not pts:
                continue
            out[port] = (sum(p[0] for p in pts) / len(pts) - cx0,
                         sum(p[1] for p in pts) / len(pts) - cy0)
        self._pin_cache[concrete_name] = out
        return out


def load(path: str) -> Placement:
    raw = json.load(open(path, encoding="utf8"))

    leaf_bbox = {l["concrete_name"]: list(l["bbox"]) for l in raw.get("leaves", [])}
    leaf_terms = {l["concrete_name"]: l.get("terminals", [])
                  for l in raw.get("leaves", [])}

    modules = []
    for m in raw.get("modules", []):
        insts = []
        for i in m.get("instances", []):
            tr = i["transformation"]
            insts.append(Instance(
                name=i["instance_name"],
                abstract_template=i["abstract_template_name"],
                concrete_template=i["concrete_template_name"],
                oX=tr["oX"], oY=tr["oY"], sX=tr["sX"], sY=tr["sY"],
                raw=i,
            ))
        modules.append(Module(
            abstract_name=m["abstract_name"],
            concrete_name=m["concrete_name"],
            bbox=list(m["bbox"]),
            constraints=m.get("constraints", []),
            instances=insts,
            raw=m,
        ))

    return Placement(leaf_bbox=leaf_bbox, leaf_terms=leaf_terms,
                     modules=modules, raw=raw)


def dump(pl: Placement, path: str) -> None:
    """자료구조에서 JSON 을 재구성해 쓴다 (raw 통째 복사가 아니다)."""
    out = copy.deepcopy(pl.raw)

    for l in out.get("leaves", []):
        l["bbox"] = list(pl.leaf_bbox[l["concrete_name"]])

    by_name = {m.concrete_name: m for m in pl.modules}
    for m in out.get("modules", []):
        mod = by_name[m["concrete_name"]]
        m["bbox"] = list(mod.bbox)
        inst_by_name = {i.name: i for i in mod.instances}
        for i in m.get("instances", []):
            inst = inst_by_name[i["instance_name"]]
            i["transformation"] = {
                "oX": inst.oX, "oY": inst.oY, "sX": inst.sX, "sY": inst.sY,
            }

    with open(path, "w", encoding="utf8") as f:
        json.dump(out, f, indent=2)


def placed_box(template_bbox, inst: Instance):
    """템플릿 bbox 를 transformation 으로 옮긴 실제 배치 사각형."""
    x0, y0, x1, y1 = template_bbox
    xs = sorted((inst.sX * x + inst.oX for x in (x0, x1)))
    ys = sorted((inst.sY * y + inst.oY for y in (y0, y1)))
    return xs[0], ys[0], xs[1], ys[1]


def placed_center_size(template_bbox, inst: Instance):
    bx0, by0, bx1, by1 = placed_box(template_bbox, inst)
    return ((bx0 + bx1) / 2, (by0 + by1) / 2), (bx1 - bx0, by1 - by0)
