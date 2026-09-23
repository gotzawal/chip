"""Convert RouteWork tap dumps (full PnRDB field names) into the compact format used by pg_proto.py."""
import json


def bx(b):
    return [b['LL']['x'], b['LL']['y'], b['UR']['x'], b['UR']['y']]


def P(p):
    return [p['x'], p['y']]


def C(c):
    return {'metal': c['metal'], 'p': bx(c['placedBox']), 'pc': P(c['placedCenter'])}


def Vv(v):
    return {'model': v['model_index'], 'ppos': P(v['placedpos']), 'U': C(v['UpperMetalRect']),
            'L': C(v['LowerMetalRect']), 'V': C(v['ViaRect'])}


def PIN(p):
    return {'name': p['name'], 'netIter': p['netIter'], 'c': [C(x) for x in p['pinContacts']],
            'v': [Vv(x) for x in p['pinVias']]}


def MET(m):
    return {'idx': m['MetalIdx'], 'pts': [P(q) for q in m['LinePoint']], 'w': m['width'], 'r': C(m['MetalRect'])}


def convert(d):
    out = {'name': d['name'], 'isTop': d['isTop'], 'width': d['width'], 'height': d['height'],
           'LL': P(d['LL']), 'UR': P(d['UR'])}
    out['Blocks'] = [{'selectedInstance': bc['selectedInstance'],
                      'instance': [{'name': b.get('name'), 'pins': [PIN(p) for p in b['blockPins']],
                                    'interMetals': [C(x) for x in b['interMetals']],
                                    'interVias': [Vv(x) for x in b['interVias']]} for b in bc['instance']]}
                     for bc in d['Blocks']]
    out['Nets'] = [{'name': n['name'], 'path_metal': [MET(m) for m in n['path_metal']],
                    'path_via': [Vv(v) for v in n['path_via']]} for n in d['Nets']]
    out['Terminals'] = [{'name': t['name'], 'termContacts': [C(x) for x in t['termContacts']]} for t in d['Terminals']]
    out['PowerNets'] = [{'name': n['name'], 'power': int(n['power']), 'Pins': [PIN(p) for p in n['Pins']],
                         'path_metal': [MET(m) for m in n['path_metal']], 'path_via': [Vv(v) for v in n['path_via']]}
                        for n in d['PowerNets']]
    for k in ('Vdd', 'Gnd'):
        out[k] = {'name': d[k]['name'], 'metals': [MET(m) for m in d[k]['metals']], 'vias': [Vv(v) for v in d[k]['vias']]}
    for k in ('DoNotRoute', 'Multi_connections'):
        if k in d:
            out[k] = d[k]
    return out


def load(path):
    return convert(json.load(open(path)))
