"""RouteWork 앞뒤로 hierNode 와 Drc_info 를 JSON 으로 뜬다 (기준값)."""
import json, os, time, PnR
OUT = "/work/tap"
os.makedirs(OUT, exist_ok=True)
_prim = (int, float, str, bool, type(None))
def walk(o, depth=0):
    if isinstance(o, _prim): return o
    if depth > 14: return "<deep>"
    if isinstance(o, (list, tuple)): return [walk(x, depth + 1) for x in o]
    if isinstance(o, dict): return {str(k): walk(v, depth + 1) for k, v in o.items()}
    if hasattr(o, "__members__"): return str(o)
    d = {}
    for k in dir(o):
        if k.startswith("_"): continue
        try: v = getattr(o, k)
        except Exception: continue
        if callable(v) and not isinstance(v, (list, dict)): continue
        d[k] = walk(v, depth + 1)
    return d
_rw = PnR.Router.RouteWork
CALLS = []
def tapped(self, mode, node, drc, lm, hm, hs, vs, fn):
    k = len(CALLS) + 1
    tag = "%02d_%s_m%d" % (k, node.name, mode)
    json.dump(walk(node), open("%s/%s_in.json" % (OUT, tag), "w"))
    if k == 1: json.dump(walk(drc), open("%s/drc.json" % OUT, "w"))
    t = time.perf_counter()
    r = _rw(self, mode, node, drc, lm, hm, hs, vs, fn)
    dt = time.perf_counter() - t
    json.dump(walk(node), open("%s/%s_out.json" % (OUT, tag), "w"))
    CALLS.append({"k": k, "mode": mode, "node": node.name, "isTop": node.isTop, "Lmetal": lm, "Hmetal": hm,
                  "nets": len(node.Nets), "blocks": len(node.Blocks), "terminals": len(node.Terminals),
                  "snets": len(node.SNets), "powerNets": len(node.PowerNets),
                  "path_metal": sum(len(n.path_metal) for n in node.Nets),
                  "path_via": sum(len(n.path_via) for n in node.Nets),
                  "vdd": len(node.Vdd.metals), "gnd": len(node.Gnd.metals),
                  "pwr_metal": sum(len(n.path_metal) for n in node.PowerNets),
                  "secs": round(dt, 3)})
    json.dump(CALLS, open("%s/calls.json" % OUT, "w"), indent=1)
    return r
PnR.Router.RouteWork = tapped
