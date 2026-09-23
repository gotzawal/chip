import glob, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pg_check, pr_check, pr_proto as PR, pg_proto as PG, tapconv


def check_dir(d):
    drcj = json.load(open(d + '/drc.json'))
    din2 = glob.glob(d + '/*_m2_in.json')[0]
    ok2, s2 = pg_check.run_case(din2, din2.replace('_m2_in', '_m2_out'), drcj)
    print('mode2', 'PASS' if ok2 else 'FAIL', s2)
    din3 = glob.glob(d + '/*_m3_in.json')[0]
    merged = pr_check.mode2_merged(din2, drcj)
    node = tapconv.load(din3); ref = tapconv.load(din3.replace('_m3_in', '_m3_out'))
    R = PR.PowerNetRouter(node, PG.Drc(drcj), drcj, merged)
    nets = R.run()
    ok3 = True
    for net, rn in zip(nets, ref['PowerNets']):
        mm = [(m.idx, m.lp, m.w, m.rect) for m in net['metals']]
        rm = [(m['idx'], m['pts'], m['w'], m['r']['p']) for m in rn['path_metal']]
        mv = [(v['model'], v['pos'], v['L'], v['U']) for v in net['vias']]
        rv = [(v['model'], v['ppos'], v['L']['p'], v['U']['p']) for v in rn['path_via']]
        good = mm == rm and mv == rv
        ok3 &= good
        print(f"  {net['name']}: metals {len(mm)}/{len(rm)} vias {len(mv)}/{len(rv)} {'OK' if good else 'DIFF'} report {net['report']}")
        if not good:
            for a, b in zip(mm, rm):
                if a != b:
                    print('     first metal diff mine', a, 'ref', b); break
    print('mode3', 'PASS' if ok3 else 'FAIL', R.stats)
    return ok2 and ok3


if __name__ == '__main__':
    allok = True
    for d in sys.argv[1:]:
        print('==', d)
        allok &= check_dir(d)
    print('ALL PASS' if allok else 'SOME FAIL')
