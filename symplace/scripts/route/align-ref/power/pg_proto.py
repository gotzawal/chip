#!/usr/bin/env python3
"""Prototype of ALIGN PowerRouter mode 2 (power grid creation) written from the C++ reading,
checked against a hierNode dump taken after route_single_variant (Vdd/Gnd = mode-2 output).

usage: pg_proto.py <route_out.json> <drc_info.json> [W H]
"""
import json
import math
import sys
from functools import cmp_to_key


def cdiv(a, b):  # C++ integer division (truncation toward zero)
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b > 0) else -q


def cmod(a, b):  # C++ % (sign of dividend)
    return a - cdiv(a, b) * b


def ceil_to(v, u):
    """Grid.cpp:1051-1053 ternary: v if v%u==0 else ((v/u)*u < v ? (v/u+1)*u : (v/u)*u)."""
    if cmod(v, u) == 0:
        return v
    t = cdiv(v, u) * u
    return (cdiv(v, u) + 1) * u if t < v else t


def gcd(a, b):  # Grid::gcd (recursive, C++ %)
    while b != 0:
        a, b = b, cmod(a, b)
    return a


FLAGS = dict(cr_bug=True)


def f2i(x):
    """double -> int32 as compiled for wasm32 without nontrapping-fptoint (guarded trunc; out of range -> INT_MIN)."""
    if isinstance(x, float) and (math.isnan(x) or not abs(x) < 2.0 ** 31):
        return -2 ** 31
    return int(x)  # trunc toward zero


class Drc:
    def __init__(self, j):
        self.M = j['Metal_info']
        self.V = j['Via_info']
        self.VM = j['Via_model']
        self.Metalmap = j['Metalmap']
        self.Viamap = j['Viamap']
        self.D = j['Design_info']

    def scaled(self, h, v):
        import copy
        s = copy.deepcopy(self)
        for m in s.M:
            f = h if m['direct'] == 1 else v
            m['grid_unit_x'] *= f
            m['grid_unit_y'] *= f
        return s


# ---------------------------------------------------------------- ConvertRect2GridPoints
def convert_rect(plist, drc, cross, layerNo, m, LLx, LLy, URx, URy):
    """GcellDetailRouter.cpp:4127-4330 (enclose_length == 0)."""
    obs_l, obs_h = 0, layerNo - 1
    mi = drc.M[m]
    if mi['direct'] == 0:
        cu = mi['grid_unit_x']
        nLLx = LLx - cu + cdiv(mi['width'], 2)
        nURx = URx + cu - cdiv(mi['width'], 2)
        bX = nLLx + cu if cmod(nLLx, cu) == 0 else (
            (cdiv(nLLx, cu) + 1) * cu if cdiv(nLLx, cu) * cu < nLLx else cdiv(nLLx, cu) * cu)
        x = bX
        while x < nURx:
            for nb in ([m - 1] if m != obs_l else []) + ([m + 1] if m != obs_h else []):
                nu = cross.M[nb]['grid_unit_y']
                nLLy = LLy - mi['dist_ee']
                nURy = URy + mi['dist_ee']
                bY = f2i(math.ceil(nLLy / nu) * nu)
                if bY > nURy:
                    nLLy = f2i(math.floor(nLLy / nu) * nu)
                    nURy = f2i(math.ceil(nLLy / nu) * nu)
                    bY = nLLy
                y = bY
                while y <= nURy:
                    if nLLx <= x <= nURx and nLLy <= y <= nURy:
                        plist[m].append((x, y))
                    y += nu
            x += cu
    elif mi['direct'] == 1:
        cu = mi['grid_unit_y']
        nLLy = LLy - cu + cdiv(mi['width'], 2)
        nURy = URy + cu - cdiv(mi['width'], 2)
        bY = nLLy + cu if cmod(nLLy, cu) == 0 else (
            (cdiv(nLLy, cu) + 1) * cu if cdiv(nLLy, cu) * cu < nLLy else cdiv(nLLy, cu) * cu)
        y = bY
        while y < nURy:
            for nb in ([m - 1] if m != obs_l else []) + ([m + 1] if m != obs_h else []):
                nu = cross.M[nb]['grid_unit_x']
                nLLx = LLx - mi['dist_ee']
                nURx = URx + mi['dist_ee']
                bX = f2i(math.ceil(nLLx / nu) * nu)
                if bX > nURx:
                    nLLx = f2i(math.floor(nLLx / nu) * nu)
                    nURx = f2i(math.ceil((nLLy if FLAGS['cr_bug'] else nLLx) / nu) * nu)   # sic: uses nLLy (C++ bug, line 4277/4310)
                    bX = nLLx
                x = bX
                while x <= nURx:
                    if nLLx <= x <= nURx and nLLy <= y <= nURy:
                        plist[m].append((x, y))
                    x += nu
            y += cu


def rect_of(c):
    return c['p']


def metal_idx(drc, name):
    return drc.Metalmap.get(name, -1)


def build_obstacles(node, drc, cross, layerNo):
    plist = [[] for _ in range(layerNo)]

    def contact(c):
        m = metal_idx(drc, c['metal'])
        LLx, LLy, URx, URy = rect_of(c)
        convert_rect(plist, drc, cross, layerNo, m, LLx, LLy, URx, URy)

    # CreatePlistBlocks
    for bc in node['Blocks']:
        inst = bc['instance'][bc['selectedInstance']]
        for p in inst['pins']:
            for c in p['c']:
                contact(c)
            for v in p['v']:
                contact(v['U'])
                contact(v['L'])
        for c in inst['interMetals']:
            contact(c)
        for v in inst['interVias']:
            contact(v['U'])
            contact(v['L'])
    # CreatePlistNets
    for n in node['Nets']:
        for mt in n['path_metal']:
            m = mt['idx']
            LLx, LLy, URx, URy = mt['r']['p']
            convert_rect(plist, drc, cross, layerNo, m, LLx, LLy, URx, URy)
        for v in n['path_via']:
            contact(v['U'])
            contact(v['L'])
    # CreatePlistTerminals (metal >= 0)
    for t in node['Terminals']:
        for c in t['termContacts']:
            if metal_idx(drc, c['metal']) >= 0:
                contact(c)
    # PowerNets paths / Vdd / Gnd are empty in mode 2
    S = set()
    for m, pts in enumerate(plist):
        for (x, y) in pts:
            S.add((x, y, m))
    return S


def findset_plist(S, LL, UR, lo, hi, layerNo):
    """RawRouter::FindsetPlist -- two lexicographic range scans."""
    def k1(e):
        return (e[0], e[1], e[2])
    low1, up1 = (LL[0], LL[1], lo), (UR[0], UR[1], hi)
    stage1 = [e for e in S if low1 <= k1(e) <= up1]
    low2, up2 = (LL[1], LL[0], lo), (UR[1], UR[0], hi)
    out = [set() for _ in range(layerNo)]
    for e in stage1:
        k = (e[1], e[0], e[2])
        if low2 <= k <= up2:
            out[e[2]].add((e[0], e[1]))
    return out


# ---------------------------------------------------------------- Grid (Grid.cpp:993-1262)
class V:
    __slots__ = ('x', 'y', 'metal', 'power', 'active', 'index', 'north', 'south', 'east', 'west', 'up', 'down',
                 'graph_index')

    def __init__(self):
        self.north, self.south, self.east, self.west = [], [], [], []
        self.up = self.down = -1
        self.graph_index = -1


def build_grid(drc, LL, UR, Lm, Hm, scale=1):
    layerNo = len(drc.M)
    x_unit = [0] * layerNo
    y_unit = [0] * layerNo
    for i, m in enumerate(drc.M):
        if m['direct'] == 0:
            x_unit[i] = m['grid_unit_x'] * scale
        else:
            y_unit[i] = m['grid_unit_y'] * scale
    VT = []
    start = [0] * layerNo
    end = [-1] * layerNo
    vmap = [dict() for _ in range(layerNo)]
    Power = False
    for i in range(Lm, Hm + 1):
        start[i] = len(VT)
        if drc.M[i]['direct'] == 0:
            cu = x_unit[i]
            LLx = ceil_to(LL[0], cu)
            if i == 0:
                nu = y_unit[1]
                LLy = ceil_to(LL[1], y_unit[1])
            elif i == layerNo - 1:
                nu = y_unit[i - 1]
                LLy = ceil_to(LL[1], y_unit[i - 1])
            else:
                nu = gcd(y_unit[i - 1], y_unit[i + 1])
                LLy = min(ceil_to(LL[1], y_unit[i - 1]), ceil_to(LL[1], y_unit[i + 1]))
            X = LLx
            while X <= UR[0]:
                Power = not Power
                Y = LLy
                while Y <= UR[1]:
                    ok = (i == 0 or i == layerNo - 1 or cmod(Y, y_unit[i - 1]) == 0 or cmod(Y, y_unit[i + 1]) == 0)
                    if ok:
                        v = V()
                        v.x, v.y, v.metal, v.power, v.active = X, Y, i, 1 if Power else 0, True
                        v.index = len(VT)
                        w = v.index - 1
                        if w >= start[i] and VT[w].x == X and Y - VT[w].y >= 1:
                            v.south.append(w)
                            VT[w].north.append(v.index)
                        VT.append(v)
                        vmap[i].setdefault((X, Y), len(VT) - 1)
                    Y += nu
                X += cu
        else:
            cu = y_unit[i]
            LLy = ceil_to(LL[1], cu)
            if i == 0:
                nu = x_unit[1]
                LLx = ceil_to(LL[0], x_unit[1])
            elif i == layerNo - 1:
                nu = x_unit[i - 1]
                LLx = ceil_to(LL[0], x_unit[i - 1])
            else:
                nu = gcd(x_unit[i - 1], x_unit[i + 1])
                LLx = min(ceil_to(LL[0], x_unit[i - 1]), ceil_to(LL[0], x_unit[i + 1]))
            Y = LLy
            while Y <= UR[1]:
                Power = not Power
                X = LLx
                while X <= UR[0]:
                    ok = (i == 0 or i == layerNo - 1 or cmod(X, x_unit[i - 1]) == 0 or cmod(X, x_unit[i + 1]) == 0)
                    if ok:
                        v = V()
                        v.x, v.y, v.metal, v.power, v.active = X, Y, i, 1 if Power else 0, True
                        v.index = len(VT)
                        w = v.index - 1
                        if w >= start[i] and VT[w].y == Y and X - VT[w].x >= 1:
                            v.west.append(w)
                            VT[w].east.append(v.index)
                        VT.append(v)
                        vmap[i].setdefault((X, Y), len(VT) - 1)
                    X += nu
                Y += cu
        end[i] = len(VT) - 1
    for k in range(Lm, Hm):
        for i in range(start[k], end[k] + 1):
            j = vmap[k + 1].get((VT[i].x, VT[i].y))
            if j is not None:
                VT[i].up = j
                VT[j].down = i
    return VT, vmap


# ---------------------------------------------------------------- Graph::CreatePower_Grid
def prepare_graph(VT, vmap, LL, UR):
    VG, t2g = [], {}
    for k in range(len(vmap)):
        for (px, py) in sorted(vmap[k]):
            i = vmap[k][(px, py)]
            if not ((LL[0], LL[1]) <= (px, py) <= (UR[0], UR[1])):
                continue
            v = VT[i]
            if v.active and LL[0] <= v.x <= UR[0] and LL[1] <= v.y <= UR[1]:
                g = V()
                for a in V.__slots__:
                    val = getattr(v, a)
                    setattr(g, a, list(val) if isinstance(val, list) else val)
                g.graph_index = -1
                VG.append(g)
                t2g[i] = len(VG) - 1
    return VG, t2g


def dfs(VG, t2g, root, gidx, power):
    """Exact emulation of the recursive Graph::power_grid_dsf including repeated visits."""
    count = 0

    def visit(i):
        nonlocal count
        VG[i].graph_index = gidx
        count += 1
        adj = []
        for lst in (VG[i].north, VG[i].south, VG[i].east, VG[i].west):
            for t in lst:
                g = t2g.get(t)
                if g is not None and VG[g].active and VG[g].power == power and VG[g].graph_index == -1:
                    adj.append(g)
        for t in (VG[i].up, VG[i].down):
            g = t2g.get(t)
            if g is not None and VG[g].active and VG[g].power == power and VG[g].graph_index == -1:
                adj.append(g)
        return adj

    stack = [[visit(root), 0]]
    while stack:
        fr = stack[-1]
        if fr[1] >= len(fr[0]):
            stack.pop()
            continue
        nxt = fr[0][fr[1]]
        fr[1] += 1
        stack.append([visit(nxt), 0])
    return count


def connection_check(VG, t2g, power):
    sizes = []
    gi = 0
    for i in range(len(VG)):
        if VG[i].graph_index == -1 and VG[i].power == power and VG[i].active:
            sizes.append(dfs(VG, t2g, i, gi, power))
            gi += 1
    mx, mi = -1, -1
    for i, s in enumerate(sizes):
        if s > mx:
            mx, mi = s, i
    for v in VG:
        if v.power == power and v.graph_index != mi:
            v.active = False
    return sizes, mi


def metal_key(m):  # RouterDB::MetalComp -- LinePoint[0].y is never compared (bug)
    return (m[0], m[1][0][0], m[1][1][0], m[1][1][1])


def create_power_grid(VG, t2g, drc):
    connection_check(VG, t2g, 1)
    connection_check(VG, t2g, 0)
    vset = {1: {}, 0: {}}
    vlist = {1: [], 0: []}
    viaset = {1: set(), 0: set()}

    def check_active(g):
        for lst in (VG[g].north, VG[g].south, VG[g].east, VG[g].west):
            for t in lst:
                h = t2g.get(t)
                if h is not None and VG[h].active:
                    return True
        return False

    for i, v in enumerate(VG):
        if not v.active:
            continue
        LLp = (v.x, v.y)
        for lst in (v.north, v.south, v.east, v.west):
            for t in lst:
                g = t2g.get(t)
                if g is None:
                    continue
                for p in (1, 0):
                    if VG[g].active and v.power == p and VG[g].power == p:
                        URp = (VG[g].x, VG[g].y)
                        if LLp[0] == URp[0]:
                            pts = (LLp, URp) if LLp[1] <= URp[1] else (URp, LLp)
                        else:
                            pts = (LLp, URp) if LLp[0] <= URp[0] else (URp, LLp)
                        mt = (v.metal, pts)
                        vset[p].setdefault(metal_key(mt), mt)   # std::set::insert keeps first
                        vlist[p].append(mt)
        for t in (v.down, v.up):
            if t == -1:
                continue
            g = t2g.get(t)
            if g is None:
                continue
            for p in (1, 0):
                if VG[g].active and v.power == p and VG[g].power == p and check_active(g) and check_active(i):
                    viaset[p].add((min(v.metal, VG[g].metal), v.x, v.y))
    res = {}
    for p in (1, 0):
        metals = [vset[p][k] for k in sorted(vset[p])]
        res[p] = dict(metals=metals, vias=sorted(viaset[p]), raw=vlist[p], merged=merge(vlist[p]))
    return res


def merge(lst):
    out = []
    if not lst:
        return [None]  # C++ pushes an uninitialised Metal
    cur = [lst[0][0], [list(lst[0][1][0]), list(lst[0][1][1])]]
    for m, (a, b) in lst[1:]:
        if m == cur[0] and m % 2 == 0 and a[0] == cur[1][0][0] and b[0] == cur[1][1][0] and cur[1][0][1] <= a[1] <= cur[1][1][1]:
            cur[1][1][1] = max(b[1], cur[1][1][1])
        elif m == cur[0] and m % 2 == 1 and a[1] == cur[1][0][1] and b[1] == cur[1][1][1] and cur[1][0][0] <= a[0] <= cur[1][1][0]:
            cur[1][1][0] = max(b[0], cur[1][1][0])
        else:
            out.append(cur)
            cur = [m, [list(a), list(b)]]
    out.append(cur)
    return out


def rect(mt, w):
    (x0, y0), (x1, y1) = mt[1]
    h = cdiv(w, 2)
    if y0 == y1:
        if x0 < x1:
            return [x0 - h, y0 - h, x1 + h, y1 + h]
        return [x1 - h, y1 - h, x0 + h, y0 + h]
    if y0 < y1:
        return [x0 - h, y0 - h, x1 + h, y1 + h]
    return [x1 - h, y1 - h, x0 + h, y0 + h]


def main():
    node = json.load(open(sys.argv[1]))
    drc = Drc(json.load(open(sys.argv[2])))
    W, H = (int(sys.argv[3]), int(sys.argv[4])) if len(sys.argv) > 4 else (node['width'], node['height'])
    Lm, Hm = drc.D['power_grid_metal_l'], drc.D['power_grid_metal_u']
    hs, vs = drc.D['h_skip_factor'], drc.D['v_skip_factor']
    pg = drc.scaled(hs, vs)
    layerNo = len(drc.M)
    LL = (0, 0)
    UR = [W, H]
    # UpdatePowerGridLLUR
    x_grid = y_grid = -1
    hi, lo = pg.M[Hm], pg.M[Lm]
    if hi['direct'] == 1:
        y_grid = hi['grid_unit_y']
    else:
        x_grid = hi['grid_unit_x']
    if lo['direct'] == 1:
        y_grid = lo['grid_unit_y']
    else:
        x_grid = lo['grid_unit_x']
    if y_grid == -1:
        y_grid = pg.M[Hm - 1]['grid_unit_y']
    if x_grid == -1:
        x_grid = pg.M[Hm - 1]['grid_unit_x']
    UR[0] = max(UR[0], x_grid)
    UR[1] = max(UR[1], y_grid)
    UR = tuple(UR)
    S = build_obstacles(node, drc, pg, layerNo)
    VT, vmap = build_grid(pg, LL, UR, Lm, Hm)
    pl = findset_plist(S, LL, UR, Lm, Hm, layerNo)
    ninact = 0
    for v in VT:
        if (v.x, v.y) in pl[v.metal]:
            v.active = False
            ninact += 1
    VG, t2g = prepare_graph(VT, vmap, LL, UR)
    res = create_power_grid(VG, t2g, pg)
    print(f'UR={UR} vertices={len(VT)} inactivated={ninact} graph={len(VG)}')
    ok = True
    for p, key in ((1, 'Vdd'), (0, 'Gnd')):
        mine = [(m[0], [list(m[1][0]), list(m[1][1])], rect(m, pg.M[m[0]]['width'])) for m in res[p]['metals']]
        ref = [(m['idx'], m['pts'], m['r']['p']) for m in node[key]['metals']]
        vm = [(v[0], [v[1], v[2]]) for v in res[p]['vias']]
        vr = [(v['model'], v['ppos']) for v in node[key]['vias']]
        same_m = mine == ref
        same_v = vm == vr
        ok &= same_m and same_v
        print(f'{key}: metals mine={len(mine)} ref={len(ref)} identical(order+rects)={same_m}; '
              f'vias mine={len(vm)} ref={len(vr)} identical={same_v}; merged={len(res[p]["merged"])}')
        if not same_m:
            sm, sr = set(map(str, mine)), set(map(str, ref))
            print('  only mine:', sorted(sm - sr)[:5])
            print('  only ref :', sorted(sr - sm)[:5])
        if not same_v:
            print('  only mine:', sorted(set(map(str, vm)) - set(map(str, vr)))[:5])
            print('  only ref :', sorted(set(map(str, vr)) - set(map(str, vm)))[:5])
    print('ALL MATCH' if ok else 'MISMATCH')


if __name__ == '__main__':
    main()
