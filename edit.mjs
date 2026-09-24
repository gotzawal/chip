/** 편집기 — 페이지 쪽. 배치(블록)와 배선(넷·조각)을 캔버스에서 고친다.
 *
 *  index.html 이 **동적으로** 받는다 (회로도 모듈과 같은 이유 — 옛 모듈이 캐시에 남은 채 새 판을 받아도 페이지가
 *  비지 않게). 못 받으면 편집 토글이 안 켜질 뿐 보기·배치·배선은 그대로다. 편집이 없으면 아무것도 바꾸지 않는다.
 *
 *  배치 편집의 셈은 전부 src/edit/place.mjs 에 있다 (문제 다시 짓기, 끌기 사영, 정리, 변이 다시). 여기는
 *  포인터·키·카드·덧칠뿐이다. 진실은 model 의 theta 와 반전(sx, sy)이고, 화면의 rects 는 거기서 다시 낸다.
 *
 *    끌기      제약을 따라 (거울 쌍은 거울로, 축 위 블록은 축을 따라, Align 줄은 같이). 축은 고정, Alt 는 그룹째
 *    정리      편집 좌표의 쌍 관계(위상)를 박고 legalize — 겹침 0, 격자, Order, 압축
 *    위상 유지 최적화   정리 뒤 같은 위상에서 변이를 전수로 다시 고른다 (워커)
 *    변이 고정  카드에서 고른 변이는 고정된다 — 다음 "Placement 실행" 도 그 변이를 쓴다
 *
 *  배선 편집 (넷 고르기·조각 옮기기·재검사·고정·재배선)은 src/edit/wires.mjs 와 배선 워커의 세션 위에서 한다.
 */
import { rebuild, centers, dragTheta, pinRows, dragRows, overlapping, settle, toRects, chooseFlips, flipGroup,
         flipFreedom, variantChoices, withVariant, measure } from "./src/edit/place.mjs";
import { buildGraph, range, slide, toNode, worldShapes, cloneGraph, segRect, netLength } from "./src/edit/wires.mjs";
import { compactNet, compactAll } from "./src/edit/compact.mjs";

const MONO = "ui-monospace, Menlo, Consolas, monospace";
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const short = (c) => String(c ?? "—").replace(/_(\d{6,})_/, "_");
const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : "—");

export function createEditor(host) {
  const { cv } = host;
  let mode = false;                  // 편집 토글
  let mapNow = null;                 // 마지막으로 그린 변환 {m, panel, what}

  // ---------------------------------------------------------------- 배치 편집 상태
  const pl = {
    model: null, base: null, orig: null, kit: null,   // 문제, 편집기를 세운 배치, 배치기가 낸 done(원래대로), 편집 키트
    theta: null, sx: null, sy: null,         // 진실
    live: null,                              // {rects, axes, cx, cy, ax, m} — theta 에서 낸 화면 상태
    sel: new Set(), locked: new Set(), pinned: new Map(),
    hist: [], fut: [], drag: null, hover: null,
    dirty: false, edits: 0, err: null,
    compact: 0.5, both: false, ranking: null, busy: false,
  };
  // ---------------------------------------------------------------- 배선 편집 상태
  const rt = {
    model: null, graphs: new Map(),          // 넷 모델 (워커의 wires, PnRDB 단위) 과 넷마다의 조각 그래프
    net: null, seg: null, range: null,       // 고른 넷·조각과 그 조각의 범위
    frozen: new Set(),                       // 사용자가 고정한 넷 (편집한 넷은 저절로)
    hist: [], fut: [], drag: null, busy: false, expect: false, baseErrors: null, nerr: null, err: null,
  };

  const state = () => host.state();
  const what = () => state().what;
  const applicable = () => (what() === "place" && !!pl.model && !!state().ours) || (what() === "route" && !!state().routed);

  // ---------------------------------------------------------------- 좌표
  const toLayout = (px, py) => {
    const m = mapNow?.m;
    if (!m) return null;
    return { x: (px - m.X(0)) / m.S, y: (m.Y(0) - py) / m.S };
  };

  // ---------------------------------------------------------------- 배치: 모델과 화면 상태
  function refreshLive() {
    const { model, theta, sx, sy } = pl;
    if (!model) { pl.live = null; return; }
    const { cx, cy, ax } = centers(model, theta);
    const P = model.P;
    const rects = P.names.map((nm, i) => ({
      name: nm, concrete: P.concrete[i], x: cx[i] - P.w[i] / 2, y: cy[i] - P.h[i] / 2, w: P.w[i], h: P.h[i], sx: sx[i], sy: sy[i],
    }));
    const m = measure(model, cx, cy, sx, sy);
    const ov = overlapping(model, cx, cy);
    const axesNow = [];
    for (const [nm, r] of model.roles) {
      if (axesNow[r.k]) continue;
      axesNow[r.k] = { vert: r.vert, at: ax[r.k], k: r.k, name: nm };
    }
    pl.live = { rects, cx, cy, ax, m, overlap: ov, axes: axesNow.filter(Boolean),
                orderBad: new Set(m.orderBad.flatMap((s) => s.split(" -> "))) };
  }

  /** 지금 화면에 그릴 것 — 편집 중이면 theta 에서 낸 rects (bbox 는 정리된 것 그대로: 끄는 동안 틀이 안 뛰게) */
  function liveData() {
    if (!mode || what() !== "place" || !pl.live || !pl.base) return null;
    const ours = state().ours;
    if (!ours) return null;
    return { ...ours, rects: pl.live.rects, axes: pl.live.axes.map((a) => ({ vert: a.vert, at: a.at })) };
  }

  function snapshot() {
    return { rects: pl.live.rects.map((r) => ({ ...r })), locked: new Set(pl.locked), pinned: new Map(pl.pinned),
             ours: state().ours, edits: pl.edits };
  }
  function restore(s) {
    const blob = host.design();
    pl.model = rebuild(blob, pl.kit, s.rects);
    pl.theta = pl.model.theta; pl.sx = pl.model.sx; pl.sy = pl.model.sy;
    pl.locked = new Set(s.locked); pl.pinned = new Map(s.pinned); pl.edits = s.edits;
    if (s.ours !== state().ours) host.setOurs(s.ours);
    // 정리 전 상태였나 — 좌표나 변이가 굳힌 배치와 다르면
    const by = new Map(s.ours.rects.map((r) => [r.name, r]));
    pl.dirty = s.rects.some((r) => { const o = by.get(r.name); return !o || o.concrete !== r.concrete || Math.abs(r.x - o.x) > 1e-6 || Math.abs(r.y - o.y) > 1e-6; });
    refreshLive();
  }
  const pushHistory = () => { pl.hist.push(snapshot()); if (pl.hist.length > 60) pl.hist.shift(); pl.fut = []; };
  function undo() { if (!pl.hist.length) return; pl.fut.push(snapshot()); restore(pl.hist.pop()); afterEdit(false); }
  function redo() { if (!pl.fut.length) return; pl.hist.push(snapshot()); restore(pl.fut.pop()); afterEdit(false); }

  /** 배치 하나로 편집기를 다시 세운다 (워커의 done 이거나 원래 배치로 되돌릴 때). 고정한 변이는 부르는 쪽이 남긴다. */
  function placed(done) {
    pl.base = done; pl.kit = done?.edit ?? null; pl.err = null;
    pl.hist = []; pl.fut = []; pl.dirty = false; pl.edits = done?.edited ?? 0; pl.sel = new Set(); pl.ranking = null;
    pl.locked = new Set();
    if (!done || !pl.kit) { pl.model = null; pl.live = null; pl.err = done ? "이 배치에는 편집 키트가 없습니다 — Placement 를 다시 실행하세요" : null; render(); return; }
    try {
      pl.model = rebuild(host.design(), pl.kit, done.rects);
      pl.theta = pl.model.theta; pl.sx = pl.model.sx; pl.sy = pl.model.sy;
      refreshLive();
    } catch (e) {
      pl.model = null; pl.live = null; pl.err = "편집 준비 실패 — " + e.message; console.error("[편집]", e);
    }
    render();
  }

  /** 편집 하나가 끝났다 — 배선은 더 이상 이 배치의 것이 아니다 */
  function afterEdit(invalidate = true) {
    refreshLive();
    if (invalidate && state().routed) host.invalidateRouting();
    render(); host.redraw();
  }

  // ---------------------------------------------------------------- 배치: 편집들
  function selectedIndices() { return [...pl.sel].map((nm) => pl.model.idx.get(nm)).filter((i) => i !== undefined); }

  function settleNow({ silent = false } = {}) {
    const { model, sx, sy } = pl;
    if (!model) return false;
    const { cx, cy } = pl.live;
    const r = settle(model, cx, cy, sx, sy, { both: pl.both, compact: pl.compact });
    if (r.status !== "OPTIMAL") {
      const why = r.status === "NODIRECTION"
        ? `정리 실패 — 어느 쪽으로도 뗄 수 없는 쌍: ${r.pairs.map((p) => p.join("~")).join(", ")}`
        : `정리 실패 (${r.status})` + (r.orderBad.length ? ` — Order 위반: ${r.orderBad.join(", ")}` : "");
      pl.err = why; if (!silent) host.setStatus(`<span style="color:var(--copper)">${esc(why)}</span>`);
      render(); return false;
    }
    pushHistory();
    applyCoords(r.cx, r.cy, sx, sy, { ms: r.ms, slack: r.slack });
    return true;
  }

  /** 정리된 좌표를 새 배치(ours)로 굳힌다 */
  function applyCoords(cx, cy, sx, sy, info = {}) {
    const out = toRects(pl.model, cx, cy, sx, sy);
    const ours = state().ours;
    const base = ours.base ?? { area: ours.area, hpwl: ours.hpwl, bbox: ours.bbox };
    const next = { ...ours, ...out, edited: pl.edits + 1, base, hpwlBeforeFlip: null, fixedVariants: fixedVariants(),
                   editInfo: { ms: info.ms ?? null, slack: info.slack ?? null } };
    delete next.score;
    pl.edits++;
    host.setOurs(next);
    pl.model = rebuild(host.design(), pl.kit, next.rects);
    pl.theta = pl.model.theta; pl.sx = pl.model.sx; pl.sy = pl.model.sy;
    pl.dirty = false; pl.err = null;
    refreshLive(); render();
  }

  function flip(axis) {
    const names = [...pl.sel];
    if (!names.length || !pl.model) return;
    let sx = pl.sx, sy = pl.sy, any = false;
    const done = new Set();
    for (const nm of names) {
      if (done.has(nm)) continue;
      const f = flipGroup(pl.model, nm, axis, sx, sy);
      if (!f) continue;
      f.members.forEach((m) => done.add(m));
      sx = f.sx; sy = f.sy; any = true;
    }
    if (!any) { host.setStatus(`<span>${esc(names.join(", "))} 의 ${axis} 반전은 제약에 묶여 있습니다</span>`); return; }
    pushHistory();
    // 반전은 좌표를 안 바꾼다 — 정리 없이 바로 굳힌다 (HPWL 만 다시 잰다). 정리 전 상태였다면 그 좌표째 굳는다
    const { cx, cy } = pl.live;
    applyCoords(cx, cy, sx, sy);
    if (state().routed) host.invalidateRouting();
  }

  function setVariant(name, concrete) {
    if (!pl.model) return;
    const vc = variantChoices(pl.model, name);
    if (!vc || vc.current === concrete) return;
    const rects = withVariant(pl.model, pl.live.rects, name, concrete);
    if (!rects) return;
    pushHistory();
    for (const m of vc.members) pl.pinned.set(m, concrete);
    pl.model = rebuild(host.design(), pl.kit, rects);
    pl.theta = pl.model.theta; pl.sx = pl.model.sx; pl.sy = pl.model.sy;
    pl.dirty = true;
    afterEdit();
    host.setStatus(`<span>${esc(name)} 의 변이를 ${esc(short(concrete))} 로 — 겹침이 생기면 정리하세요. 이 변이는 고정됩니다</span>`);
  }
  function unpin(name) {
    const vc = pl.model ? variantChoices(pl.model, name) : null;
    for (const m of vc?.members ?? [name]) pl.pinned.delete(m);
    render();
  }
  function fixedVariants() { return pl.pinned.size ? Object.fromEntries(pl.pinned) : null; }

  function swap() {
    if (pl.sel.size !== 2 || !pl.model) return;
    const [a, b] = selectedIndices();
    const { cx, cy } = pl.live;
    pushHistory();
    const th = dragTheta(pl.model, pl.theta, pinRows(pl.model, { locked: pl.locked }),
                         [[2 * a, cx[b]], [2 * a + 1, cy[b]], [2 * b, cx[a]], [2 * b + 1, cy[a]]]);
    pl.theta = th; pl.dirty = true;
    afterEdit();
  }
  function toggleLock() {
    for (const nm of pl.sel) { if (pl.locked.has(nm)) pl.locked.delete(nm); else pl.locked.add(nm); }
    render(); host.redraw();
  }
  function nudge(dx, dy) {
    const names = [...pl.sel].filter((nm) => !pl.locked.has(nm));
    if (!names.length || !pl.model) return;
    pushHistory();
    const { cx, cy, ax } = pl.live;
    pl.theta = dragTheta(pl.model, pl.theta, pinRows(pl.model, { locked: pl.locked }), dragRows(pl.model, names, dx, dy, cx, cy, ax));
    pl.dirty = true;
    afterEdit();
  }
  function reflip() {
    if (!pl.model) return;
    const { cx, cy } = pl.live;
    const fr = chooseFlips(pl.model, cx, cy);
    const same = fr.sx.every((v, i) => v === pl.sx[i]) && fr.sy.every((v, i) => v === pl.sy[i]);
    if (same) { host.setStatus("<span>반전은 이미 최선입니다</span>"); return; }
    pushHistory();
    applyCoords(cx, cy, fr.sx, fr.sy);
    if (state().routed) host.invalidateRouting();
  }
  function revert() {
    if (!pl.orig) return;
    pushHistory();
    host.setOurs(pl.orig);
    placedKeepPins(pl.orig);
    if (state().routed) host.invalidateRouting();
  }
  function placedKeepPins(done) { const pinned = pl.pinned; placed(done); pl.pinned = pinned; render(); }

  /** 정리 뒤 같은 위상에서 변이를 다시 고른다 (워커). 끝나면 1 위를 적용하고 순위를 카드에 보인다 */
  async function retry() {
    if (!pl.model || pl.busy) return;
    if (pl.dirty && !settleNow()) return;
    pl.busy = true; render();
    host.setStatus('<span class="dot"></span><span>같은 위상에서 변이를 다시 고르는 중…</span>');
    try {
      const ours = state().ours;
      const blob = host.design();
      const r = await host.placeRetry({ kind: "retry", blob: { topology: blob.topology, primitives: blob.primitives, templates: blob.templates },
                                        kit: pl.kit, rects: ours.rects, fixed: fixedVariants(), compact: pl.compact,
                                        hpwlWeight: ours.hpwlWeight ?? 1 });
      pl.ranking = r.ranking.slice(0, 6).map((x) => ({ ...x }));
      const best = r.ranking[0];
      if (best && !best.current) {
        pushHistory();
        applyOut(best.out);
        host.setStatus(`<span>변이 다시 — ${r.tried} 배정 중 1 위를 적용했습니다 (면적x배선 ${Math.exp(best.score - (r.ranking[r.current]?.score ?? best.score)).toFixed(3)} 배)  ${(r.ms / 1000).toFixed(1)}s</span>`);
      } else host.setStatus(`<span>변이 다시 — 지금 배정이 ${r.tried} 배정 중 1 위입니다  ${(r.ms / 1000).toFixed(1)}s</span>`);
    } catch (e) {
      host.setStatus(`<span style="color:var(--copper)">변이 다시 실패 — ${esc(e.message)}</span>`);
    } finally { pl.busy = false; render(); }
  }
  /** retry 의 순위 하나를 배치로 굳힌다 */
  function applyOut(out) {
    const ours = state().ours;
    const base = ours.base ?? { area: ours.area, hpwl: ours.hpwl, bbox: ours.bbox };
    const next = { ...ours, ...out, edited: pl.edits + 1, base, hpwlBeforeFlip: null, fixedVariants: fixedVariants() };
    delete next.score;
    pl.edits++;
    host.setOurs(next);
    pl.model = rebuild(host.design(), pl.kit, next.rects);
    pl.theta = pl.model.theta; pl.sx = pl.model.sx; pl.sy = pl.model.sy;
    pl.dirty = false; pl.err = null;
    refreshLive(); render();
  }

  // ---------------------------------------------------------------- 배치: 포인터
  function hitBlock(x, y) {
    if (!pl.live) return null;
    let best = null;
    for (const r of pl.live.rects) {
      if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) continue;
      if (pl.sel.has(r.name)) return r.name;          // 고른 것이 위
      if (!best || r.w * r.h < best.w * best.h) best = r;
    }
    return best?.name ?? null;
  }
  function axisHandle(px, py) {
    if (!pl.live || !mapNow) return null;
    const m = mapNow.m, bb = state().ours?.bbox;
    if (!bb) return null;
    for (const a of pl.live.axes) {
      const hx = a.vert ? m.X(a.at) : m.X(bb[2]) - 8, hy = a.vert ? m.Y(bb[3]) + 8 : m.Y(a.at);
      if (Math.abs(px - hx) <= 8 && Math.abs(py - hy) <= 8) return a;
    }
    return null;
  }

  function placeDown(e, px, py) {
    const p = toLayout(px, py);
    if (!p || !pl.live) return false;
    const ax = axisHandle(px, py);
    if (ax) {
      pl.drag = { kind: "axis", k: ax.k, vert: ax.vert, x0: p.x, y0: p.y, theta0: pl.theta, live0: pl.live, moved: false, snap: snapshot() };
      return true;
    }
    const nm = hitBlock(p.x, p.y);
    if (!nm) { pl.drag = { kind: "empty", x0: px, y0: py }; return false; }
    if (e.shiftKey) { if (pl.sel.has(nm)) pl.sel.delete(nm); else pl.sel.add(nm); }
    else if (!pl.sel.has(nm)) pl.sel = new Set([nm]);
    const names = [...pl.sel].filter((q) => !pl.locked.has(q));
    pl.drag = { kind: "block", names, x0: p.x, y0: p.y, theta0: pl.theta, live0: pl.live, group: e.altKey, moved: false, snap: snapshot() };
    render(); host.redraw();
    return true;
  }
  function placeMove(e, px, py) {
    const d = pl.drag;
    if (!d || d.kind === "empty") {
      // hover
      const p = toLayout(px, py);
      const nm = p ? hitBlock(p.x, p.y) : null;
      if (nm !== pl.hover) { pl.hover = nm; hint(); host.redraw(); }
      return false;
    }
    const p = toLayout(px, py);
    if (!p) return true;
    const dx = p.x - d.x0, dy = p.y - d.y0;
    if (!d.moved && Math.hypot(dx, dy) * (mapNow?.m.S ?? 1) < 3) return true;
    d.moved = true;
    const { cx, cy, ax } = d.live0;
    if (d.kind === "axis") {
      pl.theta = dragTheta(pl.model, d.theta0, pinRows(pl.model, { lockAxes: false, locked: pl.locked }),
                           [[2 * pl.model.n + d.k, ax[d.k] + (d.vert ? dx : dy)]]);
    } else {
      pl.theta = dragTheta(pl.model, d.theta0, pinRows(pl.model, { lockAxes: !d.group, locked: pl.locked }),
                           dragRows(pl.model, d.names, dx, dy, cx, cy, ax, { group: d.group }));
    }
    refreshLive();
    liveHint();
    host.redraw();
    return true;
  }
  function placeUp(e, px, py) {
    const d = pl.drag;
    pl.drag = null;
    if (!d) return false;
    if (d.kind === "empty") {
      if (Math.hypot(px - d.x0, py - d.y0) < 3 && !e.shiftKey && pl.sel.size) { pl.sel = new Set(); render(); host.redraw(); }
      return false;
    }
    if (d.moved) {
      pl.hist.push(d.snap); pl.fut = [];
      pl.dirty = true;
      afterEdit();
    } else { render(); host.redraw(); }
    return true;
  }

  function hint() {
    const nm = pl.hover ?? [...pl.sel][0];
    const el = document.getElementById("hint");
    if (!el) return;
    if (!nm || !pl.model) { el.textContent = ""; return; }
    const P = pl.model.P, i = pl.model.idx.get(nm);
    const nets = new Set();
    for (let p = 0; p < P.pinInst.length; p++) if (P.pinInst[p] === i) nets.add(P.netNames[P.pinNet[p]]);
    el.textContent = `${nm} · ${short(P.concrete[i])} · ${Math.round(P.w[i])}×${Math.round(P.h[i])}` + (nets.size ? ` · 넷 ${[...nets].join(" ")}` : "");
  }
  function liveHint() {
    const el = document.getElementById("hint");
    if (!el || !pl.live) return;
    const m = pl.live.m;
    el.textContent = `겹침 ${pl.live.overlap.pairs} 쌍 · Order 위반 ${m.orderBad.length} · HPWL ${fmt(m.hpwl)}`;
  }

  // ---------------------------------------------------------------- 배치: 덧칠
  function drawPlace(ctx, panel, m) {
    if (!pl.live || !pl.model) return;
    const pal = state().pal;
    const { rects } = pl.live;
    const bb = state().ours?.bbox;
    ctx.save();
    ctx.beginPath(); ctx.rect(panel.x, panel.y, panel.w, panel.h); ctx.clip();
    // 원래 자리 (움직인 블록만, 유령 상자)
    const settled = state().ours?.rects;
    const base = settled ? new Map(settled.map((r) => [r.name, r])) : null;
    if (base) {
      ctx.setLineDash([3, 3]); ctx.strokeStyle = pal.faint; ctx.lineWidth = 1; ctx.globalAlpha = 0.7;
      for (const r of rects) {
        const b = base.get(r.name);
        if (!b || (Math.abs(b.x - r.x) < 1e-6 && Math.abs(b.y - r.y) < 1e-6 && b.w === r.w && b.h === r.h)) continue;
        ctx.strokeRect(m.X(b.x) + 0.5, m.Y(b.y + b.h) + 0.5, b.w * m.S, b.h * m.S);
      }
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    // 겹침·Order 위반은 빨갛게, 잠금은 점선, 고른 것은 강조
    for (const r of rects) {
      const px = m.X(r.x), py = m.Y(r.y + r.h), pw = r.w * m.S, ph = r.h * m.S;
      const bad = pl.live.overlap.names.has(r.name) || pl.live.orderBad.has(r.name);
      if (bad) { ctx.fillStyle = "#c8302f"; ctx.globalAlpha = 0.22; ctx.fillRect(px, py, pw, ph); ctx.globalAlpha = 1; }
      if (pl.locked.has(r.name)) { ctx.setLineDash([4, 3]); ctx.strokeStyle = pal.ink; ctx.lineWidth = 1; ctx.strokeRect(px + 2.5, py + 2.5, pw - 5, ph - 5); ctx.setLineDash([]); }
      if (pl.sel.has(r.name) || pl.hover === r.name) {
        ctx.strokeStyle = pl.sel.has(r.name) ? pal.ours : pal.axis; ctx.lineWidth = pl.sel.has(r.name) ? 2.5 : 1.5;
        ctx.strokeRect(px + 1, py + 1, pw - 2, ph - 2);
      }
      if (pl.pinned.has(r.name) && pw > 20 && ph > 20) {
        ctx.fillStyle = pal.ours; ctx.font = `600 9px ${MONO}`; ctx.textAlign = "right"; ctx.textBaseline = "top";
        ctx.fillText("고정", px + pw - 4, py + 3);
      }
    }
    // 플라이라인 — 고른(또는 가리킨) 블록의 넷
    const focus = pl.hover ?? [...pl.sel][0];
    if (focus) {
      const P = pl.model.P, i = pl.model.idx.get(focus), { cx, cy } = pl.live, sx = pl.sx, sy = pl.sy;
      const pinXY = (p) => [cx[P.pinInst[p]] + sx[P.pinInst[p]] * P.pinOff[2 * p], cy[P.pinInst[p]] + sy[P.pinInst[p]] * P.pinOff[2 * p + 1]];
      ctx.strokeStyle = pal.ours; ctx.lineWidth = 1; ctx.globalAlpha = 0.75; ctx.setLineDash([]);
      for (let p = 0; p < P.pinInst.length; p++) {
        if (P.pinInst[p] !== i) continue;
        const [x1, y1] = pinXY(p);
        for (let q = 0; q < P.pinInst.length; q++) {
          if (q === p || P.pinNet[q] !== P.pinNet[p] || P.pinInst[q] === i) continue;
          const [x2, y2] = pinXY(q);
          ctx.beginPath(); ctx.moveTo(m.X(x1), m.Y(y1)); ctx.lineTo(m.X(x2), m.Y(y2)); ctx.stroke();
        }
        ctx.beginPath(); ctx.arc(m.X(x1), m.Y(y1), 2.5, 0, Math.PI * 2); ctx.fillStyle = pal.ours; ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    // 축 핸들
    if (bb) {
      for (const a of pl.live.axes) {
        const hx = a.vert ? m.X(a.at) : m.X(bb[2]) - 8, hy = a.vert ? m.Y(bb[3]) + 8 : m.Y(a.at);
        ctx.fillStyle = pal.axis; ctx.globalAlpha = 0.9;
        ctx.fillRect(hx - 5, hy - 5, 10, 10);
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- 배선: 넷·조각 고르기, 옮기기, 재검사, 고정, 재배선
  //
  // 넷 모델(rt.model — 배선 워커가 낸 wires, PnRDB 단위)과 넷마다의 조각 그래프(rt.graphs) 위에서 한다. 조각을 옮기면
  // 그 넷의 경로를 되펴(toNode) 워커에 재검사를 보내고, 돌아온 결과로 페이지(geo·DRC·GDS)와 모델을 바꾼다. 편집한
  // 넷은 고정된다 — 다시 배선할 때 그대로 둔다. 이력은 넷마다의 경로 전후로 남겨 재검사로 되돌린다.
  const S2 = (v) => v / 2;                       // PnRDB -> PDK (그리기)
  const pathOf = (net) => { const q = rt.model.nets.find((z) => z.name === net); return { net, path_metal: q.path_metal, path_via: q.path_via }; };
  const allPaths = () => rt.model.nets.filter((q) => q.path_metal.length).map((q) => pathOf(q.name));

  /** 배선 결과가 왔다 — 페이지의 새 판이거나(이력을 비운다) 편집기가 보낸 재검사·재배선의 답이다(expect) */
  function routedNow(m) {
    const own = rt.expect; rt.expect = false;
    const keep = rt.net;
    rt.model = m?.wires ?? null;
    rt.graphs = new Map((rt.model?.nets ?? []).map((q) => [q.name, buildGraph(q)]));
    if (!own) { rt.frozen = new Set(m?.frozen ?? []); rt.hist = []; rt.fut = []; rt.baseErrors = m?.nerrors ?? null; }
    rt.nerr = m?.nerrors ?? null;
    rt.net = keep && rt.graphs.has(keep) ? keep : null;
    rt.seg = null; rt.range = null; rt.drag = null; rt.err = null;
    render();
  }

  function hitNet(x, y) {
    const geo = state().routed;
    if (!geo?.terminals) return null;
    let best = null, bestA = Infinity;
    for (const t of geo.terminals) {
      if (!t.netName || t.layer === "Outline") continue;
      const r = t.rect;
      if (x < r[0] || x > r[2] || y < r[1] || y > r[3]) continue;
      const a = (r[2] - r[0]) * (r[3] - r[1]);
      if (a < bestA) { bestA = a; best = t; }
    }
    return best?.netName ?? null;
  }
  /** 고른 넷의 조각 — 화면 3 px 여유로 */
  function hitSeg(net, x, y) {
    const g = rt.graphs.get(net);
    if (!g) return null;
    const tol = 3 / (mapNow?.m.S ?? 1);
    let best = null, bestA = Infinity;
    for (const q of g.segs) {
      const r = segRect(q).map(S2);
      if (x < r[0] - tol || x > r[2] + tol || y < r[1] - tol || y > r[3] + tol) continue;
      const a = (r[2] - r[0]) * (r[3] - r[1]);
      if (a < bestA) { bestA = a; best = q; }
    }
    return best;
  }
  function rangeOf(net, seg) {
    const g = rt.graphs.get(net);
    return range(g, seg, worldShapes(rt.model, rt.graphs, net), rt.model.bbox);
  }

  function routeDown(e, px, py) {
    const p = toLayout(px, py);
    if (!p || !rt.model || rt.busy) return false;
    const seg = rt.net ? hitSeg(rt.net, p.x, p.y) : null;
    if (seg) {
      rt.seg = seg;
      rt.range = rangeOf(rt.net, seg);
      if (rt.range.locked) { rt.drag = { kind: "locked", x0: px, y0: py }; hintRoute(); render(); host.redraw(); return true; }
      const g = cloneGraph(rt.graphs.get(rt.net));
      rt.drag = { kind: "slide", net: rt.net, g, s: g.segs[seg.id], r: rt.range, t0: seg.t, x0: px, y0: py, moved: false };
      hintRoute(); render(); host.redraw();
      return true;
    }
    rt.drag = { kind: "empty", x0: px, y0: py, net: hitNet(p.x, p.y) };
    return false;                                  // 빈 자리(또는 다른 넷)면 이동 — 안 끌면 고르기 (routeUp)
  }
  function routeMove(e, px, py) {
    const d = rt.drag;
    if (!d || d.kind !== "slide") {
      const p = toLayout(px, py);
      const nm = p ? hitNet(p.x, p.y) : null;
      const el = document.getElementById("hint");
      if (el && !rt.seg) el.textContent = nm ? `넷 ${nm}` + (rt.frozen.has(nm) ? " · 고정" : "") : "";
      return false;
    }
    const p = toLayout(px, py);
    if (!p) return true;
    const want = 2 * (d.s.dir === "v" ? p.x : p.y);          // PnRDB
    let t = d.s.t, best = Infinity;
    for (const c of d.r.tracks) { const q = Math.abs(c - want); if (q < best) { best = q; t = c; } }
    if (t !== d.s.t) { slide(d.g, d.s, t); d.moved = t !== d.t0; hintRoute(); host.redraw(); }
    return true;
  }
  function routeUp(e, px, py) {
    const d = rt.drag; rt.drag = null;
    if (!d) return false;
    if (d.kind === "empty") {
      if (Math.hypot(px - d.x0, py - d.y0) < 3) {
        const next = d.net ?? null;
        if (next !== rt.net) { rt.net = next; rt.seg = null; rt.range = null; render(); host.redraw(); }
        else if (!next) { rt.seg = null; render(); host.redraw(); }
      }
      return false;
    }
    if (d.kind === "locked") return true;
    if (d.moved) commitSlide(d.net, d.g);
    else { render(); host.redraw(); }
    return true;
  }
  function hintRoute() {
    const el = document.getElementById("hint");
    if (!el) return;
    if (rt.drag?.kind === "slide") {
      const d = rt.drag;
      el.textContent = `${d.s.layer} ${S2(d.t0)} -> ${S2(d.s.t)} · 트랙 ${d.r.tracks.length} 개 [${S2(d.r.lo).toFixed(0)}, ${S2(d.r.hi).toFixed(0)}]`;
    } else if (rt.seg && rt.range) {
      el.textContent = `${rt.net} ${rt.seg.layer} 트랙 ${S2(rt.seg.t)} · ` + (rt.range.locked ? `잠김: ${rt.range.why}` : `옮길 트랙 ${rt.range.tracks.length} 개`);
    }
  }

  /** 편집한 경로들을 워커에 보내 재검사(또는 재배선)하고, 답을 페이지와 모델에 꽂고, 이력을 남긴다 */
  async function sendEdits(edits, { before, msg = null, label = "재검사", frozenBefore = new Set(rt.frozen), acceptIf = null } = {}) {
    if (rt.busy || !rt.model) return;
    rt.busy = true; render();
    try {
      host.setStatus(`<span class="dot"></span><span>${esc(label)} 중…</span>`);
      const m = await host.routeSend(msg ?? { kind: "recheck", edits });
      rt.expect = true;
      host.applyRouted(m);                               // -> editor.routed(m) -> routedNow
      const names = msg ? m.wires.nets.map((q) => q.name) : edits.map((e) => e.net);
      const after = names.map((nm) => { const q = m.wires.nets.find((z) => z.name === nm); return { net: nm, path_metal: q.path_metal, path_via: q.path_via }; });
      rt.hist.push({ before, after, frozenBefore, frozenAfter: new Set(rt.frozen) });
      if (rt.hist.length > 40) rt.hist.shift();
      rt.fut = [];
      host.refreshDownloads?.();
      const d = rt.baseErrors == null ? "" : ` (배선기 결과 대비 ${m.nerrors - rt.baseErrors >= 0 ? "+" : ""}${m.nerrors - rt.baseErrors})`;
      // 받아들일 조건이 있고 못 미치면 (정돈이 오류를 늘렸다) 바로 되돌린다
      if (acceptIf && !acceptIf(m)) {
        const en = rt.hist.pop();
        rt.busy = false;
        await replay(en, "undo");
        host.setStatus(`<span style="color:var(--copper)">${esc(label)} — 오류가 늘어(${m.nerrors} 건) 되돌렸습니다</span>`);
        return;
      }
      host.setStatus(`<span>${esc(label)} — DRC/LVS ${m.nerrors} 건${d} · ${m.secs.toFixed(2)} s</span>`);
    } catch (e) {
      rt.err = e.message;
      host.setStatus(`<span style="color:var(--copper)">${esc(label)} 실패 — ${esc(e.message)}</span>`);
      console.error("[배선 편집]", e);
    } finally { rt.busy = false; render(); host.redraw(); }
  }
  async function replay(entry, dir) {
    const edits = dir === "undo" ? entry.before : entry.after;
    rt.busy = true; render();
    try {
      const m = await host.routeSend({ kind: "recheck", edits });
      rt.expect = true;
      host.applyRouted(m);
      rt.frozen = new Set(dir === "undo" ? entry.frozenBefore : entry.frozenAfter);
      host.refreshDownloads?.();
      host.setStatus(`<span>${dir === "undo" ? "되돌림" : "다시 실행"} — DRC/LVS ${m.nerrors} 건</span>`);
    } catch (e) { host.setStatus(`<span style="color:var(--copper)">되돌리기 실패 — ${esc(e.message)}</span>`); }
    finally { rt.busy = false; render(); host.redraw(); }
  }
  function routeUndo() { if (!rt.hist.length || rt.busy) return; const en = rt.hist.pop(); rt.fut.push(en); replay(en, "undo"); }
  function routeRedo() { if (!rt.fut.length || rt.busy) return; const en = rt.fut.pop(); rt.hist.push(en); replay(en, "redo"); }

  function commitSlide(net, g) {
    const before = [pathOf(net)], frozenBefore = new Set(rt.frozen);
    rt.graphs.set(net, g);
    rt.frozen.add(net);
    sendEdits([{ net, ...toNode(g) }], { before, frozenBefore, label: "조각 옮기고 재검사" });
  }
  /** 정돈 — 위상은 그대로, 조각마다 범위 안에서 길이가 가장 짧아지는 트랙으로 (src/edit/compact.mjs).
   *  오류가 늘면 되돌린다. */
  function compact(all) {
    if (!rt.model || rt.busy) return;
    const nets = all ? [...rt.graphs.keys()] : rt.net ? [rt.net] : [];
    if (!nets.length) return;
    const r = all ? compactAll(rt.model, rt.graphs) : compactNet(rt.model, rt.graphs, rt.net);
    const changed = r.nets.filter((q) => q.moves > 0);
    if (!changed.length) { host.setStatus(`<span>정돈 — ${all ? "전부" : rt.net} 이미 짧습니다</span>`); return; }
    const before = changed.map((q) => pathOf(q.net)), frozenBefore = new Set(rt.frozen);
    for (const q of changed) { rt.graphs.set(q.net, q.g); rt.frozen.add(q.net); }
    const errsBefore = rt.nerr;
    sendEdits(changed.map((q) => ({ net: q.net, ...toNode(q.g) })),
              { before, frozenBefore, label: `정돈 (${all ? changed.length + " 넷" : rt.net}, 길이 ${fmt(S2(r.before))} -> ${fmt(S2(r.after))})`,
                acceptIf: errsBefore == null ? null : (m) => m.nerrors <= errsBefore });
  }
  /** 고른 조각을 한 트랙 옮긴다 (화살표) */
  function nudgeSeg(sign) {
    if (!rt.net || !rt.seg || rt.busy) return;
    const r = rangeOf(rt.net, rt.seg);
    rt.range = r;
    if (r.locked) { hintRoute(); return; }
    const i = r.tracks.indexOf(rt.seg.t), t = r.tracks[i + sign];
    if (t === undefined) return;
    const g = cloneGraph(rt.graphs.get(rt.net));
    slide(g, g.segs[rt.seg.id], t);
    const id = rt.seg.id;
    commitSlide(rt.net, g);
    rt.seg = g.segs[id];
  }
  function toggleFrozen() {
    if (!rt.net) return;
    if (rt.frozen.has(rt.net)) rt.frozen.delete(rt.net); else rt.frozen.add(rt.net);
    render();
  }
  /** 이 넷만 다시 배선 — 나머지 넷은 지금 경로 그대로 고정 */
  function rerouteNet() {
    if (!rt.net || rt.busy) return;
    const frozen = allPaths().filter((q) => q.net !== rt.net);
    sendEdits(null, { before: allPaths(), msg: { kind: "reroute", frozen }, label: `${rt.net} 만 다시 배선` });
  }
  /** 고정 넷은 그대로, 나머지 다시 배선 */
  function rerouteOthers() {
    if (rt.busy) return;
    const frozen = allPaths().filter((q) => rt.frozen.has(q.net));
    sendEdits(null, { before: allPaths(), msg: { kind: "reroute", frozen }, label: `고정 ${frozen.length} 넷 빼고 다시 배선` });
  }
  /** 이 넷을 배선기가 낸 경로로 */
  function restoreNet() {
    if (!rt.net || rt.busy) return;
    const before = [pathOf(rt.net)], frozenBefore = new Set(rt.frozen);
    rt.frozen.delete(rt.net);
    sendEdits([{ net: rt.net, restore: true }], { before, frozenBefore, label: `${rt.net} 원래 배선으로` });
  }

  function drawRoute(ctx, panel, m) {
    if (!rt.model) return;
    const pal = state().pal;
    const g = rt.drag?.kind === "slide" ? rt.drag.g : rt.net ? rt.graphs.get(rt.net) : null;
    if (!g) return;
    ctx.save();
    ctx.beginPath(); ctx.rect(panel.x, panel.y, panel.w, panel.h); ctx.clip();
    if (rt.drag?.kind === "slide") {
      // 허용 띠와 트랙 눈금
      const d = rt.drag, v = d.s.dir === "v", lo = S2(d.r.lo), hi = S2(d.r.hi);
      ctx.fillStyle = pal.axis; ctx.globalAlpha = 0.1;
      if (v) ctx.fillRect(m.X(lo), m.Y(S2(d.s.hi)) - 8, Math.max(2, (hi - lo) * m.S), S2(d.s.hi - d.s.lo) * m.S + 16);
      else ctx.fillRect(m.X(S2(d.s.lo)) - 8, m.Y(hi), S2(d.s.hi - d.s.lo) * m.S + 16, Math.max(2, (hi - lo) * m.S));
      ctx.globalAlpha = 0.5; ctx.strokeStyle = pal.axis; ctx.lineWidth = 1;
      for (const t of d.r.tracks) {
        ctx.beginPath();
        if (v) { ctx.moveTo(m.X(S2(t)), m.Y(S2(d.s.hi)) - 8); ctx.lineTo(m.X(S2(t)), m.Y(S2(d.s.hi))); }
        else { ctx.moveTo(m.X(S2(d.s.lo)) - 8, m.Y(S2(t))); ctx.lineTo(m.X(S2(d.s.lo)), m.Y(S2(t))); }
        ctx.stroke();
      }
    }
    for (const q of g.segs) {
      const r = segRect(q).map(S2), sel = rt.seg && q.id === rt.seg.id;
      const x = m.X(r[0]), y = m.Y(r[3]), w = Math.max(1, (r[2] - r[0]) * m.S), h = Math.max(1, (r[3] - r[1]) * m.S);
      if (rt.drag?.kind === "slide") { ctx.fillStyle = pal.ours; ctx.globalAlpha = 0.35; ctx.fillRect(x, y, w, h); }
      ctx.globalAlpha = 0.9; ctx.strokeStyle = sel ? pal.ours : pal.axis; ctx.lineWidth = sel ? 2.5 : 1.2;
      ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    }
    ctx.globalAlpha = 0.9; ctx.fillStyle = pal.axis;
    for (const jv of g.vias) ctx.fillRect(m.X(S2(jv.x)) - 3, m.Y(S2(jv.y)) - 3, 6, 6);
    ctx.restore();
  }

  // ---------------------------------------------------------------- 카드
  const card = host.card, wrap = host.cardWrap ?? host.card;
  function render() {
    if (!card) return;
    if (!mode) { wrap.hidden = true; return; }
    wrap.hidden = false;
    const w = what();
    if (w === "place") card.innerHTML = placeCard();
    else if (w === "route") card.innerHTML = routeCard();
    else card.innerHTML = '<p class="dim" style="margin:0;color:var(--muted)">Placement 나 Routing 보기에서 편집합니다.</p>';
  }
  function placeCard() {
    if (!pl.model) return `<p style="margin:0;color:var(--muted)">${esc(pl.err ?? "Placement 를 실행하면 편집할 수 있습니다.")}</p>`;
    const live = pl.live, m = live.m, ours = state().ours;
    const base = ours?.base ?? { area: ours?.area, hpwl: ours?.hpwl };
    const sel = [...pl.sel];
    const rows = [];
    rows.push(`<div class="editrow"><span class="lab">상태</span><span>${pl.dirty ? '<b style="color:var(--copper)">정리 전</b>' : "정리됨"} · 편집 ${pl.edits} 회 · 겹침 ${live.overlap.pairs} 쌍 · Order 위반 ${m.orderBad.length} · 격자 밖 ${m.offgrid}</span></div>`);
    rows.push(`<div class="editrow"><span class="lab">지표</span><span>HPWL ${fmt(m.hpwl)} <small>(배치기 ${base.hpwl ? (m.hpwl / base.hpwl).toFixed(3) + "x" : "—"})</small> · 면적 ${base.area ? (m.area / base.area).toFixed(3) + "x" : "—"}</span></div>`);
    if (sel.length === 1) {
      const nm = sel[0], i = pl.model.idx.get(nm), vc = variantChoices(pl.model, nm), ff = flipFreedom(pl.model, nm);
      const opts = vc.choices.map((c) => `<option value="${esc(c.concrete)}"${c.concrete === vc.current ? " selected" : ""}>${esc(short(c.concrete))} ${Math.round(c.w)}×${Math.round(c.h)}</option>`).join("");
      rows.push(`<div class="editrow"><span class="lab">블록</span><span><b>${esc(nm)}</b> · ${esc(pl.model.design.instances.find((v) => v.name === nm)?.abstract ?? "")}${vc.members.length > 1 ? ` · 거울 쌍 ${esc(vc.members.filter((q) => q !== nm).join(" "))}` : ""}</span></div>`);
      rows.push(`<div class="editrow"><span class="lab">변이</span><span><select data-act="variant" data-name="${esc(nm)}"${vc.choices.length > 1 ? "" : " disabled"}>${opts}</select>${pl.pinned.has(nm) ? ` <button data-act="unpin" data-name="${esc(nm)}" title="Placement 실행 때 이 변이를 고정하지 않는다">고정 해제</button>` : ""}</span></div>`);
      rows.push(`<div class="editrow"><span class="lab">반전</span><span><button data-act="flipx"${ff.xFree ? "" : " disabled"} title="${ff.xFree ? "x 반전 (F)" : "제약에 묶여 있다"}">x ${pl.sx[i] > 0 ? "+" : "−"}</button> <button data-act="flipy"${ff.yFree ? "" : " disabled"} title="${ff.yFree ? "y 반전 (V)" : "제약에 묶여 있다"}">y ${pl.sy[i] > 0 ? "+" : "−"}</button> <button data-act="lock" title="잠근 블록은 끌리지 않고 정리 때도 그 자리 (L)">${pl.locked.has(nm) ? "잠금 해제" : "잠금"}</button></span></div>`);
      rows.push(`<div class="editrow"><span class="lab">자리</span><span>x ${fmt(live.rects[i].x)} y ${fmt(live.rects[i].y)} · ${Math.round(live.rects[i].w)}×${Math.round(live.rects[i].h)}</span></div>`);
    } else if (sel.length > 1) {
      rows.push(`<div class="editrow"><span class="lab">고른 것</span><span>${sel.length} 개 · <button data-act="swap"${sel.length === 2 ? "" : " disabled"} title="두 블록의 자리를 바꾼다 (S)">자리 바꾸기</button> <button data-act="lock">잠금/해제</button> <button data-act="flipx">x 반전</button> <button data-act="flipy">y 반전</button></span></div>`);
    } else {
      rows.push(`<div class="editrow"><span class="lab">고르기</span><span style="color:var(--muted)">블록을 클릭하고 끌어 옮깁니다. Shift 로 여럿, Alt 로 그룹째, 축 핸들(마젠타)로 대칭 그룹 전체.</span></div>`);
    }
    if (pl.pinned.size) {
      const seen = new Set(), items = [];
      for (const [nm, c] of pl.pinned) { if (seen.has(c + nm)) continue; seen.add(c + nm); items.push(`${esc(nm)} <small>${esc(short(c))}</small> <button data-act="unpin" data-name="${esc(nm)}" title="고정 해제">×</button>`); }
      rows.push(`<div class="editrow"><span class="lab">고정 변이</span><span>${items.join(" · ")}<br><small style="color:var(--muted)">다음 Placement 실행도 이 변이를 씁니다 (나머지는 배치기가 고른다)</small></span></div>`);
    }
    rows.push(`<div class="editrow"><span class="lab">정리</span><span>` +
      `<button class="run" data-act="settle" title="편집 좌표의 쌍 관계(위상)를 그대로 두고 겹침을 없애고 격자에 앉힌다 (Enter)"${pl.busy ? " disabled" : ""}>정리 (위상 유지)</button> ` +
      `<button data-act="retry" title="정리한 뒤 같은 위상에서 변이를 전수로 다시 고른다 — 고정한 변이는 그대로"${pl.busy ? " disabled" : ""}>위상 유지 최적화</button> ` +
      `<button data-act="reflip" title="좌표는 그대로, 반전만 다시 고른다">반전 다시</button></span></div>`);
    rows.push(`<div class="editrow"><span class="lab">압축</span><span><input type="range" data-act="compact" min="0" max="20" step="1" value="${Math.round(pl.compact * 10)}" style="width:120px;vertical-align:middle"> <b id="editCompact">${pl.compact.toFixed(1)}</b> <small style="color:var(--muted)">0 손댄 것만 · 0.5 배치기 기본</small> · <label><input type="checkbox" data-act="both"${pl.both ? " checked" : ""}> 관계 둘 다 <small style="color:var(--muted)">(덜 움직이고 덜 압축)</small></label></span></div>`);
    rows.push(`<div class="editrow"><span class="lab">이력</span><span><button data-act="undo"${pl.hist.length ? "" : " disabled"} title="Z">되돌리기</button> <button data-act="redo"${pl.fut.length ? "" : " disabled"} title="Y">다시 실행</button> <button data-act="revert" title="배치기가 낸 배치로 되돌린다 (고정 변이는 남는다)">원래 배치로</button></span></div>`);
    if (pl.ranking) {
      const cur = state().ours;
      const tr = pl.ranking.map((r, k) => `<tr><td class="dim">${k + 1}</td><td class="dim">${Math.round(r.bbox[2])}×${Math.round(r.bbox[3])}</td><td class="dim">${fmt(r.hpwl)}</td><td class="dim">${(r.score - (pl.ranking.find((q) => q.current)?.score ?? r.score)).toFixed(3)}</td><td>${r.current ? "<small>지금 배정</small>" : `<button data-act="apply" data-k="${k}">적용</button>`}</td></tr>`).join("");
      rows.push(`<div class="editrow"><span class="lab">순위</span><span><table class="rank"><thead><tr><th></th><th>bbox</th><th>HPWL</th><th>점수 차</th><th></th></tr></thead><tbody>${tr}</tbody></table></span></div>`);
      void cur;
    }
    rows.push(`<div class="editrow help"><span class="lab">키</span><span style="color:var(--muted)">화살표 한 격자 (Shift 열 격자) · F/V 반전 · L 잠금 · S 자리 바꾸기 · Enter 정리 · Z/Y 되돌리기 · Esc 고르기 해제</span></div>`);
    return rows.join("");
  }
  function routeCard() {
    const geo = state().routed;
    if (!geo || !rt.model) return '<p style="margin:0;color:var(--muted)">Routing 을 실행하면 넷을 고르고 조각을 옮길 수 있습니다.</p>';
    const rows = [];
    const busy = rt.busy ? " disabled" : "";
    const n = rt.net ? rt.model.nets.find((q) => q.name === rt.net) : null, g = rt.net ? rt.graphs.get(rt.net) : null;
    if (n && g) {
      rows.push(`<div class="editrow"><span class="lab">넷</span><span><b>${esc(n.name)}</b>${n.port ? " · 포트" : ""} · 핀 ${n.pins.length} · 조각 ${g.segs.length} · 비아 ${g.vias.length} · 길이 ${fmt(S2(netLength(g)))}${rt.frozen.has(n.name) ? ' · <b style="color:var(--copper)">고정</b>' : ""}</span></div>`);
      if (rt.seg) {
        const r = rt.range ?? rangeOf(rt.net, rt.seg);
        rows.push(`<div class="editrow"><span class="lab">조각</span><span>${esc(rt.seg.layer)} 트랙 ${fmt(S2(rt.seg.t))} · 스팬 ${fmt(S2(rt.seg.lo))}~${fmt(S2(rt.seg.hi))} · 비아 ${rt.seg.joints.length}${rt.seg.pins.length ? " · 핀 위" : ""}<br><small style="color:var(--muted)">${r.locked ? "못 옮긴다: " + esc(r.why) : `옮길 트랙 ${r.tracks.length} 개 [${fmt(S2(r.lo))}, ${fmt(S2(r.hi))}] — 끌거나 화살표`}${r.why && !r.locked ? " · " + esc(r.why) : ""}</small></span></div>`);
      } else rows.push(`<div class="editrow"><span class="lab">조각</span><span style="color:var(--muted)">이 넷의 조각을 클릭하면 옮길 수 있는 범위가 보입니다 (층의 수직 방향으로만)</span></div>`);
      rows.push(`<div class="editrow"><span class="lab">이 넷</span><span><button data-act="rfreeze"${busy} title="고정한 넷은 다시 배선할 때 그대로 둔다 (F)">${rt.frozen.has(n.name) ? "고정 해제" : "고정"}</button> <button data-act="rnet"${busy} title="나머지 넷은 지금 경로 그대로 두고 이 넷만 배선기에 다시 맡긴다 (R)">이 넷만 다시 배선</button> <button data-act="rcompact"${busy} title="위상(조각·비아·핀 접속)은 그대로 두고 조각을 범위 안에서 미끄러뜨려 길이를 줄인다. 오류가 늘면 되돌린다 (C)">정돈</button> <button data-act="rrestore"${busy} title="배선기가 낸 경로로 되돌린다">원래 배선으로</button></span></div>`);
    } else {
      rows.push(`<div class="editrow"><span class="lab">넷</span><span style="color:var(--muted)">도형을 클릭하면 그 넷만 밝게 보이고, 다시 그 넷의 조각을 클릭해 끌면 옆 트랙으로 옮깁니다.</span></div>`);
    }
    rows.push(`<div class="editrow"><span class="lab">전체</span><span><button data-act="rothers"${busy} title="고정한 넷(편집한 넷)은 그대로 두고 나머지를 배선기가 다시 배선한다">고정 넷 빼고 다시 배선</button> <button data-act="rcompactall"${busy} title="넷 전부를 차례로 정돈한다 — 위상은 그대로, 오류가 늘면 되돌린다 (Shift+C)">정돈 (전부)</button> <span style="color:var(--muted)">고정 ${rt.frozen.size ? [...rt.frozen].map(esc).join(" ") : "없음"}</span></span></div>`);
    rows.push(`<div class="editrow"><span class="lab">이력</span><span><button data-act="rundo"${rt.hist.length && !rt.busy ? "" : " disabled"} title="Z">되돌리기</button> <button data-act="rredo"${rt.fut.length && !rt.busy ? "" : " disabled"} title="Y">다시 실행</button>` +
              (rt.baseErrors != null ? ` <small style="color:var(--muted)">DRC/LVS ${rt.nerr ?? "?"} 건 · 배선기 결과 ${rt.baseErrors} 건</small>` : "") + `</span></div>`);
    rows.push(`<div class="editrow help"><span class="lab">키</span><span style="color:var(--muted)">화살표 한 트랙 · F 고정 · R 이 넷만 다시 배선 · C 정돈 (Shift+C 전부) · Z/Y 되돌리기 · Esc 고르기 해제</span></div>`);
    return rows.join("");
  }
  card?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b || b.tagName === "SELECT" || b.tagName === "INPUT" || b.tagName === "LABEL") return;
    const act = b.dataset.act;
    if (act === "settle") settleNow();
    else if (act === "retry") retry();
    else if (act === "reflip") reflip();
    else if (act === "flipx") flip("x");
    else if (act === "flipy") flip("y");
    else if (act === "lock") toggleLock();
    else if (act === "swap") swap();
    else if (act === "undo") undo();
    else if (act === "redo") redo();
    else if (act === "revert") revert();
    else if (act === "unpin") unpin(b.dataset.name);
    else if (act === "apply") { const r = pl.ranking?.[Number(b.dataset.k)]; if (r?.out) { pushHistory(); applyOut(r.out); } }
    else if (act === "rfreeze") toggleFrozen();
    else if (act === "rnet") rerouteNet();
    else if (act === "rrestore") restoreNet();
    else if (act === "rothers") rerouteOthers();
    else if (act === "rcompact") compact(false);
    else if (act === "rcompactall") compact(true);
    else if (act === "rundo") routeUndo();
    else if (act === "rredo") routeRedo();
  });
  card?.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.act === "variant") setVariant(t.dataset.name, t.value);
    else if (t.dataset.act === "both") { pl.both = t.checked; }
  });
  card?.addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset.act === "compact") { pl.compact = Number(t.value) / 10; const b = card.querySelector("#editCompact"); if (b) b.textContent = pl.compact.toFixed(1); }
  });

  // ---------------------------------------------------------------- 키
  function onKey(e) {
    if (!mode || !applicable()) return false;
    const tag = e.target?.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return false;
    if (what() !== "place") {
      const k = e.key;
      if (k === "Escape") { if (rt.seg) rt.seg = null; else rt.net = null; rt.range = null; render(); host.redraw(); }
      else if (k === "ArrowLeft" || k === "ArrowDown") { if (rt.seg && ((rt.seg.dir === "v") === (k === "ArrowLeft"))) nudgeSeg(-1); else return false; }
      else if (k === "ArrowRight" || k === "ArrowUp") { if (rt.seg && ((rt.seg.dir === "v") === (k === "ArrowRight"))) nudgeSeg(+1); else return false; }
      else if (k === "f" || k === "F") toggleFrozen();
      else if (k === "r" || k === "R") rerouteNet();
      else if (k === "c" || k === "C") compact(e.shiftKey);
      else if ((k === "z" || k === "Z") && (e.ctrlKey || e.metaKey) && e.shiftKey) routeRedo();
      else if (k === "z" || k === "Z") routeUndo();
      else if (k === "y" || k === "Y") routeRedo();
      else return false;
      e.preventDefault();
      return true;
    }
    const k = e.key, ctrl = e.ctrlKey || e.metaKey;
    const [gx, gy] = pl.model?.grid ?? [80, 84];
    const mul = e.shiftKey ? 10 : 1;
    if (k === "ArrowLeft") nudge(-gx * mul, 0);
    else if (k === "ArrowRight") nudge(gx * mul, 0);
    else if (k === "ArrowUp") nudge(0, gy * mul);
    else if (k === "ArrowDown") nudge(0, -gy * mul);
    else if ((k === "z" || k === "Z") && ctrl && e.shiftKey) redo();
    else if ((k === "z" || k === "Z")) undo();
    else if (k === "y" || k === "Y") redo();
    else if (k === "f" || k === "F") flip("x");
    else if (k === "v" || k === "V") flip("y");
    else if (k === "l" || k === "L") toggleLock();
    else if (k === "s" || k === "S") swap();
    else if (k === "Enter") settleNow();
    else if (k === "Escape") { pl.sel = new Set(); render(); host.redraw(); }
    else return false;
    e.preventDefault();
    return true;
  }

  // ---------------------------------------------------------------- 밖에서 부르는 것
  const editor = {
    get active() { return mode && applicable(); },
    get mode() { return mode; },
    setMode(on) {
      mode = !!on;
      if (!mode) { pl.sel = new Set(); pl.drag = null; pl.hover = null; rt.net = null; }
      render(); host.onModeChange?.(mode); host.redraw();
    },
    viewChanged() { pl.drag = null; rt.drag = null; render(); },
    setMap(map) { mapNow = map; },
    liveData,
    focus: () => (mode && what() === "route" && rt.net ? new Set([rt.net]) : null),
    fixedVariants,
    placed: (done) => { pl.orig = done; placedKeepPins(done); },
    routed: (m) => routedNow(m),
    isDirty: () => pl.dirty,
    onPointerDown(e, px, py) {
      if (!this.active) return false;
      return what() === "place" ? placeDown(e, px, py) : routeDown(e, px, py);
    },
    onPointerMove(e, px, py) {
      if (!this.active) return false;
      return what() === "place" ? placeMove(e, px, py) : routeMove(e, px, py);
    },
    onPointerUp(e, px, py) {
      if (!this.active) { pl.drag = null; rt.drag = null; return false; }
      return what() === "place" ? placeUp(e, px, py) : routeUp(e, px, py);
    },
    onKey,
    draw(ctx, panel, m) {
      if (!mode) return;
      if (what() === "place") drawPlace(ctx, panel, m);
      else if (what() === "route") drawRoute(ctx, panel, m);
    },
    state: { pl, rt },      // 검사(test/edit-page.mjs)가 들여다본다
    /** 검사용: 블록의 화면 좌표(캔버스 CSS px)와 지금 변환 */
    probe: {
      map: () => mapNow,
      rectPx(name) {
        const r = pl.live?.rects.find((q) => q.name === name), m = mapNow?.m;
        if (!r || !m) return null;
        return { x: m.X(r.x), y: m.Y(r.y + r.h), w: r.w * m.S, h: r.h * m.S, cx: m.X(r.x + r.w / 2), cy: m.Y(r.y + r.h / 2) };
      },
      axisPx(k) {
        const a = pl.live?.axes.find((q) => q.k === k), m = mapNow?.m, bb = state().ours?.bbox;
        if (!a || !m || !bb) return null;
        return { x: a.vert ? m.X(a.at) : m.X(bb[2]) - 8, y: a.vert ? m.Y(bb[3]) + 8 : m.Y(a.at) };
      },
      /** 검사용: 넷마다 조각의 화면 좌표와 옮길 범위 */
      segmentsPx(net = null) {
        const m = mapNow?.m;
        if (!m || !rt.model) return [];
        const out = [];
        for (const [name, g] of rt.graphs) {
          if (net && name !== net) continue;
          const world = worldShapes(rt.model, rt.graphs, name);
          for (const q of g.segs) {
            const r = segRect(q).map(S2), rg = range(g, q, world, rt.model.bbox);
            out.push({ net: name, id: q.id, layer: q.layer, dir: q.dir, t: q.t, cx: m.X((r[0] + r[2]) / 2), cy: m.Y((r[1] + r[3]) / 2),
                       w: (r[2] - r[0]) * m.S, h: (r[3] - r[1]) * m.S, S: m.S, locked: rg.locked, tracks: rg.tracks, why: rg.why });
          }
        }
        return out;
      },
    },
  };
  return editor;
}
