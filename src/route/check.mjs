/** DRC / LVS — ALIGN 검사기(align/cell_fabric)의 JS 이식.
 *
 *  ALIGN 은 배선이 끝나면 gen_viewer_json 이 모은 도형 전체를 이 검사기에 넣는다.
 *  새 배선기의 합격선을 ALIGN 과 **같은 잣대**로 재려고 옮겼다. 규칙과 순서를 원본대로
 *  둔다 — 오류 목록이 파이썬과 같아야 한다 (symplace/web/placer/test/check.mjs 가 대조한다).
 *
 *    remove_duplicates.py   같은 층·같은 중심선 도형을 이어 붙여 넷을 합친다.
 *                           SHORT (다른 넷이 닿음) · OPEN (한 넷이 여러 덩이) ·
 *                           DIFFERENT WIDTH (같은 중심선에 폭이 다름)
 *    drc.py                 비아 간격 (SpaceX/Y) · 비아 둘러싸기 (VencA_L/H) ·
 *                           금속 최소 길이 (MinL) · 끝단 간격 (EndToEnd)
 *    postprocess.py         (최상위만) 색 칠하기 — M1~M3 도형마다 색 사본을 더한다
 *
 *  검사기 캔버스는 PDK 의 MOSGenerator 다. 층마다 무엇으로 보는지는 거기서 온다:
 *  금속은 PDK 방향대로, 비아는 '*' (세로선처럼 x 중심선으로 묶는다), 소자층은 아래
 *  DEVICE_LAYERS, Nselect·Pselect·Nwell·Boundary 는 건너뛴다. 그 밖의 층은 무시한다
 *  (ALIGN 도 경고만 찍고 버린다 — 출력 도형에서도 빠진다).
 */

// pdks/FinFET14nm_Mock_PDK/mos.py 의 addGen 순서 (금속·비아 다음에 온다)
const DEVICE_LAYERS = [
  ["Poly", "v"], ["Fin", "h"], ["Active", "h"], ["Rvt", "h"], ["Lvt", "h"], ["Hvt", "h"],
  ["Slvt", "h"], ["Lisd", "v"], ["Pc", "h"], ["Pb", "h"], ["V0", "*"],
];
const REGION_LAYERS = ["boundary", "Rboundary", "Boundary", "Nselect", "Pselect", "Nwell"];
const INDICES = { h: [[1, 3], 0], v: [[0, 2], 1], "*": [[0, 2], 1] };

// ---------------------------------------------------------------- 파이썬 repr
// 오류 문구를 ALIGN 의 .errors 파일과 같은 글자로 쓰려고 쓴다.
const pyStr = (s) => (s == null ? "None"
  : !s.includes("'") ? `'${s}'` : !s.includes('"') ? `"${s}"` : `'${s.replace(/'/g, "\\'")}'`);
const pyList = (a) => "[" + a.join(", ") + "]";
const pyName = (s) => (s == null ? "None" : String(s));        // f"{x}" — str(), 따옴표 없음
const pyBool = (b) => (b ? "True" : "False");
const pyTuple = (items) => "(" + items.join(", ") + (items.length === 1 ? ",)" : ")");
const floorDiv = (a, b) => Math.floor(a / b);
const pyMod = (a, b) => ((a % b) + b) % b;

/** CPython 3.12 set 의 반복 순서 — 작은 음 아닌 정수만 (폭은 늘 그렇다). */
function pySetOrder(ints) {
  let mask = 7, table = new Array(8).fill(null), fill = 0;
  const insert = (tbl, m, v) => {
    let i = v & m, perturb = v;
    for (;;) {
      const probes = i + 9 <= m ? 9 : 0;
      for (let k = 0, j = i; k <= probes; k++, j++) {
        if (tbl[j] === null) { tbl[j] = v; return; }
        if (tbl[j] === v) return;
      }
      perturb = Math.floor(perturb / 32);
      i = (i * 5 + 1 + perturb) & m;
    }
  };
  for (const v of ints) {
    if (table.includes(v)) continue;
    insert(table, mask, v); fill++;
    if (fill * 5 >= mask * 3) {
      let size = 8;
      while (size <= fill * 4) size <<= 1;
      const old = table.filter((x) => x !== null);
      mask = size - 1; table = new Array(size).fill(null);
      for (const x of old) insert(table, mask, x);
    }
  }
  return table.filter((x) => x !== null);
}

// ---------------------------------------------------------------- 규칙
/** layers.json -> 검사기가 쓰는 표. */
export function checkerRules(layersJson) {
  const pdk = new Map();
  for (const L of layersJson.Abstraction) {
    const info = {};
    for (const [k, v] of Object.entries(L)) if (k !== "Layer") info[k] = v === "NA" ? null : v;
    if (L.Layer.startsWith("M") && info.Direction) info.Direction = info.Direction.toLowerCase();
    pdk.set(L.Layer, info);
  }
  const layers = new Map();                 // 층 -> 'h' | 'v' | '*' (생성기 순서)
  for (const [name, info] of pdk) {
    if (name.startsWith("M")) { if (!layers.has(name)) layers.set(name, info.Direction); }
    else if (name.startsWith("V") && !info.Stack.some((x) => x == null)) {
      if (!layers.has(name)) layers.set(name, "*");
    }
  }
  for (const [name, dir] of DEVICE_LAYERS) if (!layers.has(name)) layers.set(name, dir);
  const skip = new Set(REGION_LAYERS);
  // (via, 세로 금속, 가로 금속) — canvas._initialize_layer_stack
  const layerStack = [];
  for (const [name, info] of pdk) {
    if (!name.startsWith("V")) continue;
    const [pl, nl] = info.Stack;
    const nlDir = nl == null ? null : pdk.get(nl)?.Direction;
    layerStack.push(nlDir === "h" ? [name, pl, nl] : [name, nl, pl]);
  }
  // 후처리 — 색이 있는 금속은 ColorClosure, ViaCut 이 있는 비아는 ViaArrayGenerator
  const post = new Map();
  for (const [name, info] of pdk) {
    if (name.startsWith("M") && Array.isArray(info.Color) && info.Color.length) post.set(name, { kind: "color", info });
    else if (name.startsWith("V") && info.ViaCut) post.set(name, { kind: "viacut", cut: info.ViaCut });
  }
  return { pdk, layers, skip, layerStack, post };
}

// ---------------------------------------------------------------- 자료구조
class Slr {
  constructor(rect, netName, netType, isPorted) {
    this.dad = this;
    this.rect = rect.slice();
    this.netType = netType;
    this.terminal = null;
    this.netName = null;
    if (netName != null && netName.includes(":")) {
      this.terminal = netName.split(":");
      if (this.terminal.length !== 2) throw new Error(`단자 이름이 이상하다: ${netName}`);
    } else this.netName = netName ?? null;
    this.isPorted = isPorted;
  }
  root() {
    let r = this;
    while (r.dad !== r) r = r.dad;
    let x = this;
    while (x.dad !== x) { const next = x.dad; x.dad = r; x = next; }
    return r;
  }
  connect(other) { other.root().dad = this.root(); }
  repr() { return pyTuple([pyList(this.rect), pyStr(this.netName), pyStr(this.netType)]); }
}

const touching = (a, b) => !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);

// ---------------------------------------------------------------- 검사
/**
 * @param {Array<{layer,netName,netType,rect,terminal?}>} terminals  gen_viewer_json 이 모은 도형 (PDK 단위)
 * @param {ReturnType<typeof checkerRules>} rules
 * @param {object} [o]
 * @param {string[]} [o.netsAllowedToBeOpen]  열려도 되는 넷 (DoNotRoute, 하위 모듈의 전원 넷)
 * @param {boolean} [o.postprocess]  최상위면 true — 색 칠하기
 * @param {string[]} [o.subinsts]  캔버스의 subinsts 순서 (단자 SHORT 의 순서만 좌우한다)
 */
export function check(terminals, rules, o = {}) {
  const { pdk, layers, skip, layerStack } = rules;
  const allowed = new Set(o.netsAllowedToBeOpen ?? []);
  const allowOpens = !!o.allowOpens;
  const shorts = [], opens = [], differentWidths = [], drc = [], warnings = [];

  const subinsts = new Map();
  const pinsOf = (inst) => {
    if (!subinsts.has(inst)) subinsts.set(inst, new Map());
    return subinsts.get(inst);
  };
  for (const s of o.subinsts ?? []) pinsOf(s);
  const pinSet = ([inst, pin]) => {
    const pins = pinsOf(inst);
    if (!pins.has(pin)) pins.set(pin, new Set());
    return pins.get(pin);
  };

  function connectPair(layer, a, b) {
    const n = shorts.length;
    if (a.netName == null) { a.netName = b.netName; a.connect(b); }
    else if (b.netName == null || a.netName === b.netName) { b.netName = a.netName; a.connect(b); }
    else shorts.push({ kind: "connectpair", text: `CONNECTPAIR ${layer} ${a.repr()} ${b.repr()}` });
    if (a.terminal == null && b.terminal == null) return n === shorts.length;
    if (a.terminal != null) pinSet(a.terminal).add(a);
    if (b.terminal != null) pinSet(b.terminal).add(b);
    return false;
  }

  // --- build_centerline_tbl ---
  const tbl = new Map();
  for (const d of terminals) {
    const { layer, rect, netName = null } = d;
    const netType = d.netType;
    const isPorted = String(netType).includes("pin");
    if (isPorted && netName == null) throw new Error(`핀 도형에 넷 이름이 없다: ${layer} ${rect}`);
    if (skip.has(layer)) continue;
    if (!layers.has(layer)) { warnings.push(`Layer ${layer} not in layers`); continue; }
    const [idx] = INDICES[layers.get(layer)];
    const tc = rect[idx[0]] + rect[idx[1]];
    if (!tbl.has(layer)) tbl.set(layer, new Map());
    const bins = tbl.get(layer);
    if (!bins.has(tc)) bins.set(tc, []);
    bins.get(tc).push([rect, netName, netType, isPorted]);
  }

  // --- build_scan_lines ---
  const store = new Map();               // 층 -> (2x 중심선 -> {indices, dIndex, rects})
  for (const [layer, dir] of layers) {
    if (!tbl.has(layer)) continue;
    const [indices, dIndex] = INDICES[dir];
    for (const [tc, v] of tbl.get(layer)) {
      const rect0 = v[0][0];
      for (const [rect] of v.slice(1)) {
        if (!indices.every((i) => rect[i] === rect0[i]) && layer !== "Active") {
          const widths = pySetOrder(v.map(([r]) => r[indices[1]] - r[indices[0]]));
          differentWidths.push({
            layer, twiceCenter: tc, widths, indices: indices.slice(),
            v: v.map(([r, n, t, p]) => [r.slice(), n, t, p]),
            msg: `Rectangles on layer ${layer} with the same 2x centerline ${tc} but different widths {${widths.join(", ")}}:`,
          });
        }
      }
      if (!store.has(layer)) store.set(layer, new Map());
      const sl = { indices, dIndex, rects: [] };
      store.get(layer).set(tc, sl);
      let cur = null;
      const sorted = v.map((e, k) => [e, k]).sort((p, q) => p[0][0][dIndex] - q[0][0][dIndex] || p[1] - q[1]);
      for (const [[rect, netName, netType, isPorted]] of sorted) {
        const pot = new Slr(rect, netName, netType, isPorted);
        if (sl.rects.length && rect[dIndex] <= cur.rect[dIndex + 2] &&
            indices.every((i) => rect[i] === cur.rect[i])) {
          if (connectPair(layer, cur, pot)) {
            if (pot.netType !== "blockage" && cur.netType !== "blockage") {
              cur.rect[dIndex + 2] = Math.max(cur.rect[dIndex + 2], pot.rect[dIndex + 2]);
              cur.isPorted = cur.isPorted || pot.isPorted;
            } else { sl.rects.push(pot); cur = pot; }
          } else { sl.rects.push(pot); cur = pot; }
        } else { sl.rects.push(pot); cur = pot; }
      }
    }
  }

  const findTouching = (sl, via) => sl.rects.find((m) => touching(via.rect, m.rect)) ?? null;

  // --- check_shorts_induced_by_vias ---
  for (const [via, mv, mh] of layerStack) {
    if (mv == null && mh == null) continue;
    if (!store.has(via)) continue;
    for (const [tc, vsl] of store.get(via)) {
      if (mv != null) {
        const msl = store.get(mv)?.get(tc);
        if (!msl) { warnings.push(`${tc} not in store_scan_lines[${mv}]`); continue; }
        for (const vr of vsl.rects) {
          const mr = findTouching(msl, vr);
          if (!mr) { drc.push(`No ${mv} metal touching ${via} ${pyList(vr.rect)}`); continue; }
          connectPair(via, mr.root(), vr.root());
        }
      }
      if (mh != null) {
        for (const vr of vsl.rects) {
          const tcy = vr.rect[1] + vr.rect[3];
          const msl = store.get(mh)?.get(tcy);
          if (!msl) { warnings.push(`${tcy} not in store_scan_lines[${mh}]`); continue; }
          const mr = findTouching(msl, vr);
          if (!mr) { drc.push(`No ${mh} metal touching ${via} ${pyList(vr.rect)}`); continue; }
          connectPair(via, vr.root(), mr.root());
        }
      }
    }
  }

  // --- check_shorts_induced_by_terminals ---
  for (const [inst, pins] of subinsts)
    for (const [pin, slrs] of pins) {
      const names = new Set([...slrs].map((x) => x.root().netName ?? null));
      if (names.size > 1)
        shorts.push({ kind: "terminal", names: [...names].sort((a, b) => (a == null) - (b == null) || (a < b ? -1 : a > b ? 1 : 0)),
                      where: `THROUGH TERMINAL ${inst}:${pin}` });
    }

  // --- check_opens ---
  const setOpen = (nm, opn) => { if (!(typeof nm === "string" && allowed.has(nm)) && !allowOpens) opens.push(opn); };
  const byNet = new Map();
  for (const [layer, v] of store)
    for (const sl of v.values())
      for (const slr of sl.rects) {
        const root = slr.root(), nm = root.netName;
        if (nm != null) {
          if (!byNet.has(nm)) byNet.set(nm, new Map());
          const parts = byNet.get(nm);
          if (!parts.has(root)) parts.set(root, []);
          parts.get(root).push([layer, slr.rect]);
        } else if (slr.terminal != null) {
          pinSet(slr.terminal).add(null);
          setOpen(null, { kind: "terminal", terminal: slr.terminal.slice() });
        }
      }
  for (const [nm, parts] of byNet)
    if (parts.size > 1) setOpen(nm, { kind: "net", net: nm, parts: [...parts.values()].map((p) => p.map(([l, r]) => [l, r.slice()])) });

  // --- generate_rectangles ---
  let out = terminals.filter((d) => skip.has(d.layer));
  for (const [layer, vv] of store)
    for (const sl of vv.values())
      for (const slr of sl.rects) {
        const t = { layer, netName: slr.root().netName, rect: slr.rect.slice(), netType: slr.isPorted ? "pin" : slr.netType };
        if (slr.terminal != null) t.terminal = slr.terminal.slice();
        out.push(t);
      }

  // --- DRC ---
  const regions = terminals.filter((t) => t.layer === "Boundary").map((t) => t.rect);
  const inRegion = (r) => regions.some((g) => g[0] <= r[0] && r[2] <= g[2] && g[1] <= r[1] && r[3] <= g[3]);
  for (const [layer, vv] of store) {
    if (!(layer.startsWith("V") || layer.startsWith("M")) || !pdk.has(layer)) continue;
    const info = pdk.get(layer);
    if (layers.get(layer) === "*") {
      // _check_via_rules
      const spaceY = info.SpaceY ?? null;
      if (spaceY != null)
        for (const sl of vv.values())
          for (let i = 0; i + 1 < sl.rects.length; i++) {
            const a = sl.rects[i], b = sl.rects[i + 1];
            if (a.rect[3] < b.rect[1] && a.rect[3] + spaceY > b.rect[1])
              drc.push(`Vertical space violation on ${layer}: ${a.repr()} ${b.repr()} ${spaceY}`);
          }
      const spaceX = info.SpaceX ?? null;
      if (spaceX != null) {
        const bins = new Map();
        for (const sl of vv.values())
          for (const slr of sl.rects) {
            const cy = slr.rect[1] + slr.rect[3];
            if (!bins.has(cy)) bins.set(cy, []);
            bins.get(cy).push(slr.rect);
          }
        for (const rs of bins.values()) {
          rs.sort((p, q) => p[0] - q[0]);
          for (let i = 0; i + 1 < rs.length; i++)
            if (rs[i][2] < rs[i + 1][0] && rs[i][2] + spaceX > rs[i + 1][0])
              drc.push(`Horizontal space violation on ${layer}: ${pyList(rs[i])} ${pyList(rs[i + 1])} ${spaceX}`);
        }
      }
      // _check_via_enclosure_rules
      const [lyL, lyU] = info.Stack;
      const dirOf = (ly) => pdk.get(ly).Direction.toUpperCase();
      const covering = (r, ly, dir) => {
        const cx2 = r.rect[0] + r.rect[2], cy2 = r.rect[1] + r.rect[3];
        const [c2a, c2p, o2] = dir === "H" ? [cx2, cy2, 0] : [cy2, cx2, 1];
        const sl = store.get(ly)?.get(c2p);
        if (!sl) return null;
        const v = floorDiv(c2a, 2);
        const bs = (l, u) => {
          if (l === u) return null;
          if (l + 1 === u) return sl.rects[l].rect[o2] <= v && v <= sl.rects[l].rect[o2 + 2] ? sl.rects[l].rect : null;
          const m = floorDiv(l + u + 1, 2);
          return sl.rects[m].rect[o2] <= v ? bs(m, u) : bs(l, m);
        };
        return bs(0, sl.rects.length);
      };
      const single = (r, ly, dir, enc) => {
        const o2 = dir === "V" ? 1 : 0;
        const m = covering(r, ly, dir);
        const net = r.netName ?? "None";
        if (m == null)
          drc.push(`Enclosure violation on ${ly}-${layer} for ${net}: No metal found surrounding ${pyList(r.rect)}, ${enc}`);
        else if (m[o2] > r.rect[o2] - enc || m[o2 + 2] < r.rect[o2 + 2] + enc)
          drc.push(`Enclosure violation on ${ly}-${layer} for ${net}: ${pyList(m)} does not sufficiently surround ${pyList(r.rect)}, ${enc}`);
      };
      for (const sl of vv.values())
        for (const r of sl.rects) {
          if (lyL != null) single(r, lyL, dirOf(lyL), info.VencA_L);
          if (lyU != null) single(r, lyU, dirOf(lyU), info.VencA_H);
        }
    } else {
      // _check_metal_rules
      for (const sl of vv.values()) {
        const [s, e] = [sl.dIndex, sl.dIndex + 2];
        for (const slr of sl.rects)
          if (slr.rect[e] - slr.rect[s] < info.MinL && !inRegion(slr.rect))
            drc.push(`MinLength violation on ${layer}: ${pyName(slr.root().netName)}${pyList(slr.rect)}`);
        let prev = null;
        for (const slr of sl.rects) {
          if (prev) {
            const gap = slr.rect[s] - prev.rect[e];
            if (0 < gap && gap < info.EndToEnd && !inRegion(slr.rect))
              drc.push(`MinSpace violation on ${layer}: ${pyName(prev.root().netName)}${pyList(prev.rect)} x ` +
                       `${pyName(slr.root().netName)}${pyList(slr.rect)}`);
          }
          prev = slr;
        }
      }
      // _check_adjacent_metals
      if (info.AdjacentAttacker != null) {
        const dist = info.AdjacentAttacker, o2 = info.Direction.toUpperCase() === "H" ? 0 : 1;
        for (const [cx0, v0] of vv)
          for (const cx1 of [cx0 - 2 * info.Pitch, cx0 + 2 * info.Pitch]) {
            const v1 = vv.get(cx1);
            if (!v1) continue;
            for (const a of v0.rects)
              for (const b of v1.rects) {
                const g = b.rect[o2] - a.rect[o2 + 2];
                if (0 < g && g <= dist)
                  drc.push(`Adjacent metal attacker ${layer}: ${pyList(a.rect)} too close to ${pyList(b.rect)} dist: ${dist}`);
              }
          }
      }
    }
  }

  // --- 후처리 (최상위) ---
  const post = [];
  if (o.postprocess) {
    const next = [];
    for (const term of out) {
      const pp = rules.post.get(term.layer);
      if (!pp) { next.push(term); continue; }
      if (pp.kind === "color") {
        const info = pp.info, colors = info.Color;
        const c2 = info.Direction.toUpperCase() === "H" ? term.rect[1] + term.rect[3] : term.rect[0] + term.rect[2];
        const q = floorDiv(c2, 2 * info.Pitch), r = c2 - q * 2 * info.Pitch;
        if (r === 0) next.push(term, { ...term, rect: term.rect.slice(), color: colors[pyMod(q, colors.length)] });
        else {
          post.push(`Wire to color is offgrid: ${termRepr(term)} ${c2} ${q} ${r} pitch ${info.Pitch}`);
          next.push(term);
        }
      } else {
        const { WidthX, WidthY, SpaceX, SpaceY, NumX, NumY } = pp.cut, rect = term.rect;
        const xs = floorDiv(rect[0] + rect[2], 2) - floorDiv(WidthX * NumX + SpaceX * (NumX - 1), 2);
        const ys = floorDiv(rect[1] + rect[3], 2) - floorDiv(WidthY * NumY + SpaceY * (NumY - 1), 2);
        for (let i = 0; i < NumX; i++)
          for (let j = 0; j < NumY; j++)
            next.push({ ...term, rect: [xs + i * (WidthX + SpaceX), ys + j * (WidthY + SpaceY),
                                        xs + i * (WidthX + SpaceX) + WidthX, ys + j * (WidthY + SpaceY) + WidthY] });
      }
    }
    out = next;
  }

  return { shorts, opens, differentWidths, drc, post, warnings, terminals: out };
}

function termRepr(t) {
  const parts = [`'layer': ${pyStr(t.layer)}`, `'netName': ${pyStr(t.netName)}`, `'rect': ${pyList(t.rect)}`,
                 `'netType': ${pyStr(t.netType)}`];
  if (t.terminal) parts.push(`'terminal': ${pyTuple(t.terminal.map(pyStr))}`);
  return "{" + parts.join(", ") + "}";
}

/** ALIGN 의 <모듈>.errors 파일과 같은 줄들 (SHORT, OPEN, DIFFERENT WIDTH, DRC ERROR, POSTPROCESSOR ERROR). */
export function errorLines(res, extraDrc = []) {
  const lines = [];
  for (const s of res.shorts)
    lines.push(s.kind === "connectpair" ? `SHORT ${s.text}`
      : `SHORT (${"{" + s.names.map(pyStr).join(", ") + "}"}, ${pyStr(s.where)})`);
  for (const op of res.opens)
    lines.push(op.kind === "terminal" ? `OPEN ${pyTuple(op.terminal.map(pyStr))}`
      : `OPEN (${pyStr(op.net)}, [${op.parts.map((p) => "[" + p.map(([l, r]) => pyTuple([pyStr(l), pyList(r)])).join(", ") + "]").join(", ")}])`);
  for (const w of res.differentWidths)
    lines.push(`DIFFERENT WIDTH (${pyStr(w.msg)}, (${pyList(w.indices)}, [` +
      w.v.map(([r, n, t, p]) => pyTuple([pyList(r), pyStr(n), pyStr(t), pyBool(p)])).join(", ") + "]))");
  for (const e of [...res.drc, ...extraDrc]) lines.push(`DRC ERROR ${e}`);
  for (const e of res.post) lines.push(`POSTPROCESSOR ERROR ${e}`);
  return lines;
}
