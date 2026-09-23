"""Like ../../tap/tap.py, but injects extra M5/M6 shapes into node.Nets[0].path_metal right before
RouteWork(2) so that the power-grid obstacle logic (and mode 3 around it) is exercised.
Scenario is read from os.environ['PR_STRESS'] (JSON list of [metal_name, metal_idx, LLx, LLy, URx, URy])."""
import json, os, time, PnR
exec(open('/work/tap_base.py').read().split('_rw = PnR.Router.RouteWork')[0])
_rw = PnR.Router.RouteWork
CALLS = []
SHAPES = json.loads(os.environ.get('PR_STRESS', '[]'))

def inject(node):
    nets = node.Nets
    n0 = nets[0]
    pm = n0.path_metal
    for (mn, mi, a, b, c, d) in SHAPES:
        m = PnR.Metal()
        m.MetalIdx = mi
        cx, cy = (a + c) // 2, (b + d) // 2
        if mi % 2 == 0:   # vertical layer: centre line along y
            m.LinePoint = [PnR.point(cx, b), PnR.point(cx, d)]
            m.width = c - a
        else:
            m.LinePoint = [PnR.point(a, cy), PnR.point(c, cy)]
            m.width = d - b
        r = PnR.contact()
        r.metal = mn
        r.placedBox = PnR.bbox(a, b, c, d)
        r.placedCenter = PnR.point(cx, cy)
        m.MetalRect = r
        pm.append(m)
    n0.path_metal = pm
    nets[0] = n0
    node.Nets = nets

def tapped(self, mode, node, drc, lm, hm, hs, vs, fn):
    k = len(CALLS) + 1
    if mode == 2 and SHAPES:
        inject(node)
    tag = "%02d_%s_m%d" % (k, node.name, mode)
    if mode in (2, 3):
        json.dump(walk(node), open("%s/%s_in.json" % (OUT, tag), "w"))
    if k == 1: json.dump(walk(drc), open("%s/drc.json" % OUT, "w"))
    r = _rw(self, mode, node, drc, lm, hm, hs, vs, fn)
    if mode in (2, 3):
        json.dump(walk(node), open("%s/%s_out.json" % (OUT, tag), "w"))
    CALLS.append({"k": k, "mode": mode, "node": node.name, "Lmetal": lm, "Hmetal": hm})
    json.dump(CALLS, open("%s/calls.json" % OUT, "w"), indent=1)
    return r
PnR.Router.RouteWork = tapped
