#!/usr/bin/env python3
"""Prototype of ALIGN PowerRouter mode 3 (power net routing), written from the C++ reading.
Checked against RouteWork tap dumps (m3_in -> m3_out).  merged_metals (not exported by pybind)
are recomputed with the mode-2 prototype from m2_in."""
import heapq
import math
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import pg_proto as PG  # noqa: E402
from pg_proto import cdiv, cmod, ceil_to, gcd, f2i  # noqa: E402

INT_MAX = 2 ** 31 - 1
INT_MIN = -2 ** 31
DBL_MAX = sys.float_info.max
FLAGS = dict(vertex0=True, viaset_lex=True, src_key_unitR=True, dest_dedup=True, ext_check_true=True, redundant_swap=True, via_dup=True, findset_box=True)


# ------------------------------------------------------------------ small helpers
def mdx(drc, name):
    return drc.Metalmap.get(name, -1)


class Metal:
    __slots__ = ('idx', 'lp', 'w', 'rect', 'center')

    def __init__(self, idx, lp, w, rect=None, center=(0, 0)):
        self.idx, self.lp, self.w = idx, [list(lp[0]), list(lp[1])], w
        self.rect = list(rect) if rect else [0, 0, 0, 0]
        self.center = list(center)

    def copy(self):
        return Metal(self.idx, self.lp, self.w, self.rect, self.center)


def update_metal_contact(m):  # PowerRouter/GcellDetailRouter::UpdateMetalContact
    (x0, y0), (x1, y1) = m.lp
    h = cdiv(m.w, 2)
    m.center = [cdiv(x0 + x1, 2), cdiv(y0 + y1, 2)]
    if y0 == y1:
        m.rect = [x0, y0 - h, x1, y1 + h] if x0 < x1 else [x1, y1 - h, x0, y0 + h]
    else:
        m.rect = [x0 - h, y0, x1 + h, y1] if y0 < y1 else [x1 - h, y1, x0 + h, y0]


def phys_rect_power(m):  # PowerRouter::GetPhsical_Metal_Via metal part
    update_metal_contact(m)
    (x0, y0), (x1, y1) = m.lp
    if x0 == x1 and y0 == y1:
        h = cdiv(m.w, 2)
        m.rect = [x0 - h, y0 - h, x1 + h, y1 + h]


def phys_rect_by_layer(drc, m):  # GcellDetailRouter::GetPhsical_Metal
    (x0, y0), (x1, y1) = m.lp
    h = cdiv(m.w, 2)
    if drc.M[m.idx]['direct'] == 1:
        m.rect = [x0, y0 - h, x1, y1 + h] if x0 <= x1 else [x1, y1 - h, x0, y0 + h]
    else:
        m.rect = [x0 - h, y0, x1 + h, y1] if y0 <= y1 else [x1 - h, y1, x0 + h, y0]


def extend_metal(drc, m, label):
    """body of ExtendMetals / UpdatePlistNets extension (identical in both)."""
    if label == 0:
        return
    direction = drc.M[m.idx]['direct']
    minL = drc.M[m.idx]['minL']
    (x0, y0), (x1, y1) = m.lp
    cur = abs(x0 - x1) + abs(y0 - y1)
    if cur < minL and label == 1:
        d = int(float(minL - cur) / 2)
        if direction == 1:
            if x0 < x1:
                m.lp[0][0] -= d; m.lp[1][0] += d
            else:
                m.lp[0][0] += d; m.lp[1][0] -= d
        else:
            if y0 < y1:
                m.lp[0][1] -= d; m.lp[1][1] += d
            else:
                m.lp[0][1] += d; m.lp[1][1] -= d
        update_metal_contact(m)
    elif cur < minL and label in (2, 3):
        d = minL - cur
        P = (label == 2)
        k = 0 if direction == 1 else 1
        a, b = m.lp[0][k], m.lp[1][k]
        if P:
            if a < b:
                m.lp[1][k] = b + d
            else:
                m.lp[0][k] = a + d
        else:
            if a < b:
                m.lp[0][k] = a - d
            else:
                m.lp[1][k] = b - d
        update_metal_contact(m)


def via_rects(drc_j, model, x, y):
    vm = drc_j['Via_model'][model]

    def r(key):
        R = vm[key]
        return [x + R[0]['x'], y + R[0]['y'], x + R[1]['x'], y + R[1]['y']]
    return {'model': model, 'pos': [x, y], 'V': r('ViaRect'), 'L': r('LowerRect'), 'U': r('UpperRect'),
            'Lm': vm['LowerIdx'], 'Um': vm['UpperIdx']}


def vias_between(metals, drc_j):
    """set<Via, ViaComp> over all ordered pairs (h,l), metal_h == metal_l - 1, coinciding endpoints."""
    s = set()
    for h, a in enumerate(metals):
        for l, b in enumerate(metals):
            if l == h or a.idx != b.idx - 1:
                continue
            for pa in (a.lp[0], a.lp[1]):
                for pb in (b.lp[0], b.lp[1]):
                    if pa[0] == pb[0] and pa[1] == pb[1]:
                        s.add((a.idx, pa[0], pa[1]))
    return [via_rects(drc_j, m, x, y) for (m, x, y) in sorted(s)]


# ------------------------------------------------------------------ Grid (mode 3)
class Grid:
    def __init__(self, drc, LL, UR, Lm, Hm):
        self.drc = drc
        self.VT, self.vmap = PG.build_grid(drc, LL, UR, Lm, Hm)
        n = len(self.VT)
        self.via_up = [True] * n
        self.via_down = [True] * n
        self.start = [0] * len(drc.M)
        self.end = [-1] * len(drc.M)
        for i, v in enumerate(self.VT):
            if self.end[v.metal] == -1:
                self.start[v.metal] = i
            self.end[v.metal] = i
        self.Source, self.Dest = [], []
        self.vertex0_hits = 0

    def lookup(self, m, x, y):  # vertices_total_map.at(m)[p] -- operator[] inserts 0 when absent
        i = self.vmap[m].get((x, y))
        if i is None:
            if not FLAGS['vertex0']:
                return None
            self.vmap[m][(x, y)] = 0
            self.vertex0_hits += 1
            return 0
        return i


def inact_via(G, m, LLx, LLy, URx, URy, up):
    """GcellDetailRouter::InactivateRect2GridPoints_Via (GcellDetailRouter.cpp:4574-4665)."""
    drc = G.drc
    layerNo = len(drc.M)
    mi = drc.M[m]

    def hit(x, y):
        i = G.lookup(m, x, y)
        if i is None:
            return
        if up:
            G.via_up[i] = False
        else:
            G.via_down[i] = False

    def first(v, n):
        return (cdiv(v, n) + 1) * n if cmod(v, n) == 0 else f2i(math.ceil(v / n) * n)
    if mi['direct'] == 0:
        cu = mi['grid_unit_x']
        x = f2i(math.ceil(LLx / cu) * cu)
        while x < URx:
            for nb in ([m - 1] if m != 0 else []) + ([m + 1] if m != layerNo - 1 else []):
                n = drc.M[nb]['grid_unit_y']
                y = first(LLy, n)
                while y < URy:
                    if LLx <= x <= URx and LLy <= y <= URy:
                        hit(x, y)
                    y += n
            x += cu
    elif mi['direct'] == 1:
        cu = mi['grid_unit_y']
        y = f2i(math.ceil(LLy / cu) * cu)
        while y < URy:
            for nb in ([m - 1] if m != 0 else []) + ([m + 1] if m != layerNo - 1 else []):
                n = drc.M[nb]['grid_unit_x']
                x = first(LLx, n)
                while x < URx:
                    if LLx <= x <= URx and LLy <= y <= URy:
                        hit(x, y)
                    x += n
            y += cu


def pin_points(drc, layerNo, m, rect):
    """Grid::Mapping_function_pin(_detail) + Map_from_seg2gridseg_pin(_detail) with offset 0."""
    M = drc.M
    if M[m]['direct'] == 0:
        if m == 0:
            g = [(M[m]['grid_unit_x'], M[m + 1]['grid_unit_y'])] * 2
        elif m == layerNo - 1:
            g = [(M[m]['grid_unit_x'], M[m - 1]['grid_unit_y'])] * 2
        else:
            g = [(M[m]['grid_unit_x'], M[m - 1]['grid_unit_y']), (M[m]['grid_unit_x'], M[m + 1]['grid_unit_y'])]
    else:
        if m == 0:
            g = [(M[m + 1]['grid_unit_x'], M[m]['grid_unit_y'])] * 2
        elif m == layerNo - 1:
            g = [(M[m - 1]['grid_unit_x'], M[m]['grid_unit_y'])] * 2
        else:
            g = [(M[m - 1]['grid_unit_x'], M[m]['grid_unit_y']), (M[m + 1]['grid_unit_x'], M[m]['grid_unit_y'])]
    Lx, Ly, Ux, Uy = rect
    pts = set()
    for gx, gy in g:
        gLx = cdiv(Lx, gx) * gx
        gUx = f2i(math.ceil(Ux / gx)) * gx
        gLy = cdiv(Ly, gy) * gy
        gUy = f2i(math.ceil(Uy / gy)) * gy
        for i in range(0, cdiv(gUx - gLx, gx) + 1):
            x = gLx + i * gx
            if Lx <= x <= Ux:
                for j in range(0, cdiv(gUy - gLy, gy) + 1):
                    y = gLy + j * gy
                    if Ly <= y <= Uy:
                        pts.add((x, y))
    return pts


def map_pin(G, m, rect, detail):
    drc = G.drc
    if m < 0 or m > len(drc.M):
        return []
    pts = pin_points(drc, len(drc.M), m, rect)
    out = []
    for i in range(G.start[m], G.end[m] + 1):
        v = G.VT[i]
        if detail and not v.active:
            continue
        if (v.x, v.y) in pts:
            out.append(i)
    return out


def set_src_dest(G, srcs, dsts, detail):
    G.Source, G.Dest = [], []
    for (m, rect) in srcs:
        G.Source += map_pin(G, m, rect, detail)
    if srcs and not G.Source:
        return
    for (m, rect) in dsts:
        G.Dest += map_pin(G, m, rect, detail)


# ------------------------------------------------------------------ A* (A_star.cpp)
class AStar:
    def __init__(self, G):
        self.G = G
        self.drc = G.drc
        self.source = list(G.Source)
        self.dest = list(G.Dest)
        n = len(G.VT)
        self.Cost = [DBL_MAX] * n
        self.parent = [-1] * n
        self.tbn = [-1] * n
        self.Path = []
        self.labels = []

    def v(self, i):
        return self.G.VT[i]

    def mdist(self, s):
        best = INT_MAX
        vs = self.v(s)
        for d in self.dest:
            vd = self.v(d)
            best = min(best, abs(vs.x - vd.x) + abs(vs.y - vd.y))
        return best

    # ---- extension checks
    def walk(self, start, direction, half):
        VT = self.G.VT
        n = len(VT)
        cl, d = 0, start
        while True:
            if cl >= half:
                return True
            nx = d + direction
            if nx < 0 or nx >= n:
                return False
            if not VT[nx].active:
                return False
            if (VT[nx].x != VT[start].x and VT[nx].y != VT[start].y) or VT[nx].metal != VT[start].metal:
                return False
            cl = abs(VT[nx].x - VT[start].x) + abs(VT[nx].y - VT[start].y)
            d = nx

    def dirs(self, first, cur):
        return (-1, 1) if first <= cur else (1, -1)

    def ext_half(self, first, cur, length, minL):
        half = f2i(math.ceil((float(minL) - float(length)) / 2))
        fd, cd = self.dirs(first, cur)
        a = self.walk(first, fd, half)
        b = self.walk(cur, cd, half)
        return a and b

    def ext_head(self, first, cur, length, minL):
        half = f2i(math.ceil(float(minL) - float(length)))
        fd, cd = self.dirs(first, cur)
        return self.walk(first, fd, half), fd

    def ext_tail(self, first, cur, length, minL):
        half = f2i(math.ceil(float(minL) - float(length)))
        fd, cd = self.dirs(first, cur)
        return self.walk(cur, cd, half), cd

    def trace_same_layer(self, cur, ptr):
        first, d = cur, cur
        VT = self.G.VT
        while True:
            last = ptr[d]
            if last < 0 or last >= len(VT):
                return first
            if VT[last].metal == VT[d].metal and last != cur:
                first = d = last
            elif VT[last].metal != VT[d].metal and last != cur:
                return first
            else:
                raise RuntimeError('infinite loop in trace_back_node(_parent)')

    def via_space(self, metal_run, m_other_a, m_other_b):
        V = self.drc.V
        vi = min(m_other_a, m_other_b)
        if self.drc.M[metal_run]['direct'] == 1:
            return V[vi]['width'] + V[vi]['dist_ss']
        return V[vi]['width_y'] + V[vi]['dist_ss_y']

    def ext_prime(self, cur, nxt, src):
        VT = self.G.VT
        nsl = self.trace_same_layer(cur, self.parent)
        if nsl in src:
            return True
        metal = VT[cur].metal
        length = abs(VT[cur].x - VT[nsl].x) + abs(VT[cur].y - VT[nsl].y)
        minL = self.drc.M[metal]['minL']
        tp = self.parent[nsl]
        vsl = 0
        if tp != -1 and VT[tp].metal == VT[nxt].metal:
            vsl = self.via_space(VT[cur].metal, VT[cur].metal, VT[nxt].metal)
        if length - minL < 0 and length >= vsl:
            return self.ext_half(nsl, cur, length, minL) or self.ext_head(nsl, cur, length, minL)[0] or \
                self.ext_tail(nsl, cur, length, minL)[0]
        elif length >= vsl:
            return True
        return False

    def ext_check(self, node, src):
        VT = self.G.VT
        p = self.tbn[node]
        if p == -1:
            return True
        if VT[node].metal == VT[p].metal:
            return True
        nsl = self.trace_same_layer(p, self.tbn)
        if nsl in src:
            return True
        metal = VT[p].metal
        length = abs(VT[p].x - VT[nsl].x) + abs(VT[p].y - VT[nsl].y)
        minL = self.drc.M[metal]['minL']
        tp = self.tbn[nsl]
        vsl = 0
        if tp != -1 and VT[tp].metal == VT[node].metal:
            vsl = self.via_space(VT[p].metal, VT[p].metal, VT[node].metal)
        if length - minL < 0 and length >= vsl:
            return self.ext_half(nsl, p, length, minL) or self.ext_head(nsl, p, length, minL)[0] or \
                self.ext_tail(nsl, p, length, minL)[0]
        if not FLAGS['ext_check_true'] and length < vsl:
            return False
        return True

    def via_ok(self, a, b):
        G = self.G
        VT = G.VT
        if not VT[a].active or not VT[b].active:
            return False
        if VT[a].metal > VT[b].metal:
            return G.via_up[b] and G.via_down[a]
        if VT[a].metal < VT[b].metal:
            return G.via_down[b] and G.via_up[a]
        return True

    def parallel(self, cur, nxt, src):
        """returns node_L_path[0] or None (None == C++ empty node_L_path / failed)."""
        VT = self.G.VT
        if VT[cur].metal != VT[nxt].metal and not self.ext_prime(cur, nxt, src):
            return None, 'prime'
        if self.via_ok(cur, nxt):
            return [cur, nxt], 'ok'
        return [], 'via'

    def near(self, cur):
        G = self.G
        v = G.VT[cur]
        out = []
        for lst in (v.north, v.south, v.west, v.east):
            out += [t for t in lst if G.VT[t].active]
        if G.via_up[cur] and v.up != -1 and G.VT[v.up].active:
            out.append(v.up)
        if G.via_down[cur] and v.down != -1 and G.VT[v.down].active:
            out.append(v.down)
        return out

    def pre_trace_back(self, cur, src):
        tp = [cur]
        t = cur
        while t not in src:
            t = self.parent[t]
            tp.append(t)
        tp.reverse()
        if cur in src:
            return True
        NP = []
        for i in range(len(tp) - 1):
            nl, why = self.parallel(tp[i], tp[i + 1], src)
            if nl is None:
                self.ub_empty_node_L_path += 1   # C++ reads node_L_path[0] of an empty vector (UB)
                nl = []
            NP += nl
        NP = rm_cycle(NP)
        if NP:
            self.tbn[NP[0]] = -1
            for j in range(1, len(NP)):
                self.tbn[NP[j]] = NP[j - 1]
        for n in NP:
            if not self.ext_check(n, src):
                return False
        return True

    def labels_for(self, path):
        VT = self.G.VT
        pairs = []
        tm, first, second = -1, -1, -1
        for i, n in enumerate(path):
            if VT[n].metal != tm:
                if first != -1:
                    pairs.append((first, second))
                first = second = n
                tm = VT[n].metal
            else:
                second = n
            if i == len(path) - 1:
                pairs.append((first, second))
        out = []
        for i, (a, b) in enumerate(pairs):
            if i == 0 or i == len(pairs) - 1:
                out.append(0)
                continue
            length = abs(VT[a].x - VT[b].x) + abs(VT[a].y - VT[b].y)
            minL = self.drc.M[VT[a].metal]['minL']
            if length >= minL:
                out.append(0)
            elif self.ext_half(a, b, length, minL):
                out.append(1)
            else:
                f, d = self.ext_head(a, b, length, minL)
                if f:
                    out.append(2 if d == 1 else 3)
                else:
                    f, d = self.ext_tail(a, b, length, minL)
                    if f:
                        out.append(2 if d == 1 else 3)
                    else:
                        out.append(4)
        return out

    def run(self):
        self.ub_empty_node_L_path = 0
        VT = self.G.VT
        src = set(self.source)
        close = set(self.source)
        dset = set(self.dest)
        heap, inL = [], {}
        for s in self.source:
            Md = self.mdist(s)
            self.Cost[s] = 0.0
            dis = (float(Md) * self.drc.M[VT[s].metal]['unit_R'] + 0.0) if FLAGS['src_key_unitR'] else float(Md)
            dis += float(abs(VT[s].x) + abs(VT[s].y)) / 1e10
            if inL.get(s) != dis:
                inL[s] = dis
                heapq.heappush(heap, (dis, s))
        found = False
        cur = -1
        while inL and not found:
            while True:
                k, cur = heapq.heappop(heap)
                if inL.get(cur) == k:
                    del inL[cur]
                    break
            if cur in dset:
                if self.pre_trace_back(cur, src):
                    found = True
                continue
            cands = [c for c in self.near(cur) if c not in close]
            ok = []
            for c in cands:
                nl, why = self.parallel(cur, c, src)
                if nl:
                    ok.append(c)
            for c in ok:
                Md = self.mdist(c)
                tc = f2i(self.Cost[cur] + abs(VT[cur].x - VT[c].x) + abs(VT[cur].y - VT[c].y)
                         + 100 * abs(VT[c].metal - VT[cur].metal) + 0)
                if tc < self.Cost[c]:
                    old = float(f2i(self.Cost[c] + Md))
                    if inL.get(c) == old:
                        del inL[c]
                    self.Cost[c] = float(tc)
                    self.parent[c] = cur
                    key = float(f2i(self.Cost[c] + Md))
                    inL[c] = key
                    heapq.heappush(heap, (key, c))
        if not found:
            return False
        # Trace_Back_Paths (left = right = 0 -> nodes == [cur])
        src2 = set(src)
        src2.add(-1)
        path = [cur]
        t = cur
        while t not in src2:
            t = self.tbn[t]
            path.append(t)
        path.reverse()
        if path[0] == -1:
            raise RuntimeError('path starts at -1 (C++ UB)')
        self.Path = [path]
        self.labels = [self.labels_for(path)]
        return True

    def physical(self):
        VT = self.G.VT
        out = []
        for path in self.Path:
            ms = []
            start = True
            cur = None
            for j, n in enumerate(path):
                if start:
                    cur = [VT[n].metal, [VT[n].x, VT[n].y]]
                    start = False
                if j < len(path) - 1 and VT[n].metal != VT[path[j + 1]].metal:
                    start = True
                    ms.append(Metal(cur[0], [cur[1], [VT[n].x, VT[n].y]], self.drc.M[VT[n].metal]['width']))
                if j == len(path) - 1 and not start:
                    start = True
                    ms.append(Metal(cur[0], [cur[1], [VT[n].x, VT[n].y]], self.drc.M[VT[n].metal]['width']))
            out.append(ms)
        return out


def rm_cycle(NP):
    if not NP:
        return NP
    c = [NP[0]] + [NP[j] for j in range(1, len(NP)) if NP[j] != NP[j - 1]]
    seen, cyc = set(), set()
    for n in c:
        (cyc if n in seen else seen).add(n)
    flag = [0] * len(c)
    for val in sorted(cyc):
        f, e = -1, -1
        for j, n in enumerate(c):
            if n == val and f == -1:
                f = j + 1
            elif n == val:
                e = j
        for j in range(f, e + 1):
            flag[j] = 1
    return [n for j, n in enumerate(c) if not flag[j]]


# ------------------------------------------------------------------ set filters (RawRouter)
def findset_plist(S, LL, UR, lo, hi, layerNo):
    return PG.findset_plist(S, LL, UR, lo, hi, layerNo)


def findset_contacts(S, LL, UR, lo, hi):
    """RawRouter::Findset on 2-coord SinkData (key = (LLx,LLy,m,URx,URy)); garbage-compare case flagged."""
    out = []
    for e in S:
        k1 = (e[0], e[1], e[2])
        if k1 < (LL[0], LL[1], lo):
            continue
        if (e[0], e[1]) == (LL[0], LL[1]) and e[2] == lo:
            pass  # C++ compares e.coord[1] with garbage here (UB); assume included
        if k1 > (UR[0], UR[1], hi):
            continue
        k2 = (e[1], e[0], e[2])
        if k2 < (LL[1], LL[0], lo) or k2 > (UR[1], UR[0], hi):
            continue
        out.append(e)
    return out


def findviaset(P, LL, UR, lo, hi):
    if not FLAGS['viaset_lex']:
        return [p for p in P if lo <= p[0] <= hi and LL[0] <= p[1] <= UR[0] and LL[1] <= p[2] <= UR[1]]
    return [p for p in P if (lo, LL[0], LL[1]) <= p <= (hi, UR[0], UR[1])]


# ------------------------------------------------------------------ PowerRouter mode 3 driver
class PowerNetRouter:
    def __init__(self, node, drc, drc_j, merged):
        self.node, self.drc, self.drc_j = node, drc, drc_j
        self.layerNo = len(drc.M)
        D = drc.D
        self.lo, self.hi = D['power_routing_metal_l'], D['power_routing_metal_u']
        self.width, self.height = node['width'], node['height']
        self.LL, self.UR = list(node['LL']), list(node['UR'])
        self.merged = merged  # {1: [(idx, rect)], 0: [...]}
        self.stats = dict(vertex0_hits=0, ub_empty=0, fails=0)

    # --- obstacle point generation (drc == cross == original in mode 3)
    def rect_points(self, plist, m, r):
        PG.convert_rect(plist, self.drc, self.drc, self.layerNo, m, r[0], r[1], r[2], r[3])

    def run(self):
        node, drc = self.node, self.drc
        layerNo = self.layerNo
        # grids from node.Vdd / node.Gnd (getPowerGridData)
        grids = {}
        for p, key in ((1, 'Vdd'), (0, 'Gnd')):
            g = node[key]
            grids[p] = dict(metals=[(m['idx'], m['pts'], m['r']['p']) for m in g['metals']],
                            vias=[(v['model'], v['ppos'][0], v['ppos'][1], v['U']['p'], mdx(drc, v['U']['metal'])) for v in g['vias']])
        # plist for Set_x: blocks, terminals, Vdd grid, Gnd grid
        plist = [[] for _ in range(layerNo)]
        for bc in node['Blocks']:
            inst = bc['instance'][bc['selectedInstance']]
            for pin in inst['pins']:
                for c in pin['c']:
                    self.rect_points(plist, mdx(drc, c['metal']), c['p'])
                for v in pin['v']:
                    self.rect_points(plist, mdx(drc, v['U']['metal']), v['U']['p'])
                    self.rect_points(plist, mdx(drc, v['L']['metal']), v['L']['p'])
            for c in inst['interMetals']:
                self.rect_points(plist, mdx(drc, c['metal']), c['p'])
            for v in inst['interVias']:
                self.rect_points(plist, mdx(drc, v['U']['metal']), v['U']['p'])
                self.rect_points(plist, mdx(drc, v['L']['metal']), v['L']['p'])
        for t in node['Terminals']:
            for c in t['termContacts']:
                if mdx(drc, c['metal']) >= 0:
                    self.rect_points(plist, mdx(drc, c['metal']), c['p'])
        for p in (1, 0):
            for (idx, pts, r) in grids[p]['metals']:
                self.rect_points(plist, idx, r)
            for (model, x, y, Ur, Um) in grids[p]['vias']:
                self.rect_points(plist, Um, Ur)   # UpperMetalRect twice (bug), LowerMetalRect never
                self.rect_points(plist, Um, Ur)
        Set_x = set((x, y, m) for m in range(layerNo) for (x, y) in plist[m])
        # Set_net: power nets' paths (empty) + signal nets
        netp = [[] for _ in range(layerNo)]
        for pn in node['PowerNets']:
            for mt in pn['path_metal']:
                self.rect_points(netp, mt['idx'], mt['r']['p'])
            for v in pn['path_via']:
                self.rect_points(netp, mdx(drc, v['U']['metal']), v['U']['p'])
                self.rect_points(netp, mdx(drc, v['L']['metal']), v['L']['p'])
        for n in node['Nets']:
            for mt in n['path_metal']:
                self.rect_points(netp, mt['idx'], mt['r']['p'])
            for v in n['path_via']:
                self.rect_points(netp, mdx(drc, v['U']['metal']), v['U']['p'])
                self.rect_points(netp, mdx(drc, v['L']['metal']), v['L']['p'])
        Set_net = set((x, y, m) for m in range(layerNo) for (x, y) in netp[m])
        # Pset_via
        Pset_via = set()
        for bc in node['Blocks']:
            inst = bc['instance'][bc['selectedInstance']]
            for v in inst['interVias']:
                Pset_via.add((v['model'], v['ppos'][0], v['ppos'][1]))
            for pin in inst['pins']:
                for v in pin['v']:
                    Pset_via.add((v['model'], v['ppos'][0], v['ppos'][1]))
        for p in (1, 0):
            for (model, x, y, Ur, Um) in grids[p]['vias']:
                Pset_via.add((model, x, y))
        for n in node['Nets']:
            for v in n['path_via']:
                Pset_via.add((v['model'], v['ppos'][0], v['ppos'][1]))
        Set_net_contact = set()
        self.nets = []
        for i, pn in enumerate(node['PowerNets']):
            net = dict(name=pn['name'], power=pn['power'], metals=[], labels=[], vias=[], report=[])
            self.nets.append(net)
        for i, pn in enumerate(node['PowerNets']):
            net = self.nets[i]
            Pset_cur_via = set()
            Set_cur_contact = set()
            # ReturnInternalMetalContact
            Sxc = set()
            for bc in node['Blocks']:
                inst = bc['instance'][bc['selectedInstance']]
                for c in inst['interMetals']:
                    Sxc.add(tuple(c['p'][:2]) + (mdx(drc, c['metal']),) + tuple(c['p'][2:]))
                for pin in inst['pins']:
                    for c in pin['c']:
                        Sxc.add(tuple(c['p'][:2]) + (mdx(drc, c['metal']),) + tuple(c['p'][2:]))
                    for v in pin['v']:
                        for k in ('U', 'L'):
                            Sxc.add(tuple(v[k]['p'][:2]) + (mdx(drc, v[k]['metal']),) + tuple(v[k]['p'][2:]))
            for n in node['Nets']:
                for mt in n['path_metal']:
                    Sxc.add(tuple(mt['r']['p'][:2]) + (mdx(drc, mt['r']['metal']),) + tuple(mt['r']['p'][2:]))
                for v in n['path_via']:
                    for k in ('U', 'L'):
                        Sxc.add(tuple(v[k]['p'][:2]) + (mdx(drc, v[k]['metal']),) + tuple(v[k]['p'][2:]))
            for pin in pn['Pins']:
                for c in pin['c']:
                    Sxc.discard(tuple(c['p'][:2]) + (mdx(drc, c['metal']),) + tuple(c['p'][2:]))
                for v in pin['v']:
                    for k in ('U', 'L'):
                        Sxc.discard(tuple(v[k]['p'][:2]) + (mdx(drc, v[k]['metal']),) + tuple(v[k]['p'][2:]))
            for j, pin in enumerate(pn['Pins']):
                grid_p = grids[1] if pn['power'] == 1 else grids[0]
                srcs, dsts = self.set_src_dest(pin, grid_p)
                G = Grid(drc, tuple(self.LL), tuple(self.UR), self.lo, self.hi)
                pl = findset_plist(Set_x, self.LL, self.UR, self.lo, self.hi, layerNo)
                for v in G.VT:
                    if (v.x, v.y) in pl[v.metal]:
                        v.active = False
                set_src_dest(G, srcs, dsts, False)
                for s in G.Source + G.Dest:
                    G.VT[s].active = True
                nl = findset_plist(Set_net, self.LL, self.UR, self.lo, self.hi, layerNo)
                for v in G.VT:
                    if (v.x, v.y) in nl[v.metal]:
                        v.active = False
                set_src_dest(G, srcs, dsts, True)
                self.add_via_enclosure(Pset_via, G, Sxc, Set_net_contact, srcs, dsts)
                self.add_via_spacing(Pset_via, G)
                A = AStar(G)
                mark = A.run()
                self.stats['ub_empty'] += A.ub_empty_node_L_path
                self.stats['vertex0_hits'] += G.vertex0_hits
                net['report'].append((pin['name'], int(mark)))
                phys, labels = [], []
                if mark:
                    phys = A.physical()
                    labels = A.labels
                    self.check_lastmile(phys, srcs, dsts)
                    for pi, path in enumerate(phys):
                        for mj, m in enumerate(path):
                            net['metals'].append(m.copy())
                            net['labels'].append(labels[pi][mj])
                    self.insert_routing_via(A, G, Pset_cur_via)
                    self.insert_routing_via(A, G, Pset_via)
                    self.insert_routing_contact(i, Pset_cur_via, Set_cur_contact, pn['power'])
                else:
                    self.stats['fails'] += 1
                add = [[] for _ in range(layerNo)]
                self.update_plist_nets(phys, add, labels)
                for m in range(layerNo):
                    for (x, y) in add[m]:
                        Set_net.add((x, y, m))
                Set_net_contact |= Set_cur_contact
        # Physical_metal_via + ExtendMetal
        for i in range(len(self.nets)):
            self.get_physical_metal_via(i)
        for i in range(len(self.nets)):
            self.extend_metals(i)
        return self.nets

    # --- SetSrcDest (PowerRouter.cpp:867-1002)
    def set_src_dest(self, pin, grid_p):
        drc = self.drc
        srcs = [(mdx(drc, c['metal']), c['p']) for c in pin['c']]
        lowest = min([m[0] for m in grid_p['metals']], default=INT_MAX)
        dist = {}
        for (m, r) in srcs:
            sx, sy = cdiv(r[0] + r[2], 2), cdiv(r[1] + r[3], 2)
            for j, (idx, pts, rr) in enumerate(grid_p['metals']):
                dx, dy = cdiv(pts[0][0] + pts[1][0], 2), cdiv(pts[0][1] + pts[1][1], 2)
                if idx == lowest:
                    if FLAGS['dest_dedup']:
                        dist.setdefault(abs(sx - dx) + abs(sy - dy), j)
                    else:
                        dist.setdefault((abs(sx - dx) + abs(sy - dy), j), j)
        dsts = []
        for cnt, k in enumerate(sorted(dist)):
            if cnt < 7:
                idx, pts, rr = grid_p['metals'][dist[k]]
                dsts.append((idx, rr))
        llx = lly = INT_MAX
        urx = ury = INT_MIN
        for (m, r) in dsts + srcs:
            for (x, y) in ((r[0], r[1]), (r[2], r[3])):
                llx, lly, urx, ury = min(llx, x), min(lly, y), max(urx, x), max(ury, y)
        M = drc.M
        hm = self.hi
        if M[hm]['direct'] == 0:
            xMar, yMar = M[hm]['grid_unit_x'], M[hm - 1]['grid_unit_y']
        else:
            yMar, xMar = M[hm]['grid_unit_y'], M[hm - 1]['grid_unit_x']
        e = 10
        self.LL[0] = 0 if llx - e * xMar < 0 else llx - e * xMar
        self.LL[1] = 0 if lly - e * yMar < 0 else lly - e * yMar
        self.UR[0] = self.width if urx + e * xMar > self.width else urx + e * xMar
        self.UR[1] = self.height if ury + e * yMar > self.height else ury + e * yMar
        return srcs, dsts

    def add_via_enclosure(self, Pset_via, G, Sxc, Snc, srcs, dsts):
        drc = self.drc
        VM = self.drc_j['Via_model']
        S = findset_contacts(Snc | Sxc, self.LL, self.UR, self.lo, self.hi)

        def inside(lst, m, c):
            for (mm, r) in lst:
                if mm == m and r[0] <= c[0] and r[1] <= c[1] and r[2] >= c[3] and r[3] >= c[4]:
                    return True
            return False
        for c in sorted(S):
            m = c[2]
            ee = drc.M[m]['dist_ee']
            if inside(srcs, m, c) or inside(dsts, m, c):
                continue
            if drc.M[m]['direct'] == 0:
                if m < self.layerNo - 1:
                    v = VM[m]
                    box = (c[0], c[1] + v['LowerRect'][0]['y'] - ee, c[3], c[4] + v['LowerRect'][1]['y'] + ee)
                    inact_via(G, v['LowerIdx'], *box, True)
                    inact_via(G, v['UpperIdx'], *box, False)
                if m > 0:
                    v = VM[m - 1]
                    box = (c[0], c[1] + v['UpperRect'][0]['y'] - ee, c[3], c[4] + v['UpperRect'][1]['y'] + ee)
                    inact_via(G, v['UpperIdx'], *box, False)
                    inact_via(G, v['LowerIdx'], *box, True)
            else:
                if m < self.layerNo - 1:
                    v = VM[m]
                    box = (c[0] + v['LowerRect'][0]['x'] - ee, c[1], c[3] + v['LowerRect'][1]['x'] + ee, c[4])
                    inact_via(G, v['LowerIdx'], *box, True)
                    inact_via(G, v['UpperIdx'], *box, False)
                if m > 0:
                    v = VM[m - 1]
                    box = (c[0] + v['UpperRect'][0]['x'] - ee, c[1], c[3] + v['UpperRect'][1]['x'] + ee, c[4])
                    inact_via(G, v['UpperIdx'], *box, False)
                    inact_via(G, v['LowerIdx'], *box, True)

    def add_via_spacing(self, Pset_via, G):
        drc = self.drc
        V = drc.V
        for (vi, x, y) in findviaset(sorted(Pset_via), self.LL, self.UR, self.lo, self.hi):
            box = (x - V[vi]['dist_ss'] - V[vi]['width'], y - V[vi]['dist_ss_y'] - V[vi]['width_y'],
                   x + V[vi]['dist_ss'] + V[vi]['width'], y + V[vi]['dist_ss_y'] + V[vi]['width_y'])
            inact_via(G, vi, *box, True)
            inact_via(G, vi + 1, *box, False)
        nM = len(drc.M)
        for d in G.Dest:
            v = G.VT[d]
            m = v.metal
            x, y = v.x, v.y
            if drc.M[m]['direct'] == 0:
                vi = drc.M[m]['upper_via_index']
                if vi != -1 and m != nM - 1:
                    s = V[vi]['dist_ss'] + V[vi]['width']
                    for box in ((x - s, y - 1, x - 1, y + 1), (x + 1, y - 1, x + s, y + 1)):
                        inact_via(G, m, *box, True)
                        inact_via(G, m + 1, *box, False)
                vi = drc.M[m]['lower_via_index']
                if vi != -1 and m != 0:
                    s = V[vi]['dist_ss'] + V[vi]['width']
                    for box in ((x - s, y - 1, x - 1, y + 1), (x + 1, y - 1, x + s, y + 1)):
                        inact_via(G, m - 1, *box, True)
                        inact_via(G, m, *box, False)
            else:
                vi = drc.M[m]['upper_via_index']
                if vi != -1 and m != nM - 1:
                    s = V[vi]['dist_ss_y'] + V[vi]['width_y']
                    for box in ((x - 1, y + 1, x + 1, y + s), (x - 1, y - s, x + 1, y - 1)):
                        inact_via(G, m, *box, True)
                        inact_via(G, m + 1, *box, False)
                vi = drc.M[m]['lower_via_index']
                if vi != -1 and m != 0:
                    s = V[vi]['dist_ss_y'] + V[vi]['width_y']
                    for box in ((x - 1, y + 1, x + 1, y + s), (x - 1, y - s, x + 1, y - 1)):
                        inact_via(G, m - 1, *box, True)
                        inact_via(G, m, *box, False)

    def check_lastmile(self, phys, srcs, dsts):
        p0 = phys[0][0].lp[0]
        m0 = phys[0][0].idx
        if not any(r[0] <= p0[0] <= r[2] and r[1] <= p0[1] <= r[3] and m == m0 for (m, r) in srcs):
            raise RuntimeError('lastmile_source_new would add metal')
        pl = phys[0][-1].lp[1]
        ml = phys[0][-1].idx
        if not any(r[0] <= pl[0] <= r[2] and r[1] <= pl[1] <= r[3] and m == ml for (m, r) in dsts):
            raise RuntimeError('lastmile_dest_new would add metal')

    def insert_routing_via(self, A, G, P):
        for path in A.Path:
            for k in range(1, len(path)):
                a, b = G.VT[path[k - 1]], G.VT[path[k]]
                if a.metal == b.metal or a.x != b.x or a.y != b.y:
                    continue
                P.add((min(a.metal, b.metal), a.x, a.y))

    def get_physical_metal_via(self, i):
        net = self.nets[i]
        for m in net['metals']:
            phys_rect_power(m)
        if FLAGS['via_dup']:
            net['vias'] += vias_between(net['metals'], self.drc_j)
        else:
            seen = set((v['model'], v['pos'][0], v['pos'][1]) for v in net['vias'])
            for v in vias_between(net['metals'], self.drc_j):
                if (v['model'], v['pos'][0], v['pos'][1]) not in seen:
                    net['vias'].append(v); seen.add((v['model'], v['pos'][0], v['pos'][1]))

    def extend_metals(self, i):
        net = self.nets[i]
        for m, lab in zip(net['metals'], net['labels']):
            extend_metal(self.drc, m, lab)

    def insert_routing_contact(self, i, Pcur, Scur, power):
        self.get_physical_metal_via(i)
        self.extend_metals(i)
        net = self.nets[i]
        for m in net['metals']:
            Scur.add((m.rect[0], m.rect[1], m.idx, m.rect[2], m.rect[3]))
        VM = self.drc_j['Via_model']
        for (vi, x, y) in sorted(Pcur):
            L = VM[vi]['LowerRect']
            c = (x + L[0]['x'], y + L[0]['y'], vi, x + L[1]['x'], y + L[1]['y'])
            if not self.redundant(c, True if FLAGS['redundant_swap'] else power == 1):
                Scur.add(c)
            U = VM[vi]['UpperRect']
            c = (x + U[0]['x'], y + U[0]['y'], vi + 1, x + U[1]['x'], y + U[1]['y'])
            if not self.redundant(c, False if FLAGS['redundant_swap'] else power == 1):
                Scur.add(c)

    def redundant(self, c, flag):
        for (idx, r) in self.merged[1 if flag else 0]:
            if idx == c[2] and r[0] <= c[0] and r[1] <= c[1] and r[2] >= c[3] and r[3] >= c[4]:
                return True
        return False

    def update_plist_nets(self, phys, plist, labels):
        drc = self.drc
        for pi, path in enumerate(phys):
            for mj, m in enumerate(path):
                phys_rect_by_layer(drc, m)
                extend_metal(drc, m, labels[pi][mj])
                self.rect_points(plist, m.idx, m.rect)
        cont = []
        s = set()
        for path in phys:
            for a in path:
                for b in path:
                    if a is b or a.idx != b.idx - 1:
                        continue
                    for pa in (a.lp[0], a.lp[1]):
                        for pb in (b.lp[0], b.lp[1]):
                            if pa[0] == pb[0] and pa[1] == pb[1]:
                                s.add((a.idx, pa[0], pa[1]))
        for (mi, x, y) in sorted(s):
            vr = via_rects(self.drc_j, mi, x, y)
            cont.append((vr['Um'], vr['U']))
            cont.append((vr['Lm'], vr['L']))
        for (m, r) in cont:
            self.rect_points(plist, m, r)
