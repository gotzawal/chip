"""RouteWork 호출마다 배선기가 hierNode 에 쓴 필드("기록")를 뜬다.

페이지의 "배선 · ALIGN 원본" (alignworker.mjs) 이 Rust 이식(symplace/alignroute)과 모듈·단계·넷 단위로
견주려고 쓴다. 모양은 src/route/align/records.mjs 의 recordOf 와 같다 — pybind 로 묶인 필드를 그대로
걸어 뜬다 (symplace/scripts/route/align-ref/tap/tap.py 와 같은 걸음). 배선 결과는 건드리지 않는다.

    import aligntap; aligntap.install()      # 한 번
    aligntap.RECORDS.clear(); route(...)     # 배선마다
    json.dumps(aligntap.RECORDS)
"""
import time

import PnR

RECORDS = []
_prim = (int, float, str, bool, type(None))


def walk(o, depth=0):
    if isinstance(o, _prim):
        return o
    if depth > 14:
        return "<deep>"
    if isinstance(o, (list, tuple)):
        return [walk(x, depth + 1) for x in o]
    if isinstance(o, dict):
        return {str(k): walk(v, depth + 1) for k, v in o.items()}
    if hasattr(o, "__members__"):       # pybind 열거형
        return str(o)
    d = {}
    for k in dir(o):
        if k.startswith("_"):
            continue
        try:
            v = getattr(o, k)
        except Exception:
            continue
        if callable(v) and not isinstance(v, (list, dict)):
            continue
        d[k] = walk(v, depth + 1)
    return d


def _pick(o, keys):
    return {k: walk(getattr(o, k)) for k in keys}


def record(node, mode):
    if mode == 4:
        return {"tiles_total": walk(node.tiles_total),
                "Nets": [_pick(n, ["name", "GcellGlobalRouterPath", "connectedTile"]) for n in node.Nets]}
    if mode == 5:
        return {"Nets": [_pick(n, ["name", "path_metal", "path_via"]) for n in node.Nets],
                "blockPins": walk(node.blockPins), "interMetals": walk(node.interMetals),
                "interVias": walk(node.interVias),
                "Terminals": [_pick(t, ["name", "termContacts"]) for t in node.Terminals]}
    if mode == 2:
        return {"Vdd": _pick(node.Vdd, ["name", "metals", "vias"]),
                "Gnd": _pick(node.Gnd, ["name", "metals", "vias"])}
    if mode == 3:
        return {"PowerNets": [_pick(p, ["name", "path_metal", "path_via"]) for p in node.PowerNets],
                "LL": walk(node.LL), "UR": walk(node.UR), "width": node.width, "height": node.height}
    return None


_installed = []


def install():
    if _installed:
        return
    rw = PnR.Router.RouteWork

    def tapped(self, mode, node, drc, *a):
        t = time.perf_counter()
        r = rw(self, mode, node, drc, *a)
        ms = (time.perf_counter() - t) * 1000
        RECORDS.append({"module": node.name, "mode": mode, "ms": ms, "out": record(node, mode)})
        return r

    PnR.Router.RouteWork = tapped
    _installed.append(rw)
