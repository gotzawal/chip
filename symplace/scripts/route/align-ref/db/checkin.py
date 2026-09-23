"""Re-implement PnRdatabase::CheckinChildnodetoBlock (PnRDB/PnRdatabase.cpp:630-669) on dumps and compare."""
import json, glob, sys

def fwd_box(b, W, H, ort, t):
    llx, lly, urx, ury = b
    if ort == 0:   r = [llx, lly, urx, ury]                 # N
    elif ort == 1: r = [W - urx, H - ury, W - llx, H - lly] # S
    elif ort == 4: r = [W - urx, lly, W - llx, ury]         # FN
    elif ort == 5: r = [llx, H - ury, urx, H - lly]         # FS
    else: raise ValueError(ort)                             # W/E/FW/FE never produced by the placer (no rotation)
    return [r[0] + t[0], r[1] + t[1], r[2] + t[0], r[3] + t[1]]

def fwd_pt(p, W, H, ort, t):
    x, y = p
    if ort == 0: q = [x, y]
    elif ort == 1: q = [W - x, H - y]
    elif ort == 4: q = [W - x, y]
    elif ort == 5: q = [x, H - y]
    return [q[0] + t[0], q[1] + t[1]]

def checkin(block, child):
    W, H = child['UR'][0] - child['LL'][0], child['UR'][1] - child['LL'][1]
    ort, t = block['orient'], block['placedBox'][:2]
    pins = {}
    for p in child['blockPins']:
        pins.setdefault(p['name'], p)   # first match wins (break in the C++ loop)
    out_pins = []
    for bp in block['pins']:
        cp = pins.get(bp['name'])
        if cp is None:
            out_pins.append(bp); continue
        cs = [{**c, 'p': fwd_box(c['o'], W, H, ort, t), 'pc': fwd_pt(c['oc'], W, H, ort, t)} for c in cp['c']]
        vs = [{**v, 'ppos': fwd_pt(v['opos'], W, H, ort, t),
               **{k: {**v[k], 'p': fwd_box(v[k]['o'], W, H, ort, t), 'pc': fwd_pt(v[k]['oc'], W, H, ort, t)} for k in 'ULV'}} for v in cp['v']]
        out_pins.append({**bp, 'c': cs, 'v': vs})
    ims = [{**c, 'p': fwd_box(c['o'], W, H, ort, t), 'pc': fwd_pt(c['oc'], W, H, ort, t)} for c in child['interMetals']]
    ivs = [{**v, 'ppos': fwd_pt(v['opos'], W, H, ort, t),
            **{k: {**v[k], 'p': fwd_box(v[k]['o'], W, H, ort, t), 'pc': fwd_pt(v[k]['oc'], W, H, ort, t)} for k in 'ULV'}} for v in child['interVias']]
    return out_pins, ims, ivs

if __name__ == '__main__':
    d = sys.argv[1]
    top_in = json.load(open(glob.glob(f'{d}/10_*_route_in_{sys.argv[2]}.json')[0]))
    outs = {json.load(open(f))['gdsFile']: json.load(open(f)) for f in glob.glob(f'{d}/11_*')}
    ok = True
    for bc in top_in['Blocks']:
        if bc['child'] < 0: continue
        b = bc['instance'][bc['selectedInstance']]
        child = outs[b['gdsFile']]
        pins, ims, ivs = checkin(b, child)
        same = (json.dumps([p['c'] for p in pins]) == json.dumps([p['c'] for p in b['pins']]) and
                json.dumps([p['v'] for p in pins]) == json.dumps([p['v'] for p in b['pins']]) and
                json.dumps(ims) == json.dumps(b['interMetals']) and json.dumps(ivs) == json.dumps(b['interVias']))
        ok &= same
        print(b['name'], 'orient', b['orient'], 'pins/IM/IV reproduced:', same)
    print('ALL OK' if ok else 'MISMATCH')
