/** PDK(layers.json) -> PnRDB::Drc_info — PnRdatabase::ReadPDKJSON (PnRDB/ReadDesignRuleJson.cpp) 를 그대로.
 *
 *  FinFET_MOCK_PDK 가 정의된 빌드다 (GdsLayerNo, UnitC.Mean ...). 모양은 pybind 로 뜬 덤프
 *  (~/.cache/symplace/tap/<예제>/<배치>/drc.json) 와 같다 = 배선 일감의 drc (alignroute/src/db.rs DrcInfo).
 *
 *    단위       PnRDB 단위 = layers.json 단위 x 2 / ScaleFactor (times = 2, C++ 정수 나눗셈 = 0 쪽 버림)
 *    금속 순서  파일 순서 (metalSet 의 열쇠 2, 4, 6 ...)
 *    비아 순서  아래 금속이 있는 비아(viaSet) 먼저, 없는 비아(viaSet_vt, V0) 나중 — 그래서 V0 = 14 번
 *    maxL       C++ 에서 초기화하지 않는다 (쓰는 곳도 없다). 여기서는 0.
 *    Guardring_info  pybind 는 path 만 내보낸다. 구조체 그대로 둔다 (xspace, yspace 도 채운다).
 */

const cdiv = (a, b) => Math.trunc(a / b);
const first = (v) => (Array.isArray(v) ? v[0] : v);
const gds = (o = {}) => ({ Blockage: o.Blockage ?? 0, Draw: o.Draw ?? 0, Label: o.Label ?? 0, Pin: o.Pin ?? 0 });

/** std::map::operator[] — 없으면 0 을 넣고 돌려준다 */
function mapAt(m, k) {
  if (!(k in m)) m[k] = 0;
  return m[k];
}

/** 이름순 열쇠의 새 객체 (std::map 을 pybind 가 dict 로 내보낸 순서) */
const sortedObj = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));

export function readPdkJson(pdk) {
  const times = 2;
  const SF = pdk.ScaleFactor;
  const layers = pdk.Abstraction;

  // 1. 금속
  const Metal_info = [];
  for (const L of layers) {
    if (L.Layer[0] !== "M") continue;
    const pitch = first(L.Pitch), width = first(L.Width);
    const m = {
      name: L.Layer,
      layerNo: L.GdsLayerNo,
      gds_datatype: gds({ Draw: L.GdsDatatype.Draw, Pin: L.GdsDatatype.Pin, Label: L.GdsDatatype.Label, Blockage: L.GdsDatatype.Blockage }),
      direct: 0, grid_unit_x: -1, grid_unit_y: -1,
      width: cdiv(times * width, SF),
      dist_ss: cdiv(times * (pitch - width), SF),
      minL: cdiv(times * L.MinL, SF),
      maxL: 0,
      dist_ee: cdiv(times * L.EndToEnd, SF),
      offset: cdiv(times * L.Offset, SF),
      // rc_scale = 0.0005 (double 곱 — JS 와 같은 비트)
      unit_R: (typeof L.UnitR?.Mean === "number" ? L.UnitR.Mean : 0) * 0.0005,
      unit_C: (typeof L.UnitC?.Mean === "number" ? L.UnitC.Mean : 0) * 0.0005,
      unit_CC: (typeof L.UnitCC?.Mean === "number" ? L.UnitCC.Mean : 0) * 0.0005,
      lower_via_index: -1,
      upper_via_index: -1,
    };
    if (L.Direction === "V") { m.direct = 0; m.grid_unit_x = cdiv(times * pitch, SF); m.grid_unit_y = -1; }
    else if (L.Direction === "H") { m.direct = 1; m.grid_unit_y = cdiv(times * pitch, SF); m.grid_unit_x = -1; }
    Metal_info.push(m);
  }
  const Metalmap = {};
  Metal_info.forEach((m, i) => { Metalmap[m.name] = i; });
  const MaxLayer = Metal_info.length - 1;

  const top_boundary = { name: "Boundary", layerNo: 0, gds_datatype: gds() };
  for (const L of layers) {
    if (L.Layer === "Outline") { top_boundary.layerNo = L.GdsLayerNo; top_boundary.gds_datatype = gds({ Draw: L.GdsDatatype.Draw }); }
  }

  // 2. 비아: viaSet (아래 금속 있음) 다음 viaSet_vt
  const viaSet = [], viaSetVt = [];
  for (const L of layers) {
    if (L.Layer[0] !== "V") continue;
    const idx = L.Stack.map((s) => (typeof s === "string" ? mapAt(Metalmap, s) : -1));
    const v = {
      name: L.Layer,
      layerNo: L.GdsLayerNo,
      gds_datatype: gds({ Draw: L.GdsDatatype.Draw }),
      lower_metal_index: idx[0],
      upper_metal_index: idx[1],
      width: cdiv(times * L.WidthX, SF),
      width_y: cdiv(times * L.WidthY, SF),
      cover_l: cdiv(times * L.VencA_L, SF),
      cover_l_P: cdiv(times * L.VencP_L, SF),
      cover_u: cdiv(times * L.VencA_H, SF),
      cover_u_P: cdiv(times * L.VencP_H, SF),
      dist_ss: cdiv(times * L.SpaceX, SF),
      dist_ss_y: cdiv(times * L.SpaceY, SF),
      R: typeof L.R?.Mean === "number" ? L.R.Mean : 0,
    };
    (idx[0] !== -1 ? viaSet : viaSetVt).push(v);
  }
  const Via_info = [], Viamap = {};
  for (const v of [...viaSet, ...viaSetVt]) {
    Via_info.push(v);
    const i = Via_info.length - 1;
    Viamap[v.name] = i;
    if (v.lower_metal_index !== -1) Metal_info[v.lower_metal_index].upper_via_index = i;
    if (v.upper_metal_index !== -1) Metal_info[v.upper_metal_index].lower_via_index = i;
  }

  const Guardring_info = { name: "", xspace: 0, yspace: 0, gds_datatype: gds(), path: "" };
  for (const L of layers) {
    if (L.Layer === "GuardRing") {
      Guardring_info.xspace = cdiv(L.XSpace * times, SF);
      Guardring_info.yspace = cdiv(L.YSpace * times, SF);
    }
  }

  // 3. 금속 무게, 4. 비아 모델
  const metal_weight = Metal_info.map(() => 1);
  const Via_model = Via_info.map((vi, i) => {
    const vm = {
      name: vi.name, ViaIdx: i, LowerIdx: vi.lower_metal_index, UpperIdx: vi.upper_metal_index,
      ViaRect: [{ x: 0 - cdiv(vi.width, 2), y: 0 - cdiv(vi.width_y, 2) }, { x: 0 + cdiv(vi.width, 2), y: 0 + cdiv(vi.width_y, 2) }],
      LowerRect: [], UpperRect: [], R: vi.R,
    };
    const rect = (midx, cov, covP) => {
      const mi = Metal_info[midx];
      const w = mi.width;
      if (mi.direct === 0) {   // 세로 금속
        return [{ x: Math.min(0 - cdiv(vi.width, 2) - covP, -cdiv(w, 2)), y: 0 - cdiv(vi.width_y, 2) - cov },
                { x: Math.max(0 + cdiv(vi.width, 2) + covP, cdiv(w, 2)), y: 0 + cdiv(vi.width_y, 2) + cov }];
      }
      return [{ x: 0 - cdiv(vi.width, 2) - cov, y: Math.min(0 - cdiv(vi.width_y, 2) - covP, -cdiv(w, 2)) },
              { x: 0 + cdiv(vi.width, 2) + cov, y: Math.max(0 + cdiv(vi.width_y, 2) + covP, cdiv(w, 2)) }];
    };
    if (vm.LowerIdx >= 0) vm.LowerRect = rect(vm.LowerIdx, vi.cover_l, vi.cover_l_P);
    if (vm.UpperIdx >= 0) vm.UpperRect = rect(vm.UpperIdx, vi.cover_u, vi.cover_u_P);
    return vm;
  });

  // 6. 마스크 번호
  const MaskID_Metal = Metal_info.map((m) => String(m.layerNo));
  const MaskID_Via = Via_info.map((v) => String(v.layerNo));

  // 7. design info (C++ 에서 초기화 안 된 칸은 0)
  const DI = { Hspace: 0, Vspace: 0, compact_style: "left", h_skip_factor: 0, power_grid_metal_l: 0, power_grid_metal_u: 0,
               power_routing_metal_l: 0, power_routing_metal_u: 0, signal_routing_metal_l: 0, signal_routing_metal_u: 0, v_skip_factor: 0 };
  for (const k of [0, 1]) {
    if (Metal_info[k].direct === 1) DI.Vspace = Metal_info[k].grid_unit_y;
    else DI.Hspace = Metal_info[k].grid_unit_x;
  }
  const d = pdk.design_info;
  if (d) {
    DI.Hspace = cdiv(d.Hspace * times, SF);
    DI.Vspace = cdiv(d.Vspace * times, SF);
    DI.signal_routing_metal_l = mapAt(Metalmap, d.bottom_signal_routing_layer);
    DI.signal_routing_metal_u = mapAt(Metalmap, d.top_signal_routing_layer);
    DI.power_routing_metal_l = mapAt(Metalmap, d.bottom_power_routing_layer);
    DI.power_routing_metal_u = mapAt(Metalmap, d.top_power_routing_layer);
    DI.h_skip_factor = "h_skip_factor" in d ? d.h_skip_factor : 7;
    DI.v_skip_factor = "v_skip_factor" in d ? d.v_skip_factor : 8;
    if ("compact_placement" in d) DI.compact_style = d.compact_placement;
    DI.power_grid_metal_l = mapAt(Metalmap, d.top_power_routing_layer) - 1;
    DI.power_grid_metal_u = mapAt(Metalmap, d.top_power_routing_layer);
    if ("bottom_power_grid_layer" in d) DI.power_grid_metal_l = mapAt(Metalmap, d.bottom_power_grid_layer);
    if ("top_power_grid_layer" in d) DI.power_grid_metal_u = mapAt(Metalmap, d.top_power_grid_layer);
  }

  return {
    Design_info: DI, Guardring_info, MaskID_Metal, MaskID_Via, MaxLayer, Metal_info,
    Metalmap: sortedObj(Metalmap), Via_info, Via_model, Viamap: sortedObj(Viamap), metal_weight, top_boundary,
    ScaleFactor: SF,
  };
}
