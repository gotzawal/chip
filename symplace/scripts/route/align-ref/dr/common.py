"""모드 5 차분 시험 공용: oracle 입력(토큰), 기록 뽑기, 첫 차이, oracle/Rust 실행.

일감(job) = {'drc': Drc_info JSON, 'node': m4_in hierNode JSON, 'signal': [Lmetal, Hmetal]} (tap 덤프 그대로).
oracle 은 build-oracle.sh 가 만든 것 (DR_ORACLE_DIR), Rust 는 alignroute 네이티브 CLI (cargo build --release).
"""
import json, os, subprocess, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ALIGNROUTE = HERE.parents[3] / 'alignroute'
ORACLE_DIR = Path(os.environ.get('DR_ORACLE_DIR', Path.home() / '.cache/symplace/dr-oracle'))
ORACLE = ORACLE_DIR / 'oracle5'
RUN = ORACLE_DIR / 'run'  # 일감 파일과 oracle 이 쓰는 *_Metal_via*.txt 가 여기에
RUST = Path(os.environ.get('DR_RUST', ALIGNROUTE / 'target/release/alignroute'))

OMARK = {'Omark.N': 0, 'Omark.S': 1, 'Omark.W': 2, 'Omark.E': 3, 'Omark.FN': 4, 'Omark.FS': 5, 'Omark.FW': 6, 'Omark.FE': 7}


def tokens(job):
    """oracle5.cpp main 이 읽는 순서 그대로 (문자열은 16 진)"""
    out = []
    w = out.append
    def s(x): w('s' + x.encode().hex())
    def i(x): w(str(int(x)))
    def d(x): w(repr(float(x)))
    def p(q): i(q['x']); i(q['y'])
    def b(q): p(q['LL']); p(q['UR'])
    def c(q): s(q['metal']); b(q['originBox']); b(q['placedBox']); p(q['originCenter']); p(q['placedCenter'])
    def v(q): i(q['model_index']); p(q['originpos']); p(q['placedpos']); c(q['UpperMetalRect']); c(q['LowerMetalRect']); c(q['ViaRect'])
    def pin(q):
        s(q['name']); i(q['netIter']); i(len(q['pinContacts']))
        for x in q['pinContacts']: c(x)
        i(len(q['pinVias']))
        for x in q['pinVias']: v(x)
    drc = job['drc']
    i(drc['MaxLayer'])
    i(len(drc['Metalmap']))
    for k, x in drc['Metalmap'].items(): s(k); i(x)
    i(len(drc['Viamap']))
    for k, x in drc['Viamap'].items(): s(k); i(x)
    i(len(drc['Metal_info']))
    for m in drc['Metal_info']:
        s(m['name'])
        for k in ['layerNo', 'width', 'dist_ss', 'direct', 'grid_unit_x', 'grid_unit_y', 'minL', 'maxL', 'dist_ee', 'offset']: i(m[k])
        for k in ['unit_R', 'unit_C', 'unit_CC']: d(m[k])
        i(m['lower_via_index']); i(m['upper_via_index'])
    i(len(drc['Via_info']))
    for m in drc['Via_info']:
        s(m['name'])
        for k in ['layerNo', 'lower_metal_index', 'upper_metal_index', 'width', 'width_y', 'cover_l', 'cover_l_P', 'cover_u', 'cover_u_P', 'dist_ss', 'dist_ss_y']: i(m[k])
        d(m['R'])
    i(len(drc['Via_model']))
    for m in drc['Via_model']:
        s(m['name']); i(m['ViaIdx']); i(m['LowerIdx']); i(m['UpperIdx'])
        for r in ['ViaRect', 'LowerRect', 'UpperRect']:
            i(len(m[r]))
            for q in m[r]: p(q)
        d(m['R'])
    n = job['node']
    s(n['name']); i(n['isTop']); i(n.get('isIntelGcellGlobalRouter', False)); i(n['width']); i(n['height']); p(n['LL']); p(n['UR'])
    i(len(n['Terminals']))
    for t in n['Terminals']:
        s(t['name']); s(t.get('type', '')); i(t['netIter']); i(len(t['termContacts']))
        for x in t['termContacts']: c(x)
    i(len(n['Nets']))
    for t in n['Nets']:
        s(t['name']); i(t['shielding']); i(t['sink2Terminal']); i(t['degree']); i(t['symCounterpart']); i(t['iter2SNetLsit']); s(t['priority'])
        i(0 if t['axis_dir'] == 'Smark.H' else 1); i(t['axis_coor']); i(t.get('multi_connection', 1))
        i(len(t['connected']))
        for x in t['connected']: i(0 if x['type'] == 'NType.Block' else 1); i(x['iter']); i(x['iter2'])
    i(len(n['Blocks']))
    for bc in n['Blocks']:
        i(bc['selectedInstance']); i(bc.get('child', -1)); i(bc.get('instNum', 0)); i(len(bc['instance']))
        for q in bc['instance']:
            s(q['name']); s(q['master']); s(q['gdsFile']); i(OMARK.get(q['orient'], 0)); i(q['isLeaf']); i(q['width']); i(q['height'])
            b(q['placedBox']); b(q['originBox'])
            i(len(q['blockPins']))
            for x in q['blockPins']: pin(x)
            i(len(q['interMetals']))
            for x in q['interMetals']: c(x)
            i(len(q['interVias']))
            for x in q['interVias']: v(x)
    i(len(n['PowerNets']))
    for q in n['PowerNets']:
        s(q['name']); i(q['power']); i(len(q['Pins']))
        for x in q['Pins']: pin(x)
        i(len(q['path_metal']))
        for m in q['path_metal']:
            i(m['MetalIdx']); i(m['width']); c(m['MetalRect']); i(len(m['LinePoint']))
            for x in m['LinePoint']: p(x)
        i(len(q['path_via']))
        for x in q['path_via']: v(x)
    dnr = n.get('DoNotRoute', [])
    i(len(dnr))
    for x in dnr: s(x)
    rl = n.get('Routing_Layers', {})
    s(rl.get('global_min_layer', '')); s(rl.get('global_max_layer', ''))
    per = rl.get('Routing_per_Net', [])
    i(len(per))
    for x in per: s(x['net_name']); s(x['net_min_layer']); s(x['net_max_layer'])
    i(job['signal'][0]); i(job['signal'][1])
    return ' '.join(out) + '\n'


def rec5(n):
    """m5_out 덤프(hierNode)에서 모드 5 가 쓰는 것만 — oracle 출력과 같은 모양"""
    return {'Nets': [{'name': x['name'], 'path_metal': x['path_metal'], 'path_via': x['path_via']} for x in n['Nets']],
            'blockPins': n['blockPins'], 'interMetals': n['interMetals'], 'interVias': n['interVias'],
            'Terminals': [{'name': t['name'], 'termContacts': t['termContacts']} for t in n['Terminals']]}


def first_diff(a, b, path=''):
    """처음 다른 곳 (경로, a 쪽, b 쪽) 또는 None"""
    if type(a) != type(b):
        return path, str(a)[:300], str(b)[:300]
    if isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a or k not in b:
                return path + '.' + k, str(a.get(k, '<없음>'))[:300], str(b.get(k, '<없음>'))[:300]
            r = first_diff(a[k], b[k], path + '.' + k)
            if r:
                return r
        return None
    if isinstance(a, list):
        for i, (x, y) in enumerate(zip(a, b)):
            r = first_diff(x, y, f'{path}[{i}]')
            if r:
                return r
        if len(a) != len(b):
            return path + '.len', len(a), len(b)
        return None
    return None if a == b else (path, a, b)


def run_oracle(job, tag='x', timeout=120):
    """C++ 원본 — 기록 | {'error': 'm4: ...'} | ('crash', 코드, stderr) | ('timeout',)"""
    RUN.mkdir(parents=True, exist_ok=True)
    tp = RUN / f'{tag}.tok'
    tp.write_text(tokens(job))
    t0 = time.time()
    try:
        r = subprocess.run([str(ORACLE), str(tp)], capture_output=True, text=True, cwd=RUN, timeout=timeout)
    except subprocess.TimeoutExpired:
        return ('timeout',), timeout
    finally:
        tp.unlink(missing_ok=True)
    dt = time.time() - t0
    if r.returncode != 0:
        return ('crash', r.returncode, r.stderr[-300:]), dt
    return json.loads(r.stdout), dt


def run_rust(job, tag='x', timeout=120):
    """Rust 네이티브 CLI (모드 4, 5) — 기록 | {'error': ...} | ('crash', 코드, stderr) | ('timeout',)"""
    RUN.mkdir(parents=True, exist_ok=True)
    jp = RUN / f'{tag}.json'
    j = dict(job)
    j['modes'] = [4, 5]
    j.setdefault('powerGrid', [4, 5])
    j.setdefault('powerRouting', [0, 5])
    j.setdefault('skip', [7, 8])
    jp.write_text(json.dumps(j))
    t0 = time.time()
    try:
        r = subprocess.run([str(RUST), str(jp)], capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return ('timeout',), timeout
    finally:
        jp.unlink(missing_ok=True)
    dt = time.time() - t0
    if r.returncode != 0:
        return ('crash', r.returncode, r.stderr[-300:]), dt
    o = json.loads(r.stdout)
    if 'error' in o:
        return {'error': o['error']}, dt
    rec = next((x for x in o['records'] if x['mode'] == 5), None)
    return (rec['out'] if rec else {'error': 'no mode 5 record'}), dt


def tap_cases(root):
    """tap 덤프 뿌리에서 (예제, 배치, 모듈, 일감, 기준 기록) — 모드 4 입력마다 바로 뒤 모드 5 출력"""
    root = Path(root).expanduser()
    for ex in sorted(os.listdir(root)):
        if not (root / ex).is_dir():
            continue
        for tag in sorted(os.listdir(root / ex)):
            d = root / ex / tag
            if not (d / 'calls.json').exists():
                continue
            drc = json.loads((d / 'drc.json').read_text())
            calls = json.loads((d / 'calls.json').read_text())
            for c in calls:
                if c['mode'] != 4:
                    continue
                c5 = next((x for x in calls if x['mode'] == 5 and x['node'] == c['node'] and x['k'] == c['k'] + 1), None)
                if c5 is None:
                    continue
                node = json.loads((d / f"{c['k']:02d}_{c['node']}_m4_in.json").read_text())
                want = rec5(json.loads((d / f"{c5['k']:02d}_{c5['node']}_m5_out.json").read_text()))
                yield ex, tag, c['node'], {'drc': drc, 'node': node, 'signal': [c['Lmetal'], c['Hmetal']]}, want
