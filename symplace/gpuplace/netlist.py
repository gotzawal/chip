"""배치 JSON 에서 핀과 넷을 뽑는다.

두 군데를 맞물려 읽는다.
  leaves[].terminals[]  : 템플릿 좌표계에서의 핀 사각형
  instances[].fa_map[]  : 이 인스턴스의 핀(formal) 이 어느 넷(actual) 에 붙는지

전원·접지 넷은 뺀다. 배선 단계에서 별도의 전원 그리드로 깔리므로
배선길이 최소화 대상이 아니다. (PowerPorts / GroundPorts 제약이 알려준다)
"""
from __future__ import annotations

import numpy as np


def power_ground_nets(module) -> set:
    out = set()
    for c in module.constraints:
        if c.get("constraint") in ("PowerPorts", "GroundPorts", "ClockPorts"):
            out.update(p.upper() for p in c.get("ports", []))
    out.update({"0", "VDD", "GND", "VSS"})
    return out


def extract(pl, module):
    """반환값

    pin_inst : (P,) int    각 핀이 속한 인스턴스 번호
    pin_off  : (P, 2) float 블록 중심 기준 핀 오프셋 (템플릿 좌표계)
    pin_net  : (P,) int    각 핀이 속한 넷 번호
    net_names: list[str]
    """
    skip = power_ground_nets(module)

    pin_inst, pin_off, pin_net = [], [], []
    net_id, net_names = {}, []

    for k, inst in enumerate(module.instances):
        tb = pl.template_bbox(inst.concrete_template)
        # leaf 든 하위 모듈이든 똑같이 포트 위치를 받아온다 (계층 지원)
        pins = pl.template_pins(inst.concrete_template)
        if tb is None or not pins:
            continue

        fa = {f["formal"]: f["actual"] for f in inst.raw.get("fa_map", [])}
        for formal, (dx, dy) in pins.items():
            net = fa.get(formal)
            if net is None or net.upper() in skip:
                continue
            if net not in net_id:
                net_id[net] = len(net_names)
                net_names.append(net)
            pin_inst.append(k)
            pin_off.append([dx, dy])
            pin_net.append(net_id[net])

    # 핀이 하나뿐인 넷은 길이가 0 이라 최적화에 기여하지 않는다. 빼서 계산을 줄인다.
    pin_net = np.array(pin_net, dtype=np.int64)
    if len(pin_net):
        cnt = np.bincount(pin_net, minlength=len(net_names))
        keep_net = cnt >= 2
        remap = -np.ones(len(net_names), dtype=np.int64)
        remap[keep_net] = np.arange(keep_net.sum())
        mask = remap[pin_net] >= 0
        pin_inst = np.array(pin_inst)[mask]
        pin_off = np.array(pin_off, dtype=float)[mask]
        pin_net = remap[pin_net][mask]
        net_names = [n for n, k in zip(net_names, keep_net) if k]
    else:
        pin_inst = np.zeros(0, dtype=np.int64)
        pin_off = np.zeros((0, 2))

    return pin_inst, pin_off, pin_net, net_names
