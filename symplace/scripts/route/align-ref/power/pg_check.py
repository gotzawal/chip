"""Run the mode-2 prototype on every RouteWork tap case (m2_in -> m2_out) and compare exactly."""
import glob
import json
import os
import sys
sys.path.insert(0, os.path.dirname(__file__))
import pg_proto as P
import tapconv


def run_case(din, dout, drcj):
    node = tapconv.load(din)
    ref = tapconv.load(dout)
    drc = P.Drc(drcj)
    Lm, Hm = drc.D['power_grid_metal_l'], drc.D['power_grid_metal_u']
    pg = drc.scaled(drc.D['h_skip_factor'], drc.D['v_skip_factor'])
    layerNo = len(drc.M)
    LL = tuple(node['LL'])
    UR = list(node['UR'])
    # UpdatePowerGridLLUR (PowerRouter.cpp:683-710)
    x_grid = y_grid = -1
    hi, lo = pg.M[Hm], pg.M[Lm]
    if hi['direct'] == 1: y_grid = hi['grid_unit_y']
    else: x_grid = hi['grid_unit_x']
    if lo['direct'] == 1: y_grid = lo['grid_unit_y']
    else: x_grid = lo['grid_unit_x']
    if y_grid == -1: y_grid = pg.M[Hm - 1]['grid_unit_y']
    if x_grid == -1: x_grid = pg.M[Hm - 1]['grid_unit_x']
    if UR[0] < x_grid: UR[0] = x_grid
    if UR[1] < y_grid: UR[1] = y_grid
    UR = tuple(UR)
    S = P.build_obstacles(node, drc, pg, layerNo)
    VT, vmap = P.build_grid(pg, LL, UR, Lm, Hm)
    pl = P.findset_plist(S, LL, UR, Lm, Hm, layerNo)
    nin = 0
    for v in VT:
        if (v.x, v.y) in pl[v.metal]:
            v.active = False
            nin += 1
    VG, t2g = P.prepare_graph(VT, vmap, LL, UR)
    res = P.create_power_grid(VG, t2g, pg)
    names = {1: 'vdd', 0: 'vss'}
    for pn in node['PowerNets']:
        if pn['power'] == 1: names[1] = pn['name']; break
    for pn in node['PowerNets']:
        if pn['power'] == 0: names[0] = pn['name']; break
    ok = True
    msg = []
    for p, key in ((1, 'Vdd'), (0, 'Gnd')):
        mine = [(m[0], [list(m[1][0]), list(m[1][1])], P.rect(m, pg.M[m[0]]['width'])) for m in res[p]['metals']]
        refm = [(m['idx'], m['pts'], m['r']['p']) for m in ref[key]['metals']]
        vm = []
        for (mi, x, y) in res[p]['vias']:
            vmd = drcj['Via_model'][mi]
            L = [x + vmd['LowerRect'][0]['x'], y + vmd['LowerRect'][0]['y'], x + vmd['LowerRect'][1]['x'], y + vmd['LowerRect'][1]['y']]
            U = [x + vmd['UpperRect'][0]['x'], y + vmd['UpperRect'][0]['y'], x + vmd['UpperRect'][1]['x'], y + vmd['UpperRect'][1]['y']]
            vm.append((mi, [x, y], L, U))
        vr = [(v['model'], v['ppos'], v['L']['p'], v['U']['p']) for v in ref[key]['vias']]
        good = mine == refm and vm == vr and ref[key]['name'] == names[p]
        ok &= good
        msg.append(f'{key}[{names[p]}] m {len(mine)}/{len(refm)} v {len(vm)}/{len(vr)} {"OK" if good else "DIFF"}')
        if not good:
            sm, sr = set(map(str, mine)), set(map(str, refm))
            msg.append(f'   metals only-mine {sorted(sm - sr)[:3]} only-ref {sorted(sr - sm)[:3]}')
            sv, svr = set(map(str, vm)), set(map(str, vr))
            msg.append(f'   vias only-mine {sorted(sv - svr)[:3]} only-ref {sorted(svr - sv)[:3]}')
    return ok, f'UR={UR} grid={len(VT)} obstacle-inactivated={nin} graph={len(VG)} ' + ' | '.join(msg)


if __name__ == '__main__':
    root = os.path.expanduser('~/.cache/symplace/tap')
    allok = True
    for ex in sorted(os.listdir(root)):
        for var in ('align', 'ours'):
            d = os.path.join(root, ex, var)
            ins = glob.glob(d + '/*_m2_in.json')
            if not ins:
                continue
            din = ins[0]
            dout = din.replace('_m2_in', '_m2_out')
            drcj = json.load(open(d + '/drc.json'))
            ok, s = run_case(din, dout, drcj)
            allok &= ok
            print(f'{ex:28s} {var:5s} {"PASS" if ok else "FAIL"}  {s}')
    print('ALL PASS' if allok else 'SOME FAIL')
