"""Re-implementation of the external-placement path, to validate against dumps:
   AddingPowerPins -> Placer::setPlacementInfoFromJson -> ILP_solver::UpdateHierNode/UpdateBlockinHierNode/
   UpdateTerminalinHierNode -> Extract_RemovePowerPins  (units: PnRDB = 2x PDK)."""
import json, glob, sys, copy

N, S, W, E, FN, FS, FW, FE = range(8)

def pp(x, y, w, h, o):
    # design::GetPlacedPosition / GetPlacedPnRPosition (no rotation cases needed)
    return {N: (x, y), S: (w - x, h - y), FN: (w - x, y), FS: (x, h - y)}[o]

def box(b, w, h, o, L):
    # GetPlacedBlockInterMetalAbsBox (LL/UR corners) == GetPlacedBlockPinAbsBoundary (4 corners) for axis flips
    a = pp(b[0], b[1], w, h, o); c = pp(b[2], b[3], w, h, o)
    return [min(a[0], c[0]) + L[0], min(a[1], c[1]) + L[1], max(a[0], c[0]) + L[0], max(a[1], c[1]) + L[1]]

def pt(p, w, h, o, L):
    q = pp(p[0], p[1], w, h, o); return [q[0] + L[0], q[1] + L[1]]

def adding_power_pins(node):
    for pn in node['PowerNets']:
        for dc in pn['dummy_connected']:
            it2, it = dc[2], dc[1]
            for inst in node['Blocks'][it2]['instance']:
                pin = copy.deepcopy(inst['dummy_power_pin'][it]); pin['netIter'] = -2
                dc[1] = len(inst['pins'])
                inst['pins'].append(pin)

def extract_remove_power_pins(node):
    for pn in node['PowerNets']:
        pn['Pins'] = []
        for (_, it, it2) in pn['connected']:
            bc = node['Blocks'][it2]; pn['Pins'].append(copy.deepcopy(bc['instance'][bc['selectedInstance']]['pins'][it]))
        for (_, it, it2) in pn['dummy_connected']:
            bc = node['Blocks'][it2]; pins = bc['instance'][bc['selectedInstance']]['pins']
            pn['Pins'].append(copy.deepcopy(pins[it]) if it < len(pins) else {"name": "", "type": "", "use": "", "netIter": -1, "c": [], "v": []})
    for bc in node['Blocks']:
        for inst in bc['instance']:
            keep = []
            for p in inst['pins']:
                inst['interMetals'].extend(copy.deepcopy(p['c']))   # ALL pin contacts become obstacles
                if p['netIter'] != -2: keep.append(p)
                else: break                                          # stops at the FIRST dummy pin (its contacts were already added)
            inst['pins'] = keep

def inject(node, modules_d):
    node = copy.deepcopy(node)
    adding_power_pins(node)
    m = next(m for m in modules_d if m['abstract_name'] == node['name'])   # single placement (idx 0)
    pos = {}
    for inst in m['instances']:
        bid = node['Block_name_map'][inst['instance_name']]
        insts = node['Blocks'][bid]['instance']
        sel = next(i for i, b in enumerate(insts) if b['lefmaster'] == inst['concrete_template_name'])
        t = inst['transformation']; x, y = t['oX'], t['oY']; hf = vf = 0
        if t['sX'] == -1: hf = 1; x -= insts[sel]['w']
        if t['sY'] == -1: vf = 1; y -= insts[sel]['h']
        pos[bid] = (sel, x, y, hf, vf)
    URx = max(x + node['Blocks'][b]['instance'][s]['w'] for b, (s, x, y, hf, vf) in pos.items())
    URy = max(y + node['Blocks'][b]['instance'][s]['h'] for b, (s, x, y, hf, vf) in pos.items())
    node['width'], node['height'] = URx, URy          # + halo (0 unless a Boundary constraint sets it)
    for bid, (sel, x, y, hf, vf) in pos.items():
        bc = node['Blocks'][bid]; bc['selectedInstance'] = sel
        b = bc['instance'][sel]; w, h = b['w'], b['h']; L = (x, y)
        o = (S if vf else FN) if hf else (FS if vf else N)
        b['orient'] = o
        b['placedBox'] = [x, y, x + w, y + h]
        b['placedCenter'] = [w // 2 + x, h // 2 + y]
        for p in b['pins']:
            for c in p['c']:
                c['p'] = box(c['o'], w, h, o, L); c['pc'] = pt(c['oc'], w, h, o, L)
            for v in p['v']:
                v['ppos'] = pt(v['opos'], w, h, o, L)
                for k in 'ULV': v[k]['p'] = box(v[k]['o'], w, h, o, L); v[k]['pc'] = pt(v[k]['oc'], w, h, o, L)
        for c in b['interMetals']:
            c['p'] = box(c['o'], w, h, o, L); c['pc'] = pt(c['oc'], w, h, o, L)
        for v in b['interVias']:
            v['ppos'] = pt(v['opos'], w, h, o, L)
            for k in 'ULV': v[k]['p'] = box(v[k]['o'], w, h, o, L); v[k]['pc'] = pt(v[k]['oc'], w, h, o, L)
    # UpdateTerminalinHierNode
    t2n = {}
    for ni, n in enumerate(node['Nets']):
        for (typ, it, it2) in n['connected']:
            if typ == 1: t2n[it] = ni; break
    for ti, t in enumerate(node['Terminals']):
        if t['netIter'] == -1: continue
        tc = []
        for (typ, it, it2) in node['Nets'][t2n.get(ti, 0)]['connected']:
            if typ == 1: continue
            bc = node['Blocks'][it2]
            for c in bc['instance'][bc['selectedInstance']]['pins'][it]['c']:
                tc.append({**c, 'o': c['p'], 'oc': c['pc']})
        t['termContacts'] = tc
    for t in node['Terminals']:
        node['blockPins'].append({"name": t['name'], "type": t['type'], "use": "", "netIter": t['netIter'],
                                  "c": [{**c, 'metal': 'M1'} for c in t['termContacts']], "v": []})
    extract_remove_power_pins(node)
    return node

if __name__ == '__main__':
    d = sys.argv[1]; ok = True
    for fin in sorted(glob.glob(f'{d}/04_*')):
        fout = fin.replace('/04_', '/05_').replace('_place_input_', '_place_output_')
        a, b = json.load(open(fin)), json.load(open(fout))
        mine = inject(a['node_before'], a['modules_d'])
        ras = b['PnRAS0']
        checks = {
            'width/height': (mine['width'], mine['height']) == (ras['width'], ras['height']),
            'Blocks': json.dumps(mine['Blocks']) == json.dumps(ras['Blocks']),
            'Terminals': json.dumps(mine['Terminals']) == json.dumps(ras['Terminals']),
            'blockPins(node)': json.dumps(mine['blockPins']) == json.dumps(b['base_blockPins']),
            'PowerNets.Pins': json.dumps([p['Pins'] for p in mine['PowerNets']]) == json.dumps([p['Pins'] for p in b['base_PowerNets']]),
        }
        ok &= all(checks.values())
        print(a['node_before']['name'], checks)
        if not checks['Blocks']:
            for x, y in zip(mine['Blocks'], ras['Blocks']):
                if json.dumps(x) != json.dumps(y):
                    xi, yi = x['instance'][0], y['instance'][0]
                    for k in xi:
                        if json.dumps(xi[k]) != json.dumps(yi[k]): print('   diff', xi['name'], k, str(xi[k])[:300], '|', str(yi[k])[:300])
                    break
    print('ALL OK' if ok else 'MISMATCH')
