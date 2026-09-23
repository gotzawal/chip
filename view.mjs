/** 캔버스 보기 — 확대/이동, 패널, 배선 레이어.
 *
 *  좌표계가 둘이다.
 *    레이아웃 좌표 : 템플릿 단위 (telescopic_ota 는 1440 x 11760)
 *    화면 좌표     : 픽셀
 *  fitOf() 가 레이아웃을 패널에 꽉 채우는 배율을 잡고, view {s, tx, ty} 가 그 위에
 *  사용자의 확대/이동을 얹는다. 나란히 보기에서는 두 패널이 **같은 배율**을
 *  써야 한다 — 안 그러면 크기 비교가 안 된다. 그래서 그릴 때 맞출 상자를
 *  opt.box 로 따로 받는다: 두 패널에 같은 상자(둘의 합집합)를 주면 배율이 같아지고,
 *  각자의 bbox 는 테두리로만 그려진다.
 */

export function makeView() {
  return { s: 1, tx: 0, ty: 0 };
}

/** 레이아웃 bbox 를 패널에 맞추는 기본 변환. */
export function fitOf(bbox, panel, pad = 24) {
  const [x0, y0, x1, y1] = bbox;
  const bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0);
  const s = Math.min((panel.w - pad * 2) / bw, (panel.h - pad * 2) / bh);
  return { s, ox: panel.x + (panel.w - bw * s) / 2, oy: panel.y + (panel.h - bh * s) / 2,
           x0, y0, bh };
}

/** 레이아웃 -> 화면. view 를 얹는다. */
export function mapper(fit, view, panel) {
  const S = fit.s * view.s;
  const cxp = panel.x + panel.w / 2, cyp = panel.y + panel.h / 2;
  // 확대는 패널 중심 기준, 이동은 그 뒤에
  const ox = cxp + (fit.ox - cxp) * view.s + view.tx;
  const oy = cyp + (fit.oy - cyp) * view.s + view.ty;
  return {
    S,
    X: (v) => ox + (v - fit.x0) * S,
    Y: (v) => oy + (fit.bh - (v - fit.y0)) * S,      // y 를 위로
  };
}

/** 패널 하나를 그린다. */
export function drawPanel(ctx, panel, data, opt) {
  const { pal, view, label, accent, axes = [], box = null, empty = null } = opt;
  ctx.save();
  ctx.beginPath();
  ctx.rect(panel.x, panel.y, panel.w, panel.h);
  ctx.clip();

  ctx.fillStyle = pal.sunk;
  ctx.fillRect(panel.x, panel.y, panel.w, panel.h);
  if (!data?.rects?.length) {
    if (empty) drawEmpty(ctx, panel, pal, empty);
    ctx.restore();
    return null;
  }

  const fit = fitOf(box ?? data.bbox, panel);
  const m = mapper(fit, view, panel);
  const [x0, y0, x1, y1] = data.bbox;

  // 영역 테두리
  ctx.strokeStyle = pal.hair;
  ctx.lineWidth = 1;
  ctx.strokeRect(m.X(x0) + 0.5, m.Y(y1) + 0.5, (x1 - x0) * m.S, (y1 - y0) * m.S);

  // 대칭축
  for (const a of axes) {
    ctx.save();
    ctx.strokeStyle = pal.axis;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    if (a.vert) { ctx.moveTo(m.X(a.at), m.Y(y1)); ctx.lineTo(m.X(a.at), m.Y(y0)); }
    else { ctx.moveTo(m.X(x0), m.Y(a.at)); ctx.lineTo(m.X(x1), m.Y(a.at)); }
    ctx.stroke();
    ctx.restore();
  }

  ctx.font = '500 10px "IBM Plex Mono", ui-monospace, monospace';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const r of data.rects) {
    const px = m.X(r.x), py = m.Y(r.y + r.h), pw = r.w * m.S, ph = r.h * m.S;
    ctx.globalAlpha = accent ? 0.55 : 0.82;
    ctx.fillStyle = pal.block;
    ctx.fillRect(px, py, pw, ph);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = accent ? pal.ours : pal.blockLine;
    ctx.lineWidth = accent ? 1.5 : 1;
    ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);
    if (pw > 34 && ph > 13) {
      ctx.fillStyle = pal.ink;
      const t = r.name.replace(/^X_?/, "");
      ctx.fillText(t.length > 14 ? t.slice(0, 13) + "…" : t, px + pw / 2, py + ph / 2);
    }
  }

  // 패널 이름표
  if (label) {
    ctx.font = '500 10px "IBM Plex Mono", ui-monospace, monospace';
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillStyle = accent ? pal.ours : pal.faint;
    ctx.fillText(label, panel.x + 10, panel.y + 8);
  }
  ctx.restore();
  return { fit, m };
}

/** 아직 그릴 것이 없는 패널 — 빈 상자 대신 무엇을 눌러야 하는지 적는다. */
function drawEmpty(ctx, panel, pal, lines) {
  const ls = Array.isArray(lines) ? lines : [lines];
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const cx = panel.x + panel.w / 2, cy = panel.y + panel.h / 2;
  const font = (i) => (i === 0 ? '500 12px "IBM Plex Mono", ui-monospace, monospace'
                               : '400 11px "IBM Plex Mono", ui-monospace, monospace');
  // 좁은 패널(휴대폰의 나란히)에서도 읽히게 줄을 나눈다 — 오류 문구가 길다
  const rows = [];
  ls.forEach((t, i) => {
    ctx.font = font(i);
    let cur = "";
    for (const ch of String(t)) {
      if (cur && ctx.measureText(cur + ch).width > panel.w - 20) { rows.push([cur, i]); cur = ""; }
      cur += ch;
    }
    rows.push([cur, i]);
  });
  rows.forEach(([t, i], k) => {
    ctx.font = font(i);
    ctx.fillStyle = pal.faint;
    ctx.globalAlpha = i === 0 ? 1 : 0.8;
    ctx.fillText(t, cx, cy + (k - (rows.length - 1) / 2) * 16);
  });
  ctx.restore();
}

/** 커서를 고정한 채 확대한다. */
export function zoomAt(view, panel, px, py, factor) {
  const cx = panel.x + panel.w / 2, cy = panel.y + panel.h / 2;
  // 확대 전 커서가 가리키던 내용 좌표가 확대 뒤에도 같은 픽셀에 오도록 tx,ty 보정
  const bx = (px - cx - view.tx) / view.s;
  const by = (py - cy - view.ty) / view.s;
  view.s = Math.min(40, Math.max(0.25, view.s * factor));
  view.tx = px - cx - bx * view.s;
  view.ty = py - cy - by * view.s;
  return view;
}

/** 배선 레이어 — 색과 묶음.
 *
 *  ALIGN 이 내는 <TOP>_0.json 의 terminals 는 레이어별 사각형이다
 *  (telescopic_ota 하나가 1057 개). 금속·비아·소자층이 섞여 있어 다 그리면
 *  아무것도 안 보인다. 그래서 묶어서 껐다 켤 수 있게 한다.
 *
 *  색은 층 순서를 따라간다 — 아래(소자)는 차갑고 위(상위 금속)로 갈수록 따뜻하게.
 *  실제 파운드리 색표가 아니라 읽기 위한 것이다.
 */
export const LAYERS = [
  { key: "M1", color: "#4a7fb5", group: "metal" },
  { key: "M2", color: "#3f9a76", group: "metal" },
  { key: "M3", color: "#c98a2e", group: "metal" },
  { key: "M4", color: "#a8577f", group: "metal" },
  { key: "M5", color: "#5aa7bf", group: "metal" },
  { key: "M6", color: "#b5603a", group: "metal" },
  { key: "V0", color: "#7a6a58", group: "via" },
  { key: "V1", color: "#7a6a58", group: "via" },
  { key: "V2", color: "#7a6a58", group: "via" },
  { key: "V3", color: "#7a6a58", group: "via" },
  { key: "V4", color: "#7a6a58", group: "via" },
  { key: "V5", color: "#7a6a58", group: "via" },
  { key: "Poly", color: "#9c3b3b", group: "device" },
  { key: "Fin", color: "#8e9aa6", group: "device" },
  { key: "Active", color: "#6f9455", group: "device" },
  { key: "Rvt", color: "#b08b4f", group: "device" },
  { key: "Lisd", color: "#7b8494", group: "device" },
  { key: "Pc", color: "#8a7fa8", group: "device" },
  { key: "Pb", color: "#8a7fa8", group: "device" },
  { key: "Nwell", color: "#556677", group: "well" },
  { key: "Nselect", color: "#4f6b5a", group: "well" },
  { key: "Pselect", color: "#6b5a4f", group: "well" },
];
export const GROUPS = [
  ["metal", "금속 M1~M6"],
  ["via", "비아 V0~V5"],
  ["device", "소자층"],
  ["well", "웰 · 주입"],
];
const COLOR = new Map(LAYERS.map((l) => [l.key, l.color]));
const GROUP_OF = new Map(LAYERS.map((l) => [l.key, l.group]));

/** 배선된 기하를 그린다. on 은 켜진 묶음의 Set. */
export function drawRouted(ctx, panel, geo, opt) {
  // mark: 강조할 도형의 키 모음 (src/route/align/compare.mjs 의 shapeKey) — 다른 쪽과 다른 도형
  const { pal, view, on, label, box = null, empty = null, mark = null, markKey = null, markColor = "#d33" } = opt;
  ctx.save();
  ctx.beginPath();
  ctx.rect(panel.x, panel.y, panel.w, panel.h);
  ctx.clip();
  ctx.fillStyle = pal.sunk;
  ctx.fillRect(panel.x, panel.y, panel.w, panel.h);
  if (!geo?.terminals?.length) {
    if (empty) drawEmpty(ctx, panel, pal, empty);
    ctx.restore();
    return;
  }

  const fit = fitOf(box ?? geo.bbox, panel);
  const m = mapper(fit, view, panel);

  // 아래층부터 그려야 위층이 덮는다. 묶음 순서가 곧 층 순서다.
  const order = ["well", "device", "via", "metal"];
  let drawn = 0;
  for (const g of order) {
    if (!on.has(g)) continue;
    for (const t of geo.terminals) {
      const grp = GROUP_OF.get(t.layer);
      if (grp !== g) continue;
      const c = COLOR.get(t.layer);
      if (!c) continue;
      const r = t.rect;
      const x = m.X(r[0]), y = m.Y(r[3]);
      const w = Math.max(0.6, (r[2] - r[0]) * m.S);
      const h = Math.max(0.6, (r[3] - r[1]) * m.S);
      ctx.fillStyle = c;
      ctx.globalAlpha = g === "well" ? 0.16 : g === "device" ? 0.42 : 0.8;
      ctx.fillRect(x, y, w, h);
      drawn++;
    }
  }
  ctx.globalAlpha = 1;
  // 다른 쪽과 다른 도형은 층을 가리지 않고 테두리로 짚는다 (작아도 보이게 최소 3px)
  if (mark?.size && markKey) {
    ctx.strokeStyle = markColor;
    ctx.lineWidth = 1.5;
    for (const t of geo.terminals) {
      if (!mark.has(markKey(t))) continue;
      const r = t.rect;
      const w = Math.max(3, (r[2] - r[0]) * m.S), h = Math.max(3, (r[3] - r[1]) * m.S);
      ctx.strokeRect(m.X(r[0]) - 1, m.Y(r[3]) - 1, w + 2, h + 2);
    }
  }
  // 외곽
  const [x0, y0, x1, y1] = geo.bbox;
  ctx.strokeStyle = pal.hair;
  ctx.lineWidth = 1;
  ctx.strokeRect(m.X(x0) + 0.5, m.Y(y1) + 0.5, (x1 - x0) * m.S, (y1 - y0) * m.S);
  if (label) {
    ctx.font = '500 10px "IBM Plex Mono", ui-monospace, monospace';
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillStyle = pal.faint;
    ctx.fillText(`${label} · ${drawn}/${geo.terminals.length}`, panel.x + 10, panel.y + 8);
  }
  ctx.restore();
}
