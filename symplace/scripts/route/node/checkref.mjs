/** ALIGN 의 파이썬 DRC/LVS 검사기(cell_fabric)를 기준값으로 뽑는다 — JS 검사기(src/route/check.mjs) 대조용.
 *
 *    node checkref.mjs capture <예제> [--place=파일]
 *        ALIGN 배선 경로(pyroute.py — 예전 페이지 경로)로 배선하면서, 모듈마다 검사기의
 *        입력(도형 전체)과 출력(SHORT·OPEN·DIFFERENT WIDTH·DRC·후처리 오류, 정리된 도형)과
 *        블록 변환을 기록한다 -> ~/.cache/symplace/check/<예제>.json
 *
 *    node checkref.mjs check <사례.json> <출력.json>
 *        고정 사례(test/checkcases.mjs 꼴, mutate.mjs 가 만든다)를 펴서 파이썬 검사기에
 *        넣고, 답(results)을 채운 사례 파일을 쓴다. 입력과 출력이 같은 파일이어도 된다.
 *
 *    node checkref.mjs gds <사례.json> <출력.json> [--label=그대로]
 *        그 사례를 파이썬 검사기로 정리하고 ALIGN 의 GDS 경로(gen_gds_json.translate + json2gds)
 *        로 쓴 바이트의 sha256 을 적는다 — JS GDS(src/route/gds.mjs) 대조용 고정값.
 *        최상위(후처리 있음)면 _generate_json 처럼 Outline 을 맨 앞에 넣고 핀·라벨을 쓴다.
 *
 *    node checkref.mjs grid <출력.json>
 *        배선 도형의 격자 검사(gen_viewer_json 의 add_terminal) 문구를 여러 층·여러 자리에서
 *        뽑는다 — src/route/compose.mjs 의 offGrid 대조용 고정값.
 *
 *  검사기는 gen_viewer_json 이 만드는 것과 같은 캔버스다:
 *  get_generator('MOSGenerator', pdk)(Pdk().load(layers.json), 28, 12, 2, 3, 1, 1, 1).
 */
import fs from "node:fs";
import path from "node:path";
import { WORK_CACHE, bootAlign, runFront, workerPython } from "./align.mjs";
import { FIXTURE_FORMAT, expandCase, summarize } from "../../../web/placer/test/checkcases.mjs";

const args = process.argv.slice(2);
const mode = args[0];
const opt = (k) => (args.find((a) => a.startsWith(`--${k}=`)) ?? "").slice(k.length + 3) || null;

/** 파이썬 쪽 — 검사기를 부르고 결과를 JSON 으로 옮기는 부분. */
const PY = String.raw`
import copy, json, pathlib
import align.cell_fabric.canvas as _cv
from align.cell_fabric import pdk as _pdk
from align.compiler.util import get_generator

PDKDIR = pathlib.Path("/align/pdks/FinFET14nm_Mock_PDK")

def _slr(x):
    return [list(x.rect), x.netName, x.netType]

def _results(cnv, ndrc):
    rd = cnv.rd
    shorts = []
    for s in rd.shorts:
        if isinstance(s, str):
            shorts.append({"kind": "connectpair", "text": s})
        else:
            names, where, _ = s
            shorts.append({"kind": "terminal", "names": sorted(names, key=lambda n: (n is None, n or "")),
                           "where": where})
    opens = []
    for o in rd.opens:
        if isinstance(o, tuple) and len(o) == 2 and isinstance(o[1], list):
            opens.append({"kind": "net", "net": o[0],
                          "parts": [[[ly, list(r)] for (ly, r) in part] for part in o[1]]})
        else:
            opens.append({"kind": "terminal", "terminal": list(o)})
    widths = []
    for (msg, (indices, v)) in rd.different_widths:
        widths.append({"msg": msg, "indices": list(indices),
                       "v": [[list(r), n, t, bool(p)] for (r, n, t, p) in v]})
    drc = list(cnv.drc.errors) if cnv.drc else []
    return {"shorts": shorts, "opens": opens, "differentWidths": widths,
            "drc": getattr(rd, "lenient", []) + drc[:ndrc], "viewerErrors": drc[ndrc:],
            "post": list(cnv.postprocessor.errors)}

# --- 너그러운 검사기: 원본이 죽는 두 곳만 JS 처럼 오류로 적고 넘어간다 ---
#   remove_duplicates.check_shorts_induced_by_vias  비아 밑에 금속이 없으면 assert 로 죽는다
#   drc._find_rect_covering_via                     비아 자리의 금속 선이 아예 없으면 KeyError
# 원본이 죽은 사례에서만 쓴다 — 죽은 곳 말고 나머지(SHORT, OPEN, 정리된 도형...)를 대조하려고.
from align.cell_fabric import remove_duplicates as _rdm
from align.cell_fabric import drc as _drcm
_orig_vias = _rdm.RemoveDuplicates.check_shorts_induced_by_vias
_orig_cover = _drcm.DesignRuleCheck._find_rect_covering_via

def _touching_or_none(sl, via_rect):
    for m in sl.rects:
        if _rdm.RemoveDuplicates.touching(via_rect.rect, m.rect):
            return m
    return None

def _lenient_vias(self):
    self.lenient = []
    for (via, (mv, mh)) in self.canvas.layer_stack:
        if mv is None and mh is None:
            continue
        if via in self.store_scan_lines:
            for (twice_center, via_scan_line) in self.store_scan_lines[via].items():
                if mv is not None:
                    if twice_center not in self.store_scan_lines[mv]:
                        continue
                    msl = self.store_scan_lines[mv][twice_center]
                    for via_rect in via_scan_line.rects:
                        m = _touching_or_none(msl, via_rect)
                        if m is None:
                            self.lenient.append(f"No {mv} metal touching {via} {via_rect.rect}")
                            continue
                        self.connectPair(via, m.root(), via_rect.root())
                if mh is not None:
                    for via_rect in via_scan_line.rects:
                        tcy = via_rect.rect[1] + via_rect.rect[3]
                        if tcy not in self.store_scan_lines[mh]:
                            continue
                        m = _touching_or_none(self.store_scan_lines[mh][tcy], via_rect)
                        if m is None:
                            self.lenient.append(f"No {mh} metal touching {via} {via_rect.rect}")
                            continue
                        self.connectPair(via, via_rect.root(), m.root())

def _lenient_cover(self, r, ly, metal_dir):
    c2p = r.rect[1] + r.rect[3] if metal_dir == 'H' else r.rect[0] + r.rect[2]
    if c2p not in self.canvas.rd.store_scan_lines[ly]:
        return None
    return _orig_cover(self, r, ly, metal_dir)

def _lenient(on):
    _rdm.RemoveDuplicates.check_shorts_induced_by_vias = _lenient_vias if on else _orig_vias
    _drcm.DesignRuleCheck._find_rect_covering_via = _lenient_cover if on else _orig_cover

# --- 기록: gen_data 앞뒤를 가로챈다 ---
_orig_gen_data = _cv.Canvas.gen_data
def _gen_data(self, **kw):
    self._cap_in = copy.deepcopy(self.terminals)
    self._cap_bbox = None if self.bbox is None else list(self.bbox.toList())
    self._cap_kw = dict(kw)
    self._cap_subinsts = list(self.subinsts.keys())
    out = _orig_gen_data(self, **kw)
    self._cap_ndrc = len(self.drc.errors) if self.drc else 0
    self._cap_out = copy.deepcopy(out["terminals"])
    return out
_cv.Canvas.gen_data = _gen_data

CAPTURE = []
def install_capture():
    import align.pnr.main as pm
    from align.pnr.render_placement import gen_transformation
    orig = pm.gen_viewer_json
    def gvj(hN, **kw):
        cnv, d = orig(hN, **kw)
        blocks = []
        for cblk in hN.Blocks:
            blk = cblk.instance[cblk.selectedInstance]
            tr = gen_transformation(blk)
            blocks.append({"name": blk.name, "master": blk.master, "lefmaster": blk.lefmaster,
                           "gdsFile": blk.gdsFile, "orient": str(blk.orient),
                           "tr2x": [tr.oX, tr.oY, tr.sX, tr.sY]})
        na = cnv._cap_kw.get("nets_allowed_to_be_open")
        rec = {"module": hN.name, "isTop": bool(hN.isTop), "bbox": cnv._cap_bbox,
               "subinsts": cnv._cap_subinsts,
               "netsAllowedToBeOpen": sorted(na) if na else [],
               "postprocess": bool(cnv._cap_kw.get("postprocess")),
               "terminals": cnv._cap_in, "terminalsOut": cnv._cap_out, "blocks": blocks,
               "hN2x": [hN.LL.x, hN.LL.y, hN.UR.x, hN.UR.y]}
        rec.update(_results(cnv, cnv._cap_ndrc))
        CAPTURE.append(rec)
        return cnv, d
    pm.gen_viewer_json = gvj

def captured():
    return json.dumps(CAPTURE)

def _run_case(c):
    gen = get_generator('MOSGenerator', PDKDIR)
    cnv = gen(_pdk.Pdk().load(PDKDIR / 'layers.json'), 28, 12, 2, 3, 1, 1, 1)
    cnv.terminals = copy.deepcopy(c["terminals"])
    for s in c.get("subinsts", []):
        cnv.subinsts[s]
    cnv.gen_data(run_drc=True, run_pex=False,
                 nets_allowed_to_be_open=c.get("netsAllowedToBeOpen", []),
                 postprocess=c.get("postprocess", False))
    r = _results(cnv, cnv._cap_ndrc)
    r["terminalsOut"] = cnv._cap_out
    return r

def gds_digest(case_json, name, bbox_json, time_json):
    import datetime, hashlib, io
    from align.cell_fabric import gen_gds_json
    from align.gdsconv.json2gds import convert_GDSjson_GDS_fps
    c = json.loads(case_json)
    r = _run_case(c)
    top = bool(c.get("postprocess"))
    bbox = json.loads(bbox_json)
    terms = r["terminalsOut"]
    if top:
        terms.insert(0, {"layer": "Outline", "netName": None, "netType": "drawing", "rect": bbox})
    ifp = io.StringIO(json.dumps({"bbox": bbox, "terminals": terms}))
    ofp = io.StringIO()
    pdk = _pdk.Pdk().load(PDKDIR / 'layers.json')
    gen_gds_json.translate(name, '', top, ifp, ofp, timestamp=datetime.datetime(*json.loads(time_json)),
                           p=pdk, labelOnce=True, reqLabels=None)
    out = io.BytesIO()
    convert_GDSjson_GDS_fps(io.StringIO(ofp.getvalue()), out)
    b = out.getvalue()
    return json.dumps({"sha256": hashlib.sha256(b).hexdigest(), "bytes": len(b), "terminals": len(terms)})

def offgrid_msgs(terms_json):
    """gen_viewer_json 의 add_terminal 격자 검사 — 원문을 그대로 옮겨 PDK 단위 도형에 건다."""
    gen = get_generator('MOSGenerator', PDKDIR)
    cnv = gen(_pdk.Pdk().load(PDKDIR / 'layers.json'), 28, 12, 2, 3, 1, 1, 1)
    scale_factor = 1
    out = []
    for t in json.loads(terms_json):
        layer, netName, tag = t["layer"], t["netName"], t.get("tag")
        r = [2 * v for v in t["rect"]]
        errors = []
        def f(gen, value, tag=None):
            if value%2 != 0:
                errors.append(f"Off grid:{tag} {layer} {netName} {r} {r[2]-r[0]} {r[3]-r[1]}: {value} (in 2x units) is not divisible by two.")
            else:
                value = value * scale_factor // 2
                p = gen.clg.inverseBounds(value)
                if p[0] != p[1]:
                    errors.append(f"Off grid:{tag} {layer} {netName} {r} {r[2]-r[0]} {r[3]-r[1]}: {value} doesn't land on grid, lb and ub are: {p}")
        if layer in ["M1", "M3", "M5"]:
            center = (r[0] + r[2])//2
        elif layer in ["M2", "M4", "M6"]:
            center = (r[1] + r[3])//2
        else:
            center = None
        if center is not None:
            lyr = layer.lower() if layer.lower() in cnv.generators else layer.upper()
            f(cnv.generators[lyr], center, tag)
        out.append(errors)
    return json.dumps(out)

def check_cases(cases_json):
    out = []
    for c in json.loads(cases_json):
        try:
            r = _run_case(c)
        except Exception as e:
            crash = "%s: %s" % (type(e).__name__, str(e)[:300])
            _lenient(True)
            try:
                r = _run_case(c)
            except Exception:
                r = {}
            finally:
                _lenient(False)
            r["crash"] = crash
        out.append(r)
    return json.dumps(out)
`;

const t0 = performance.now();
const log = (...a) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1).padStart(5)}s]`, ...a);

if (mode === "capture") {
  const ex = args[1];
  if (!ex) { console.error("사용법: node checkref.mjs capture <예제> [--place=파일]"); process.exit(2); }
  const placeFile = opt("place") ?? path.join(WORK_CACHE, `place-${ex}.json`);
  if (!fs.existsSync(placeFile)) { console.error(`배치가 없다: ${placeFile} (node place.mjs ${ex})`); process.exit(2); }
  const { py } = await bootAlign({ log });
  const { top } = runFront(py, ex);
  py.runPython(PY);
  py.runPython("install_capture()");
  py.setStdout({ batched: () => {} });
  py.setStderr({ batched: () => {} });
  py.runPython(workerPython("PYROUTE"));
  const r = JSON.parse(py.globals.get("route")("/work/" + ex, ex, top, fs.readFileSync(placeFile, "utf8")));
  if (!r.ok) { console.error(r.error); process.exit(3); }
  const cap = JSON.parse(py.runPython("captured()"));
  const dir = path.join(WORK_CACHE, "check");
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, ex + ".json");
  fs.writeFileSync(out, JSON.stringify({ example: ex, top, placement: JSON.parse(fs.readFileSync(placeFile, "utf8")), cases: cap }));
  for (const c of cap)
    log(`${c.module.padEnd(28)} ${c.isTop ? "최상위" : "하위  "} 도형 ${c.terminals.length} -> ${c.terminalsOut.length}` +
        `  SHORT ${c.shorts.length} OPEN ${c.opens.length} WIDTH ${c.differentWidths.length}` +
        ` DRC ${c.drc.length} 격자 ${c.viewerErrors.length} 후처리 ${c.post.length}`);
  log("->", out);
} else if (mode === "check") {
  const [inp, outp] = args.slice(1);
  if (!inp || !outp) { console.error("사용법: node checkref.mjs check <사례.json> <출력.json>"); process.exit(2); }
  const fx = JSON.parse(fs.readFileSync(inp, "utf8"));
  if (fx.format !== FIXTURE_FORMAT) { console.error(`${inp}: ${FIXTURE_FORMAT} 꼴이 아니다`); process.exit(2); }
  const { py } = await bootAlign({ log });
  py.runPython(PY);
  py.setStdout({ batched: () => {} });
  py.setStderr({ batched: () => {} });
  const inputs = fx.cases.map((c) => expandCase(fx.base, c));
  const res = JSON.parse(py.globals.get("check_cases")(JSON.stringify(inputs)));
  fx.results = res.map(summarize);
  fs.writeFileSync(outp, JSON.stringify(fx));
  const crashed = res.filter((r) => r.crash).length;
  log(`${res.length} 건 (파이썬이 죽은 것 ${crashed}) -> ${outp}`);
} else if (mode === "gds") {
  const [inp, outp] = args.slice(1).filter((a) => !a.startsWith("--"));
  if (!inp || !outp) { console.error("사용법: node checkref.mjs gds <사례.json> <출력.json> [--label=그대로]"); process.exit(2); }
  const fx = JSON.parse(fs.readFileSync(inp, "utf8"));
  const label = opt("label") ?? "그대로";
  const c = fx.cases.find((k) => k.label === label);
  if (!c) { console.error(`${inp}: "${label}" 사례가 없다`); process.exit(2); }
  const [ex, module] = fx.source.split(" ");
  const cap = JSON.parse(fs.readFileSync(path.join(WORK_CACHE, "check", ex + ".json"), "utf8"));
  const rec = cap.cases.find((k) => k.module === module);
  const time = [2026, 1, 2, 3, 4, 5];
  const { py } = await bootAlign({ log });
  py.runPython(PY);
  py.setStdout({ batched: () => {} });
  py.setStderr({ batched: () => {} });
  const input = expandCase(fx.base, c);
  const r = JSON.parse(py.globals.get("gds_digest")(JSON.stringify(input), module, JSON.stringify(rec.bbox), JSON.stringify(time)));
  const out = { format: "gds-fixture/1", check: path.basename(inp), label, name: module, bbox: rec.bbox,
                pinSwitch: !!input.postprocess, time, ...r };
  fs.writeFileSync(outp, JSON.stringify(out, null, 1) + "\n");
  log(`${module} GDS ${r.bytes} 바이트 sha256 ${r.sha256.slice(0, 16)}… -> ${outp}`);
} else if (mode === "grid") {
  const outp = args[1];
  if (!outp) { console.error("사용법: node checkref.mjs grid <출력.json>"); process.exit(2); }
  const cases = [];
  const W = { M1: 32, M2: 32, M3: 40, M4: 40, M5: 64, M6: 64 }, P = { M1: 80, M2: 84, M3: 80, M4: 84, M5: 144, M6: 144 };
  for (const ly of Object.keys(W)) {
    const v = ly === "M1" || ly === "M3" || ly === "M5";
    for (const c of [0, P[ly], 3 * P[ly], -P[ly], -2 * P[ly]]) {
      for (const d of [0, 1, 7, P[ly] / 2, P[ly] - 3, -5]) {
        const lo = c + d - W[ly] / 2, hi = c + d + W[ly] / 2 + (d === 7 ? 1 : 0);   // d == 7 이면 폭이 홀수 -> 2 배 중심이 홀수
        cases.push({ layer: ly, netName: d === 1 ? null : "N" + cases.length, tag: d === 0 ? null : "path_metal",
                     rect: v ? [lo, 100, hi, 400] : [100, lo, 400, hi] });
      }
    }
  }
  cases.push({ layer: "V1", netName: "X", rect: [3, 5, 35, 37] }, { layer: "M7", netName: "X", rect: [3, 5, 35, 37] });
  const { py } = await bootAlign({ log });
  py.runPython(PY);
  const res = JSON.parse(py.globals.get("offgrid_msgs")(JSON.stringify(cases)));
  fs.writeFileSync(outp, JSON.stringify({ format: "grid-fixture/1", cases, results: res }) + "\n");
  log(`${cases.length} 도형, 격자 오류 ${res.flat().length} -> ${outp}`);
} else {
  console.error("사용법: node checkref.mjs capture <예제> | check <입력.json> <출력.json> | gds <사례.json> <출력.json> | grid <출력.json>");
  process.exit(2);
}
