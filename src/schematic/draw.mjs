/** 회로도를 캔버스에 — layout.mjs 가 놓은 기호·선·묶음을 view.mjs 의 패널 위에 그린다.
 *
 *  좌표는 배열 좌표(픽셀, y 위로)이고 mapper 가 화면으로 옮긴다. 선 굵기와 글자 크기는 배율을
 *  따라가되 너무 가늘거나 작아지지 않게 잡는다 — 큰 회로는 줄여 보면 이름이 사라지고, 확대하면
 *  다시 나온다. hitSchematic 이 마우스 아래의 넷·소자를 찾는다 (hover).
 */
import { fitOf, mapper, drawEmpty } from "../../view.mjs";

const MONO = "ui-monospace, Menlo, Consolas, monospace";
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 그린다. opt: { pal, view, box, label, empty, mode: 'schem' | 'group', hover } */
export function drawSchematic(ctx, panel, lay, opt) {
  const { pal, view, label, box = null, empty = null, mode = "schem", hover = null } = opt;
  ctx.save();
  ctx.beginPath();
  ctx.rect(panel.x, panel.y, panel.w, panel.h);
  ctx.clip();
  ctx.fillStyle = pal.sunk;
  ctx.fillRect(panel.x, panel.y, panel.w, panel.h);
  if (!lay?.devices?.length) {
    if (empty) drawEmpty(ctx, panel, pal, empty);
    ctx.restore();
    return null;
  }
  const fit = fitOf(box ?? lay.bbox, panel);
  const m = mapper(fit, view, panel);
  const S = m.S;
  const X = m.X, Y = m.Y;
  const wire = clamp(1.1 * S, 0.7, 2.2);
  const font = (px, weight = 400) => `${weight} ${px}px ${MONO}`;
  const line = (x1, y1, x2, y2) => { ctx.beginPath(); ctx.moveTo(X(x1), Y(y1)); ctx.lineTo(X(x2), Y(y2)); ctx.stroke(); };
  const knock = (x, y, w, h) => { ctx.fillStyle = pal.sunk; ctx.globalAlpha = 0.82; ctx.fillRect(x, y, w, h); ctx.globalAlpha = 1; };

  // --- 묶음 테두리 (바깥 것부터) ---
  if (mode === "group" || lay.hulls.some((h) => h.kind === "module")) {
    for (const h of lay.hulls) {
      if (mode !== "group" && h.kind === "leaf") continue;
      const x = X(h.x0), y = Y(h.y1), w = (h.x1 - h.x0) * S, hh = (h.y1 - h.y0) * S;
      const leaf = h.kind === "leaf";
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, hh, clamp(8 * S, 2, 10)); else ctx.rect(x, y, w, hh);
      if (leaf) { ctx.fillStyle = pal.ours; ctx.globalAlpha = 0.07; ctx.fill(); ctx.globalAlpha = 1; }
      ctx.strokeStyle = leaf ? pal.ours : pal.faint;
      ctx.lineWidth = leaf ? clamp(1.2 * S, 0.8, 1.6) : 1;
      ctx.setLineDash(leaf ? [] : [5, 4]);
      ctx.globalAlpha = leaf ? 0.7 : 0.9;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      const fs = clamp(9.5 * S, 0, 12);
      if (fs >= 6.5 && w > 40) {
        const text = h.name.replace(/^.*\//, "") + (h.gloss || h.family ? " · " + (h.gloss || h.family) : "");
        ctx.font = font(fs, 500);
        const tw = Math.min(ctx.measureText(text).width, w - 8);
        knock(x + 4, y + 2, tw + 6, fs + 4);
        ctx.fillStyle = leaf ? pal.ours : pal.muted;
        ctx.textAlign = "left"; ctx.textBaseline = "top";
        ctx.fillText(text, x + 7, y + 3, w - 8);
      }
    }
  }
  // --- 대칭축 ---
  if (mode === "group" && lay.axis != null) {
    ctx.save();
    ctx.strokeStyle = pal.axis; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(X(lay.axis), Y(lay.bbox[3])); ctx.lineTo(X(lay.axis), Y(lay.bbox[1])); ctx.stroke();
    ctx.restore();
  }
  // --- 선 ---
  const hoverNet = hover?.kind === "net" ? hover.name : null;
  const drawNet = (n, hi) => {
    const color = hi ? pal.axis : n.role === "vdd" ? pal.ours : n.role === "gnd" ? pal.blockLine : pal.ink;
    ctx.strokeStyle = color; ctx.fillStyle = color;
    ctx.lineWidth = (n.role ? wire * 1.6 : wire) + (hi ? 1.2 : 0);
    ctx.lineCap = "round";
    for (const s of n.segs) line(s[0], s[1], s[2], s[3]);
    const r = clamp(2.6 * S, 1.4, 4) + (hi ? 0.8 : 0);
    for (const d of n.dots) { ctx.beginPath(); ctx.arc(X(d[0]), Y(d[1]), r, 0, Math.PI * 2); ctx.fill(); }
    if (n.label) {
      const strong = n.label.port || !!n.role;
      const fs = strong ? clamp(10 * S, 7, 13) : clamp(8.5 * S, 0, 11);
      if (fs >= 6) {
        ctx.font = font(fs, strong ? 600 : 400);
        ctx.textAlign = n.label.align === "right" ? "right" : n.label.align === "center" ? "center" : "left";
        ctx.textBaseline = n.label.align === "center" ? "bottom" : "middle";
        ctx.fillStyle = hi ? pal.axis : strong ? pal.ink : pal.faint;
        ctx.fillText(n.name, X(n.label.x), Y(n.label.y));
      }
    }
  };
  for (const n of lay.nets) if (n.name !== hoverNet) drawNet(n, false);

  // --- 기호 ---
  const hoverDev = hover?.kind === "dev" ? hover.id : null;
  const nameFs = clamp(10 * S, 0, 13), subFs = clamp(8 * S, 0, 10.5);
  for (const d of lay.devices) {
    const hi = d.id === hoverDev;
    const ink = hi ? pal.ours : pal.ink;
    ctx.strokeStyle = ink; ctx.fillStyle = ink;
    ctx.lineWidth = clamp(1.4 * S, 0.8, 2.4) + (hi ? 0.8 : 0);
    ctx.lineCap = "butt";
    const x = d.x, y = d.y;
    if (d.kind === "nmos" || d.kind === "pmos") {
      const s = d.s;                       // +1: 게이트가 왼쪽
      const g = (dx) => x - s * dx;
      line(x, y + 22, x, y + 12); line(x, y - 12, x, y - 22);
      line(x, y + 12, g(6), y + 12); line(x, y - 12, g(6), y - 12);
      ctx.lineWidth = clamp(2 * S, 1, 3) + (hi ? 0.8 : 0);
      line(g(6), y + 13, g(6), y - 13);
      line(g(9), y + 11, g(9), y - 11);
      ctx.lineWidth = clamp(1.4 * S, 0.8, 2.4) + (hi ? 0.8 : 0);
      if (d.kind === "pmos") {
        ctx.beginPath(); ctx.arc(X(g(13)), Y(y), clamp(3.2 * S, 1.5, 5), 0, Math.PI * 2);
        ctx.fillStyle = pal.sunk; ctx.fill(); ctx.stroke(); ctx.fillStyle = ink;
        line(g(16.5), y, g(22), y);
      } else line(g(9), y, g(22), y);
      // 소스의 화살표: NMOS 는 채널에서 밖으로, PMOS 는 채널 쪽으로
      const sy = d.kind === "nmos" ? y - 12 : y + 12;
      const [tip, base] = d.kind === "nmos" ? [g(0.5), g(5)] : [g(5.5), g(1)];
      ctx.beginPath();
      ctx.moveTo(X(tip), Y(sy)); ctx.lineTo(X(base), Y(sy + 2.6)); ctx.lineTo(X(base), Y(sy - 2.6)); ctx.closePath(); ctx.fill();
      if (nameFs >= 5.5) {
        const tx = X(x + s * 9);
        ctx.textAlign = s > 0 ? "left" : "right"; ctx.textBaseline = "bottom";
        ctx.font = font(nameFs, 500); ctx.fillStyle = ink;
        ctx.fillText(d.short, tx, Y(y) - 1);
        if (d.sub && subFs >= 6) {
          ctx.textBaseline = "top"; ctx.font = font(subFs); ctx.fillStyle = pal.faint;
          ctx.fillText(d.sub, tx, Y(y) + 1);
        }
      }
    } else if (d.kind === "box") {
      const bx = X(x - d.hw), by = Y(y + d.hh), bw = 2 * d.hw * S, bh = 2 * d.hh * S;
      ctx.fillStyle = pal.sunk; ctx.fillRect(bx, by, bw, bh); ctx.strokeRect(bx, by, bw, bh);
      ctx.fillStyle = ink;
      for (const p of d.pins) {
        const ex = p.dir === "left" ? x - d.hw : p.dir === "right" ? x + d.hw : x;
        const ey = p.dir === "up" ? y + d.hh : p.dir === "down" ? y - d.hh : p.y;
        line(p.x, p.y, ex, ey);
        if (subFs >= 6 && (p.dir === "left" || p.dir === "right")) {
          ctx.font = font(clamp(7 * S, 0, 9)); ctx.fillStyle = pal.muted;
          ctx.textAlign = p.dir === "left" ? "left" : "right"; ctx.textBaseline = "middle";
          ctx.fillText(p.name, X(ex) + (p.dir === "left" ? 3 : -3), Y(p.y));
        }
      }
      if (nameFs >= 5.5) {
        ctx.font = font(nameFs, 500); ctx.fillStyle = ink; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(d.short, X(x), Y(y) - (d.sub ? 5 : 0), bw - 6);
        if (d.sub && subFs >= 6) { ctx.font = font(subFs); ctx.fillStyle = pal.faint; ctx.fillText(d.sub, X(x), Y(y) + 7, bw - 6); }
      }
    } else {
      const h = d.horiz;
      const rect = (x0, y0, w, hh2) => {
        ctx.fillStyle = pal.sunk; ctx.fillRect(X(x0), Y(y0 + hh2), w * S, hh2 * S);
        ctx.strokeRect(X(x0), Y(y0 + hh2), w * S, hh2 * S); ctx.fillStyle = ink;
      };
      if (d.kind === "cap") {
        ctx.lineWidth = clamp(2 * S, 1, 3);
        if (h) { line(x - 3, y - 9, x - 3, y + 9); line(x + 3, y - 9, x + 3, y + 9); }
        else { line(x - 9, y - 3, x + 9, y - 3); line(x - 9, y + 3, x + 9, y + 3); }
        ctx.lineWidth = clamp(1.4 * S, 0.8, 2.4);
        if (h) { line(x - 22, y, x - 3, y); line(x + 3, y, x + 22, y); }
        else { line(x, y + 22, x, y + 3); line(x, y - 3, x, y - 22); }
      } else {
        if (h) rect(x - 14, y - 5, 28, 10); else rect(x - 5, y - 14, 10, 28);
        if (h) { line(x - 22, y, x - 14, y); line(x + 14, y, x + 22, y); }
        else { line(x, y + 22, x, y + 14); line(x, y - 14, x, y - 22); }
      }
      if (nameFs >= 5.5) {
        ctx.textAlign = "left"; ctx.textBaseline = "bottom";
        ctx.font = font(nameFs, 500); ctx.fillStyle = ink;
        ctx.fillText(d.short, X(x + (h ? 0 : 9)), Y(y + (h ? 8 : 0)) - 1);
        if (d.sub && subFs >= 6) {
          ctx.textBaseline = "top"; ctx.font = font(subFs); ctx.fillStyle = pal.faint;
          ctx.fillText(d.sub, X(x + (h ? 0 : 9)), Y(y + (h ? 8 : 0)) + 1);
        }
      }
    }
  }
  // 가리킨 넷은 맨 위에
  if (hoverNet != null) { const n = lay.nets.find((q) => q.name === hoverNet); if (n) drawNet(n, true); }

  if (label) {
    ctx.font = font(10, 500); ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillStyle = pal.faint;
    ctx.fillText(label, panel.x + 10, panel.y + 8);
  }
  ctx.restore();
  return { fit, m };
}

/** 화면 좌표 (px, py) 아래의 소자나 넷. 없으면 null. */
export function hitSchematic(lay, m, px, py) {
  if (!lay?.devices?.length || !m) return null;
  for (const d of lay.devices) {
    const x0 = m.X(d.x - d.hw), x1 = m.X(d.x + d.hw), y0 = m.Y(d.y + d.hh), y1 = m.Y(d.y - d.hh);
    if (px >= x0 && px <= x1 && py >= y0 && py <= y1) return { kind: "dev", id: d.id, name: d.name, dev: d };
  }
  let best = null, bestD = 6;
  for (const n of lay.nets)
    for (const s of n.segs) {
      const x1 = m.X(s[0]), y1 = m.Y(s[1]), x2 = m.X(s[2]), y2 = m.Y(s[3]);
      const dx = x2 - x1, dy = y2 - y1;
      const L2 = dx * dx + dy * dy;
      const t = L2 ? clamp(((px - x1) * dx + (py - y1) * dy) / L2, 0, 1) : 0;
      const d = Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
      if (d < bestD) { bestD = d; best = n; }
    }
  return best ? { kind: "net", name: best.name, net: best } : null;
}
