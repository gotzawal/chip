#!/usr/bin/env python3
"""모드 5 차분 시험: 기준 덤프(m4_in)를 흔들어 ALIGN 원본 C++ (oracle5) 과 Rust (모드 4 + 5) 를 견준다.

  fuzz.py freeze [뿌리...]                    tap·tap-vary 의 m4_in 을 말뭉치로 얼린다 (DR_CORPUS)
  fuzz.py run <5|6|7> <seed-from> <seed-to> [-v]   무작위 사례 — 같지 않은 것만 한 줄씩, 끝에 표
  fuzz.py one <5|6|7> <seed>                  한 사례 (일감은 DR_ORACLE_DIR/run/one.json)
  fuzz.py errors <5|6|7> <seed-from> <seed-to>     Rust 만 돌려 오류를 글 앞부분으로 묶는다

흔들기 (씨앗마다 몇 가지만):
  5: 블록 옮기기·뒤집기, 핀 접점 층 바꾸기·지우기·옮기기·더하기, 대칭 짝, 신호 층 범위, Routing_Layers
     (전역·넷별), DoNotRoute, MultiConnection, 단자 연결 더하기, isTop, 같은 핀 두 번, 넷 합치기(핀 24 개 넘게),
     shielding, 내부 금속 더하기
  6: 5 위에 작은 접점(격자 사이), 높은 층 범위(M5 이상), 높은 층 핀, 모든 넷 multi, 모든 넷 대칭 짝,
     뒤집힌·넓이 0 접점, 층 offset·dist_ee·minL·폭 (drc), 모듈 상자 키우기
  7: 6 위에 큰 minL, 긴 비아 간격, 빽빽한 내부 금속, 모듈 상자 줄이기, 넓은 금속
씨앗은 같은 말뭉치에서만 같은 사례를 낸다 (tap-vary 는 늘어난다 — 얼려서 쓴다).

분류: same / same-empty (둘 다 배선 없음) / both-error-m4 (둘 다 모드 4 에서 실패) / both-error /
one-error / DIFF / oracle-crash(+rust-err|ok) / oracle-timeout(+rust-err) / rust-crash / rust-timeout.
C++ 이 정의되지 않은 동작으로 죽거나 끝나지 않는 곳에서 Rust 는 Err 를 낸다 (oracle-*+rust-err 가 맞는 결과).
"""
import copy, glob, json, os, random, re, shutil, sys
from pathlib import Path
from common import ORACLE_DIR, first_diff, run_oracle, run_rust

CORPUS = Path(os.environ.get('DR_CORPUS', Path.home() / '.cache/symplace/dr-corpus'))
BASES = sorted(glob.glob(str(CORPUS / '*/*_m4_in.json')))
METALS = ['M1', 'M2', 'M3', 'M4', 'M5']
METALS8 = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8']
KINDS = ['mv', 'flip', 'pinM', 'pinmv', 'nocontact', 'addcontact', 'LH', 'sym', 'term', 'dup', 'big', 'top', 'dnr', 'multi',
         'shield', 'rl', 'obst']
NEW6 = ['tiny', 'hiLH', 'pinhi', 'multiall', 'symall', 'inv', 'zero', 'off', 'drc', 'bigbox']
NEW7 = ['minL', 'vss', 'dense', 'shrink', 'wide']


def shift_contact(c, dx, dy):
    for b in ('placedBox', 'originBox'):
        for k in ('LL', 'UR'):
            c[b][k]['x'] += dx
            c[b][k]['y'] += dy
    for k in ('placedCenter', 'originCenter'):
        c[k]['x'] += dx
        c[k]['y'] += dy


def flip_contact(c, s):
    """x -> s - x (placed 만)"""
    b = c['placedBox']
    x0, x1 = s - b['UR']['x'], s - b['LL']['x']
    b['LL']['x'], b['UR']['x'] = x0, x1
    c['placedCenter']['x'] = s - c['placedCenter']['x']


def via_contacts(v):
    return [v['UpperMetalRect'], v['LowerMetalRect'], v['ViaRect']]


def move_block(inst, dx, dy):
    for k in ('LL', 'UR'):
        inst['placedBox'][k]['x'] += dx
        inst['placedBox'][k]['y'] += dy
    inst['placedCenter']['x'] += dx
    inst['placedCenter']['y'] += dy
    for p in inst['blockPins']:
        for c in p['pinContacts']:
            shift_contact(c, dx, dy)
        for v in p['pinVias']:
            v['placedpos']['x'] += dx
            v['placedpos']['y'] += dy
            for c in via_contacts(v):
                shift_contact(c, dx, dy)
    for c in inst['interMetals']:
        shift_contact(c, dx, dy)
    for v in inst['interVias']:
        v['placedpos']['x'] += dx
        v['placedpos']['y'] += dy
        for c in via_contacts(v):
            shift_contact(c, dx, dy)


def flip_block(inst):
    s = inst['placedBox']['LL']['x'] + inst['placedBox']['UR']['x']
    for p in inst['blockPins']:
        for c in p['pinContacts']:
            flip_contact(c, s)
        for v in p['pinVias']:
            v['placedpos']['x'] = s - v['placedpos']['x']
            for c in via_contacts(v):
                flip_contact(c, s)
    for c in inst['interMetals']:
        flip_contact(c, s)
    for v in inst['interVias']:
        v['placedpos']['x'] = s - v['placedpos']['x']
        for c in via_contacts(v):
            flip_contact(c, s)


def rect(metal, x0, y0, x1, y1):
    return {'metal': metal, 'originBox': {'LL': {'x': x0, 'y': y0}, 'UR': {'x': x1, 'y': y1}}, 'placedBox': {'LL': {'x': x0, 'y': y0}, 'UR': {'x': x1, 'y': y1}},
            'originCenter': {'x': (x0 + x1) // 2, 'y': (y0 + y1) // 2}, 'placedCenter': {'x': (x0 + x1) // 2, 'y': (y0 + y1) // 2}}


def gen5(seed):
    R = random.Random(seed)
    base = BASES[R.randrange(len(BASES))]
    d = os.path.dirname(base)
    drc = json.load(open(d + '/drc.json'))
    node = json.load(open(base))
    calls = json.load(open(d + '/calls.json'))
    k = int(os.path.basename(base)[:2])
    c = next(x for x in calls if x['k'] == k)
    L, H = c['Lmetal'], c['Hmetal']
    nets = node['Nets']
    insts = [bc['instance'][bc['selectedInstance']] for bc in node['Blocks']]
    W, Hh = node['width'], node['height']
    kinds = set(R.sample(KINDS, R.choice([1, 1, 2, 2, 3, 4])))
    tags = []
    if 'mv' in kinds or 'flip' in kinds:
        for inst in insts:
            if 'mv' in kinds and R.random() < 0.4:
                q = R.choice([8, 16, 80, 160, 168, 320, 336])
                move_block(inst, q * R.randrange(-6, 7), q * R.randrange(-6, 7))
                tags.append('mv')
            if 'flip' in kinds and R.random() < 0.3:
                flip_block(inst)
                tags.append('flip')
    for inst in insts:
        for p in inst['blockPins']:
            for cc in p['pinContacts']:
                if 'pinM' in kinds and R.random() < 0.1:
                    cc['metal'] = R.choice(METALS[:4])
                    tags.append('pinM')
                if 'pinmv' in kinds and R.random() < 0.1:
                    shift_contact(cc, R.choice([-160, 160, -168, 168, 32, -40, 8]), R.choice([-168, 168, 0, 40, -8]))
                    tags.append('pinmv')
            if 'nocontact' in kinds and R.random() < 0.08 and p['pinContacts']:
                p['pinContacts'] = []
                tags.append('nocontact')
            if 'addcontact' in kinds and R.random() < 0.15 and p['pinContacts']:
                b = p['pinContacts'][0]['placedBox']
                dx, dy = R.choice([(0, 336), (0, -336), (320, 0), (-320, 0), (160, 168)])
                p['pinContacts'].append(rect(R.choice(METALS[:3]), b['LL']['x'] + dx, b['LL']['y'] + dy, b['UR']['x'] + dx, b['UR']['y'] + dy))
                tags.append('addcontact')
    if 'obst' in kinds:
        for inst in insts:
            if R.random() < 0.5:
                bx = inst['placedBox']
                for _ in range(R.randrange(1, 6)):
                    x0 = R.randrange(bx['LL']['x'], max(bx['LL']['x'] + 1, bx['UR']['x']))
                    y0 = R.randrange(bx['LL']['y'], max(bx['LL']['y'] + 1, bx['UR']['y']))
                    m = R.choice(METALS[:4])
                    if m in ('M1', 'M3'):
                        inst['interMetals'].append(rect(m, x0 - 32, y0, x0 + 32, y0 + R.choice([400, 1000, 3000])))
                    else:
                        inst['interMetals'].append(rect(m, x0, y0 - 32, x0 + R.choice([400, 1000, 3000]), y0 + 32))
                tags.append('obst')
    if 'LH' in kinds:
        L, H = R.choice([(1, 4), (0, 3), (0, 5), (1, 3), (2, 4), (0, 2), (1, 5), (0, 6)])
        tags.append(f'LH{L}{H}')
    if 'sym' in kinds and len(nets) >= 2:
        idx = list(range(len(nets)))
        R.shuffle(idx)
        for a, b in zip(idx[0::2], idx[1::2]):
            if R.random() < 0.5:
                nets[a]['symCounterpart'] = b
                nets[b]['symCounterpart'] = a
                ad = R.choice(['Smark.V', 'Smark.H'])
                nets[a]['axis_dir'] = nets[b]['axis_dir'] = ad
                tags.append('sym' + ad[-1])
                if R.random() < 0.05:
                    nets[a]['symCounterpart'] = a
                    tags.append('symself')
    if 'term' in kinds and node['Terminals']:
        for n in nets:
            if R.random() < 0.3:
                for _ in range(R.choice([1, 2])):
                    ti = R.randrange(len(node['Terminals']))
                    n['connected'].insert(R.randrange(len(n['connected']) + 1), {'type': 'NType.Terminal', 'iter': ti, 'iter2': -1})
                tags.append('term')
    if 'dup' in kinds:
        n = R.choice(nets)
        if n['connected']:
            n['connected'].append(dict(R.choice(n['connected'])))
            tags.append('dup')
    if 'big' in kinds and len(nets) >= 3:
        big = R.choice(nets)
        for n in nets:
            if n is not big and R.random() < 0.7:
                big['connected'] += [dict(x) for x in n['connected'] if x['type'] == 'NType.Block']
        tags.append(f'big{len(big["connected"])}')
    if 'top' in kinds:
        node['isTop'] = not node['isTop']
        tags.append('top')
    dnr = [n['name'] for n in nets if 'dnr' in kinds and R.random() < 0.2]
    if dnr:
        tags.append('dnr')
    for n in nets:
        n['multi_connection'] = 1
        if 'multi' in kinds and R.random() < 0.2:
            n['multi_connection'] = R.choice([0, 2, 2, 3])
            tags.append(f'multi{n["multi_connection"]}')
        if 'shield' in kinds and R.random() < 0.2:
            n['shielding'] = True
            tags.append('shield')
    rl = {'global_min_layer': '', 'global_max_layer': '', 'Routing_per_Net': []}
    if 'rl' in kinds:
        if R.random() < 0.4:
            rl['global_min_layer'] = R.choice(['M1', 'M2', 'M3'])
        if R.random() < 0.4:
            rl['global_max_layer'] = R.choice(['M3', 'M4', 'M5', 'M6'])
        for n in nets:
            if R.random() < 0.3:
                rl['Routing_per_Net'].append({'net_name': n['name'], 'net_min_layer': R.choice(['M1', 'M2', 'M3']),
                                              'net_max_layer': R.choice(['M2', 'M3', 'M4', 'M5'])})
        tags.append('rl')
    node['DoNotRoute'] = dnr
    node['Routing_Layers'] = rl
    node['Multi_connections'] = []
    for n in nets:
        n['degree'] = len(n['connected'])
    job = {'drc': drc, 'node': node, 'signal': [L, H]}
    return job, f"{os.path.basename(d)}/{os.path.basename(base)[:24]} {' '.join(sorted(set(tags)))}"


def classify(o, r):
    """(분류, 자세히)"""
    if isinstance(o, tuple) and o[0] == 'timeout':
        return ('oracle-timeout+rust-err' if not isinstance(r, tuple) and 'error' in r else 'oracle-timeout'), (r.get('error', '')[:150] if isinstance(r, dict) else r)
    if isinstance(r, tuple) and r[0] == 'timeout':
        return 'rust-timeout', ''
    if isinstance(r, tuple):
        return 'rust-crash', r
    if isinstance(o, tuple):
        return ('oracle-crash+rust-err' if 'error' in r else 'oracle-crash+rust-ok'), (o[2][-150:] if len(o) > 2 else o, r.get('error', '')[:150])
    oe, re_ = 'error' in o, 'error' in r
    if oe and re_:
        m4 = o['error'].startswith('m4:')
        return ('both-error-m4' if m4 else 'both-error'), (o['error'][:120], r['error'][:120])
    if oe or re_:
        return 'one-error', (o.get('error', 'oracle ok')[:150], r.get('error', 'rust ok')[:150])
    fd = first_diff(r, o)
    if fd:
        return 'DIFF', fd
    routed = sum(len(n['path_metal']) for n in r['Nets'])
    return ('same' if routed else 'same-empty'), ''


def contacts(insts):
    for inst in insts:
        for p in inst['blockPins']:
            for c in p['pinContacts']:
                yield p, c


def set_box(c, x0, y0, x1, y1):
    for b in ('placedBox', 'originBox'):
        c[b]['LL']['x'], c[b]['LL']['y'], c[b]['UR']['x'], c[b]['UR']['y'] = x0, y0, x1, y1
    for k in ('placedCenter', 'originCenter'):
        c[k]['x'], c[k]['y'] = (x0 + x1) // 2, (y0 + y1) // 2


def gen6(seed):
    # gen5 의 흔들기(씨앗을 섞어서) 위에 새 흔들기를 얹는다
    job, desc = gen5(seed * 7919 + 13)
    R = random.Random(seed)
    node, drc = job['node'], copy.deepcopy(job['drc'])
    job['drc'] = drc
    nets = node['Nets']
    insts = [bc['instance'][bc['selectedInstance']] for bc in node['Blocks']]
    kinds = set(R.sample(NEW6, R.choice([1, 1, 2, 2, 3])))
    tags = []
    if 'tiny' in kinds:
        for p, c in contacts(insts):
            if R.random() < 0.25:
                b = c['placedBox']
                xs = sorted((b['LL']['x'], b['UR']['x']))
                ys = sorted((b['LL']['y'], b['UR']['y']))
                x0 = R.randrange(xs[0] - 40, xs[1] + 41)
                y0 = R.randrange(ys[0] - 40, ys[1] + 41)
                set_box(c, x0, y0, x0 + R.randrange(1, 48), y0 + R.randrange(1, 48))
                if R.random() < 0.3:
                    c['metal'] = R.choice(METALS8[:6])
                tags.append('tiny')
    if 'hiLH' in kinds:
        job['signal'] = list(R.choice([(2, 5), (3, 6), (4, 7), (1, 6), (2, 8), (4, 9), (0, 7), (5, 8), (1, 4)]))
        tags.append(f'LH{job["signal"][0]}{job["signal"][1]}')
    if 'pinhi' in kinds:
        for p, c in contacts(insts):
            if R.random() < 0.15:
                c['metal'] = R.choice(METALS8[3:8])
                tags.append('pinhi')
    if 'multiall' in kinds:
        for n in nets:
            n['multi_connection'] = R.choice([2, 2, 3])
        tags.append('multiall')
    if 'symall' in kinds and len(nets) >= 2:
        idx = list(range(len(nets)))
        R.shuffle(idx)
        ad = R.choice(['Smark.V', 'Smark.H'])
        for a, b in zip(idx[0::2], idx[1::2]):
            nets[a]['symCounterpart'], nets[b]['symCounterpart'] = b, a
            nets[a]['axis_dir'] = nets[b]['axis_dir'] = ad
        tags.append('symall' + ad[-1])
    if 'inv' in kinds:
        for p, c in contacts(insts):
            if R.random() < 0.1:
                b = c['placedBox']
                if R.random() < 0.5:
                    b['LL']['x'], b['UR']['x'] = b['UR']['x'], b['LL']['x']
                else:
                    b['LL']['y'], b['UR']['y'] = b['UR']['y'], b['LL']['y']
                tags.append('inv')
    if 'zero' in kinds:
        for p, c in contacts(insts):
            if R.random() < 0.1:
                b = c['placedBox']
                xs = sorted((b['LL']['x'], b['UR']['x']))
                ys = sorted((b['LL']['y'], b['UR']['y']))
                x, y = R.randrange(xs[0], xs[1] + 1), R.randrange(ys[0], ys[1] + 1)
                set_box(c, x, y, x, y)
                tags.append('zero')
    MI = drc['Metal_info']
    if 'off' in kinds:
        for m in MI[:8]:
            if R.random() < 0.4:
                u = m['grid_unit_x'] if m['direct'] == 0 else m['grid_unit_y']
                m['offset'] = R.choice([u // 2, u // 4, 8, 40, u - 8])
                tags.append(f'off{m["name"]}')
    if 'drc' in kinds:
        for m in MI[:8]:
            r = R.random()
            if r < 0.15:
                m['dist_ee'] = R.choice([0, 8, 20, 40, 60])
                tags.append('ee')
            elif r < 0.3:
                m['minL'] = R.choice([0, 100, 800, 1200, 2000, 3000])
                tags.append('minL')
            elif r < 0.4:
                m['width'] = R.choice([32, 48, 96, 128])
                tags.append('w')
            elif r < 0.5:
                m['dist_ss'] = R.choice([0, 40, 200, 300])
                tags.append('ss')
        for v in drc['Via_info'][:7]:
            if R.random() < 0.15:
                v['dist_ss'] = R.choice([0, 40, 200, 400])
                v['dist_ss_y'] = R.choice([0, 40, 200, 400])
                tags.append('vss')
    if 'bigbox' in kinds:
        f = R.choice([2, 3])
        node['width'] *= f
        node['height'] *= f
        node['UR']['x'] = node['LL']['x'] + node['width']
        node['UR']['y'] = node['LL']['y'] + node['height']
        if R.random() < 0.5:
            for inst in insts:
                if R.random() < 0.5:
                    move_block(inst, R.choice([0, 1, 2]) * 3360, R.choice([0, 1, 2]) * 3528)
        tags.append(f'bigbox{f}')
    for n in nets:
        n['degree'] = len(n['connected'])
    return job, desc + ' | ' + ' '.join(sorted(set(tags)))


def gen7(seed):
    job, desc = gen6(seed * 104729 + 7)
    R = random.Random(seed ^ 0x5eed)
    node, drc = job['node'], job['drc']
    insts = [bc['instance'][bc['selectedInstance']] for bc in node['Blocks']]
    kinds = set(R.sample(NEW7, R.choice([1, 2, 2, 3])))
    tags = []
    MI = drc['Metal_info']
    if 'minL' in kinds:
        for m in MI[:6]:
            if R.random() < 0.6:
                m['minL'] = R.choice([1000, 2000, 3000, 5000, 8000])
                tags.append('minL')
    if 'vss' in kinds:
        for v in drc['Via_info'][:6]:
            if R.random() < 0.6:
                v['dist_ss'] = R.choice([300, 600, 1000])
                v['dist_ss_y'] = R.choice([300, 600, 1000])
                tags.append('vss')
    if 'dense' in kinds:
        for inst in insts:
            bx = inst['placedBox']
            x0s, x1s = sorted((bx['LL']['x'], bx['UR']['x']))
            y0s, y1s = sorted((bx['LL']['y'], bx['UR']['y']))
            for _ in range(R.randrange(3, 15)):
                x0 = R.randrange(x0s - 400, x1s + 401)
                y0 = R.randrange(y0s - 400, y1s + 401)
                m = R.choice(['M1', 'M2', 'M3', 'M4'])
                if m in ('M1', 'M3'):
                    inst['interMetals'].append(rect(m, x0 - 40, y0, x0 + 40, y0 + R.choice([200, 600, 2000])))
                else:
                    inst['interMetals'].append(rect(m, x0, y0 - 40, x0 + R.choice([200, 600, 2000]), y0 + 40))
            tags.append('dense')
    if 'shrink' in kinds:
        # 모듈 상자를 줄여 칸이 밖으로 나가게
        f = R.choice([0.5, 0.7, 0.9])
        node['width'] = int(node['width'] * f)
        node['height'] = int(node['height'] * f)
        node['UR']['x'] = node['LL']['x'] + node['width']
        node['UR']['y'] = node['LL']['y'] + node['height']
        tags.append(f'shrink{f}')
    if 'wide' in kinds:
        for m in MI[:6]:
            if R.random() < 0.5:
                m['width'] = R.choice([160, 200, 300])
                tags.append('wide')
    return job, desc + ' || ' + ' '.join(sorted(set(tags)))



def freeze(roots):
    """뿌리/예제/배치 마다 drc.json, calls.json, *_m4_in.json 을 CORPUS/<뿌리>__<예제>__<배치>/ 로"""
    n = 0
    for root in roots:
        root = Path(root).expanduser()
        for d in sorted(root.glob('*/*')):
            if not (d / 'calls.json').exists():
                continue
            ins = sorted(d.glob('*_m4_in.json'))
            if not ins:
                continue
            dst = CORPUS / f'{root.name}__{d.parent.name}__{d.name}'
            dst.mkdir(parents=True, exist_ok=True)
            for f in [d / 'drc.json', d / 'calls.json'] + ins:
                shutil.copy(f, dst / f.name)
            n += len(ins)
    print(f'{CORPUS}: m4_in {n} 개')


GEN = {'5': gen5, '6': gen6, '7': gen7}


def one_case(gen, seed, tag):
    job, desc = gen(seed)
    o, to = run_oracle(job, tag, timeout=60)
    r, tr = run_rust(job, tag)
    return job, desc, o, to, r, tr


if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'freeze':
        freeze(sys.argv[2:] or ['~/.cache/symplace/tap', '~/.cache/symplace/tap-vary'])
        sys.exit(0)
    if not BASES:
        sys.exit(f'말뭉치가 비었다: {CORPUS} (fuzz.py freeze)')
    gen = GEN[sys.argv[2]]
    if cmd == 'one':
        seed = int(sys.argv[3])
        job, desc, o, to, r, tr = one_case(gen, seed, 'one')
        (ORACLE_DIR / 'run').mkdir(parents=True, exist_ok=True)
        (ORACLE_DIR / 'run/one.json').write_text(json.dumps(job))
        print(desc, f'oracle {to:.2f}s rust {tr:.2f}s', classify(o, r))
    elif cmd == 'run':
        a, b = int(sys.argv[3]), int(sys.argv[4])
        tally = {}
        for seed in range(a, b):
            job, desc, o, to, r, tr = one_case(gen, seed, f'f{sys.argv[2]}_{seed}')
            k, det = classify(o, r)
            tally[k] = tally.get(k, 0) + 1
            if k not in ('same', 'same-empty', 'both-error-m4') or '-v' in sys.argv:
                print(seed, k, desc, f'o{to:.1f}s r{tr:.1f}s', str(det)[:400], flush=True)
        print(tally, flush=True)
    elif cmd == 'errors':
        a, b = int(sys.argv[3]), int(sys.argv[4])
        groups = {}
        for seed in range(a, b):
            job, desc = gen(seed)
            r, tr = run_rust(job, f'e{sys.argv[2]}_{seed}')
            if isinstance(r, tuple):
                e = f'{r[0]} {r[1:]}'
            elif 'error' in r:
                e = r['error']
            else:
                continue
            groups.setdefault(re.sub(r'-?\d+', 'N', e)[:70], []).append(seed)
        for k, v in sorted(groups.items(), key=lambda kv: -len(kv[1])):
            print(f'{len(v):5d} {k}  e.g. {v[:8]}')
