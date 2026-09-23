"""Rebuild gen_viewer_json's add_terminal list ("wires") from a routed hierNode dump (instrument.py HN format).
Order and content follow align/pnr/checkers.py:157-213. Coordinates halved (rational_scaling mul=1 div=2)."""
import json, sys

def wires_of(hn):
    out = []
    def add(net, con, tag):
        r = con['p']
        out.append({"netName": net, "netType": "drawing", "layer": con['metal'], "rect": [c // 2 for c in r], "tag": tag})
    for n in hn['Nets'] + hn['PowerNets']:
        for (typ, it, it2) in n['connected']:
            if typ == 0:  # Block
                bc = hn['Blocks'][it2]
                blk = bc['instance'][bc['selectedInstance']]
                for con in blk['pins'][it]['c']:
                    add(n['name'], con, 'blockPin')
        for m in n['path_metal']:
            add(n['name'], m['r'], 'path_metal')
        for v in n['path_via']:
            for k in ('U', 'L', 'V'):
                add(n['name'], v[k], 'path_via')
    for pg in (hn['Gnd'], hn['Vdd']):
        for m in pg['metals']:
            add(pg['name'], m['r'], 'power grid metal')
        for v in pg['vias']:
            for k in ('U', 'L', 'V'):
                add(pg['name'], v[k], 'power grid via')
    return out

if __name__ == '__main__':
    hn = json.load(open(sys.argv[1]))
    cap = json.load(open(sys.argv[2]))
    case = next(c for c in cap['cases'] if c['module'] == hn['name'])
    w = wires_of(hn)
    tail = case['terminals'][-len(w):] if w else []
    strip = lambda t: {k: t[k] for k in ('netName', 'netType', 'layer', 'rect')}
    same = [strip(a) == strip(b) for a, b in zip(w, tail)]
    print(hn['name'], 'wires', len(w), 'checker input', len(case['terminals']), 'match', all(same) and len(tail) == len(w),
          'bbox hN', [c // 2 for c in hn['LL'] + hn['UR']], 'bbox cap', case['bbox'])
    if not all(same):
        i = same.index(False)
        print('  first diff', i, strip(w[i]), strip(tail[i]))
