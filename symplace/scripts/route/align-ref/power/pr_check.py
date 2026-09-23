"""Run mode-3 prototype on every tap case (m3_in -> m3_out); merged_metals from mode-2 prototype on m2_in."""
import glob
import json
import os
import sys
import time
sys.path.insert(0, os.path.dirname(__file__))
import pg_proto as PG
import pr_proto as PR
import tapconv


def mode2_merged(din, drcj):
    node = tapconv.load(din)
    drc = PG.Drc(drcj)
    Lm, Hm = drc.D['power_grid_metal_l'], drc.D['power_grid_metal_u']
    pg = drc.scaled(drc.D['h_skip_factor'], drc.D['v_skip_factor'])
    layerNo = len(drc.M)
    LL = tuple(node['LL']); UR = list(node['UR'])
    UR[0] = max(UR[0], pg.M[Lm]['grid_unit_x'] if pg.M[Lm]['direct'] == 0 else pg.M[Hm]['grid_unit_x'])
    UR[1] = max(UR[1], pg.M[Hm]['grid_unit_y'] if pg.M[Hm]['direct'] == 1 else pg.M[Lm]['grid_unit_y'])
    UR = tuple(UR)
    S = PG.build_obstacles(node, drc, pg, layerNo)
    VT, vmap = PG.build_grid(pg, LL, UR, Lm, Hm)
    pl = PG.findset_plist(S, LL, UR, Lm, Hm, layerNo)
    for v in VT:
        if (v.x, v.y) in pl[v.metal]:
            v.active = False
    VG, t2g = PG.prepare_graph(VT, vmap, LL, UR)
    res = PG.create_power_grid(VG, t2g, pg)
    out = {}
    for p in (1, 0):
        out[p] = [(m[0], PG.rect((m[0], (tuple(m[1][0]), tuple(m[1][1]))), pg.M[m[0]]['width'])) for m in res[p]['merged'] if m]
    return out


def run(ex, var, verbose=False):
    d = os.path.expanduser(f'~/.cache/symplace/tap/{ex}/{var}')
    din3 = glob.glob(d + '/*_m3_in.json')[0]
    dout3 = din3.replace('_m3_in', '_m3_out')
    din2 = glob.glob(d + '/*_m2_in.json')[0]
    drcj = json.load(open(d + '/drc.json'))
    merged = mode2_merged(din2, drcj)
    node = tapconv.load(din3)
    ref = tapconv.load(dout3)
    drc = PG.Drc(drcj)
    t = time.time()
    R = PR.PowerNetRouter(node, drc, drcj, merged)
    nets = R.run()
    dt = time.time() - t
    ok = True
    msgs = []
    for net, rn in zip(nets, ref['PowerNets']):
        mine_m = [(m.idx, m.lp, m.w, m.rect) for m in net['metals']]
        ref_m = [(m['idx'], m['pts'], m['w'], m['r']['p']) for m in rn['path_metal']]
        mine_v = [(v['model'], v['pos'], v['L'], v['U'], v['V']) for v in net['vias']]
        ref_v = [(v['model'], v['ppos'], v['L']['p'], v['U']['p'], v['V']['p']) for v in rn['path_via']]
        good = (mine_m == ref_m and mine_v == ref_v)
        ok &= good
        msgs.append(f"{net['name']}: metals {len(mine_m)}/{len(ref_m)} vias {len(mine_v)}/{len(ref_v)} "
                    f"{'OK' if good else 'DIFF'} report={net['report']}")
        if not good and verbose:
            for a, b in zip(mine_m, ref_m):
                if a != b:
                    print('   first metal diff mine', a, 'ref', b)
                    break
            for a, b in zip(mine_v, ref_v):
                if a != b:
                    print('   first via diff mine', a[:2], 'ref', b[:2])
                    break
    # bbox update (ReturnPowerNetData)
    xs = []
    for key in ('Vdd', 'Gnd'):
        for m in node[key]['metals']:
            xs.append(m['r']['p'])
        for v in node[key]['vias']:
            xs.append(v['L']['p']); xs.append(v['U']['p'])
    for net in nets:
        for m in net['metals']:
            xs.append(m.rect)
        for v in net['vias']:
            xs.append(v['L']); xs.append(v['U'])
    LL = [min([node['LL'][0]] + [r[0] for r in xs]), min([node['LL'][1]] + [r[1] for r in xs])]
    UR = [max([node['UR'][0]] + [r[2] for r in xs]), max([node['UR'][1]] + [r[3] for r in xs])]
    bb_ok = (LL == ref['LL'] and UR == ref['UR'] and UR[0] - LL[0] == ref['width'] and UR[1] - LL[1] == ref['height'])
    ok &= bb_ok
    msgs.append(f"bbox {LL}{UR} vs {ref['LL']}{ref['UR']} {'OK' if bb_ok else 'DIFF'}")
    msgs.append(f"stats {R.stats} {dt:.1f}s")
    return ok, ' | '.join(msgs)


if __name__ == '__main__':
    root = os.path.expanduser('~/.cache/symplace/tap')
    sel = sys.argv[1:]
    allok = True
    for ex in sorted(os.listdir(root)):
        for var in ('align', 'ours'):
            if sel and f'{ex}/{var}' not in sel and ex not in sel:
                continue
            try:
                ok, s = run(ex, var, verbose=bool(sel))
            except Exception as e:  # noqa
                import traceback
                traceback.print_exc()
                ok, s = False, f'EXC {e}'
            allok &= ok
            print(f'{ex:28s} {var:5s} {"PASS" if ok else "FAIL"}  {s}', flush=True)
    print('ALL PASS' if allok else 'SOME FAIL')
