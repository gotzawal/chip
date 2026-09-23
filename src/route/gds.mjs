/** GDS 쓰기 — ALIGN 의 파이썬 GDS 경로의 JS 판.
 *
 *    gdsJson    cell_fabric/gen_gds_json.translate_data (via_gen_tbl 없이 — ALIGN 도 {} 로 부른다)
 *    gdsBytes   gdsconv/json2gds.convert_GDSjson_GDS_fps + python-gdsii 의 레코드 쓰기
 *
 *  ALIGN 은 모듈마다 <이름>_0.python.gds.json 을 쓰고 최상위만 .python.gds 로 바꾼다.
 *  같은 도형·같은 시각이면 바이트까지 같다 (symplace/web/placer/test/gds.mjs).
 *
 *  최상위(pinSwitch)면 핀 도형을 Pin 데이터형으로 쓰고 넷마다 라벨을 한 번 단다.
 *  색이 있는 도형(M1~M3 의 색 사본)은 그 색의 데이터형으로 한 번 더 쓴다.
 */

const flatRectToBoundary = (r) => [r[0], r[1], r[0], r[3], r[2], r[3], r[2], r[1], r[0], r[1]];

/** [년, 월, 일, 시, 분, 초] — 주지 않으면 지금 (파이썬 datetime.now() 처럼 지역 시각). */
function stamp(time) {
  if (Array.isArray(time)) return time.slice(0, 6);
  const d = time instanceof Date ? time : new Date();
  return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()];
}

/**
 * @param {object} o
 * @param {string} o.name        구조 이름 (ALIGN 은 모듈 이름)
 * @param {Array} o.terminals    검사기가 낸 도형 (최상위면 맨 앞에 Outline 을 넣은 것)
 * @param {number[]} o.bbox
 * @param {boolean} o.pinSwitch  최상위면 true
 * @param {object} pdk           MOCK_PDK (layers.json)
 * @param {boolean} [o.labelOnce=true]
 * @param {string[]|null} [o.reqLabels=null]  라벨을 달 넷 (null 이면 전부 — ALIGN 은 늘 null 로 부른다)
 * @param {number[]|Date} [o.time]
 */
export function gdsJson({ name, terminals, bbox, pinSwitch, labelOnce = true, reqLabels = null, time }, pdk) {
  const L = new Map(pdk.Abstraction.map((x) => [x.Layer, x]));
  const layer = (k) => {
    const x = L.get(k);
    if (!x) throw new Error(`GDS: PDK 에 없는 층 ${k}`);
    return x;
  };
  const t6 = stamp(time), tme = [...t6, ...t6];
  const units = (1 / pdk.ScaleFactor) * 1e-9;
  const strct = { time: tme, strname: name, elements: [] };
  const top = { header: 600, bgnlib: [{ time: tme, libname: "pcell", units: [units, units], bgnstr: [strct] }] };
  const el = strct.elements;
  const v0 = layer("V0"), ring = L.get("GuardRing");
  const labels = new Set();
  for (const obj of terminals) {
    const k = obj.layer, info = layer(k), r = obj.rect;
    if (k === "V0" && r[2] - r[0] > 10 * v0.WidthX) {
      for (let n = 0; n < ring.viaArray; n++) {
        const x0 = r[0] + n * (ring.v0WidthX + ring.v0SpaceX);
        el.push({ type: "boundary", layer: info.GdsLayerNo, datatype: info.GdsDatatype.Draw,
                  xy: flatRectToBoundary([x0, r[1], x0 + ring.v0WidthX, r[3]]) });
      }
    } else if (pinSwitch && obj.netType === "pin") {
      el.push({ type: "boundary", layer: info.GdsLayerNo, datatype: info.GdsDatatype.Pin, xy: flatRectToBoundary(r) });
      if ("Label" in info.GdsDatatype && (reqLabels == null || reqLabels.includes(obj.netName)) &&
          (!labelOnce || !labels.has(obj.netName))) {
        el.push({ layer: info.GdsLayerNo, type: "text", texttype: info.GdsDatatype.Label, string: obj.netName,
                  xy: [Math.trunc((r[0] + r[2]) / 2), Math.trunc((r[1] + r[3]) / 2)] });
        labels.add(obj.netName);
      }
    } else {
      el.push({ type: "boundary", layer: info.GdsLayerNo, datatype: info.GdsDatatype.Draw, xy: flatRectToBoundary(r) });
    }
    if ("color" in obj)
      el.push({ type: "boundary", layer: info.GdsLayerNo, datatype: info.GdsDatatype[obj.color], xy: flatRectToBoundary(r) });
  }
  const bb = layer("Bbox");
  el.push({ type: "boundary", layer: bb.GdsLayerNo, datatype: bb.GdsDatatype.Draw, xy: flatRectToBoundary(bbox) });
  return top;
}

// ---------------------------------------------------------------- 레코드
const TAG = {
  HEADER: 0x0002, BGNLIB: 0x0102, LIBNAME: 0x0206, UNITS: 0x0305, ENDLIB: 0x0400, BGNSTR: 0x0502,
  STRNAME: 0x0606, ENDSTR: 0x0700, BOUNDARY: 0x0800, PATH: 0x0900, SREF: 0x0A00, TEXT: 0x0C00,
  LAYER: 0x0D02, DATATYPE: 0x0E02, WIDTH: 0x0F03, XY: 0x1003, ENDEL: 0x1100, SNAME: 0x1206,
  TEXTTYPE: 0x1602, PRESENTATION: 0x1701, STRING: 0x1906, STRANS: 0x1A01, MAG: 0x1B05, ANGLE: 0x1C05,
  PATHTYPE: 0x2102, PROPATTR: 0x2B02, PROPVALUE: 0x2C06, BGNEXTN: 0x3003, ENDEXTN: 0x3103,
};

/** python-gdsii _real_to_int: IEEE double -> GDSII REAL8 (16 진 지수, 64 치우침). */
function real8(f) {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, f);
  const ieee = dv.getBigUint64(0);
  const sign = ieee & 0x8000000000000000n;
  const ieeeExp = Number((ieee >> 52n) & 0x7ffn);
  if (ieeeExp === 0) return 0n;
  const full = ((ieee & 0xfffffffffffffn) + 0x10000000000000n) << 3n;
  const e = ieeeExp - 1023 + 1;
  let exp16 = Math.floor(e / 4), rest = e - 4 * exp16;
  if (rest) { rest = 4 - rest; exp16 += 1; }
  const biased = exp16 + 64;
  if (biased < 0 || biased > 0x7f) throw new Error(`GDS: REAL8 로 못 쓰는 수 ${f}`);
  return sign | (BigInt(biased) << 56n) | (full >> BigInt(rest));
}

class Writer {
  constructor() { this.buf = new Uint8Array(1 << 16); this.n = 0; }
  grow(k) {
    if (this.n + k <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.n + k) size *= 2;
    const b = new Uint8Array(size); b.set(this.buf.subarray(0, this.n)); this.buf = b;
  }
  rec(tag, data) {
    const type = tag & 0xff;
    let body;
    if (type === 0) body = new Uint8Array(0);
    else if (type === 6) {                                  // ASCII, 홀수면 NUL 로 채운다
      const s = new TextEncoder().encode(data);
      body = new Uint8Array(s.length + (s.length % 2)); body.set(s);
    } else {
      const size = type === 1 || type === 2 ? 2 : type === 3 ? 4 : 8;
      body = new Uint8Array(data.length * size);
      const dv = new DataView(body.buffer);
      data.forEach((v, i) => {
        if (type === 1) dv.setUint16(2 * i, v);
        else if (type === 2) dv.setInt16(2 * i, v);
        else if (type === 3) dv.setInt32(4 * i, v);
        else dv.setBigUint64(8 * i, real8(v));
      });
    }
    const len = body.length + 4;
    if (len > 0xffff) throw new Error("GDS: 레코드가 너무 크다");
    this.grow(len);
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.n, 4);
    dv.setUint16(0, len); dv.setUint16(2, tag);
    this.buf.set(body, this.n + 4);
    this.n += len;
  }
  bytes() { return this.buf.slice(0, this.n); }
}

/** GDS JSON (gdsJson 의 출력) -> GDSII 바이트. json2gds 가 쓰는 순서 그대로. */
export function gdsBytes(j) {
  const w = new Writer();
  w.rec(TAG.HEADER, [j.header]);
  for (const lib of j.bgnlib) {
    w.rec(TAG.BGNLIB, lib.time);
    w.rec(TAG.LIBNAME, lib.libname);
    w.rec(TAG.UNITS, lib.units);
    for (const cell of lib.bgnstr) {
      w.rec(TAG.BGNSTR, cell.time);
      w.rec(TAG.STRNAME, cell.strname);
      for (const e of cell.elements ?? []) {
        const put = (k, tag) => { if (k in e) w.rec(tag, Array.isArray(e[k]) ? e[k] : typeof e[k] === "string" ? e[k] : [e[k]]); };
        if (e.type === "boundary") {
          w.rec(TAG.BOUNDARY);
          put("layer", TAG.LAYER); put("datatype", TAG.DATATYPE); put("xy", TAG.XY);
          put("propattr", TAG.PROPATTR); put("propvalue", TAG.PROPVALUE);
        } else if (e.type === "path") {
          w.rec(TAG.PATH);
          put("layer", TAG.LAYER); put("datatype", TAG.DATATYPE); put("pathtype", TAG.PATHTYPE);
          put("width", TAG.WIDTH); put("bgnextn", TAG.BGNEXTN); put("endextn", TAG.ENDEXTN); put("xy", TAG.XY);
        } else if (e.type === "text") {
          w.rec(TAG.TEXT);
          put("layer", TAG.LAYER); put("texttype", TAG.TEXTTYPE); put("presentation", TAG.PRESENTATION);
          put("strans", TAG.STRANS); put("mag", TAG.MAG); put("angle", TAG.ANGLE); put("xy", TAG.XY);
          put("string", TAG.STRING);
        } else if (e.type === "sref") {
          w.rec(TAG.SREF);
          put("sname", TAG.SNAME); put("strans", TAG.STRANS); put("angle", TAG.ANGLE); put("xy", TAG.XY);
        }
        w.rec(TAG.ENDEL);
      }
      w.rec(TAG.ENDSTR);
    }
    w.rec(TAG.ENDLIB);
  }
  return w.bytes();
}

/** 최상위 한 모듈을 GDS 로 — _generate_json 이 하는 것처럼 Outline 을 맨 앞에 넣는다. */
export function topGds({ name, terminals, bbox, time }, pdk) {
  const withOutline = [{ layer: "Outline", netName: null, netType: "drawing", rect: bbox.slice() }, ...terminals];
  return gdsBytes(gdsJson({ name, terminals: withOutline, bbox, pinSwitch: true, time }, pdk));
}
