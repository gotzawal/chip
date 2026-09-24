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
  // ---------------------------------------------------------------- 배선 편집 상태 (R1~R3 에서 채운다)
  const rt = { wires: null, net: null, seg: null, frozen: new Set(), hist: [], fut: [], err: null };

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

  // ---------------------------------------------------------------- 배선: 넷 고르기 (조각 편집은 R1~R3)
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
  function routeDown(e, px, py) {
    const p = toLayout(px, py);
    if (!p) return false;
    const nm = hitNet(p.x, p.y);
    rt.drag = { x0: px, y0: py, net: nm };
    return false;                                  // 이동은 그대로 (끌면 이동, 안 끌면 고르기)
  }
  function routeUp(e, px, py) {
    const d = rt.drag; rt.drag = null;
    if (!d || Math.hypot(px - d.x0, py - d.y0) >= 3) return false;
    rt.net = d.net === rt.net ? null : d.net;
    render(); host.redraw();
    return true;
  }
  function routeMove(e, px, py) {
    const p = toLayout(px, py);
    const nm = p ? hitNet(p.x, p.y) : null;
    const el = document.getElementById("hint");
    if (el) el.textContent = nm ? `넷 ${nm}` : "";
    return false;
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
    if (!geo) return '<p style="margin:0;color:var(--muted)">Routing 을 실행하면 넷을 고를 수 있습니다.</p>';
    const rows = [];
    rows.push(`<div class="editrow"><span class="lab">넷</span><span>${rt.net ? `<b>${esc(rt.net)}</b> · 도형 ${geo.terminals.filter((t) => t.netName === rt.net).length}` : '<span style="color:var(--muted)">도형을 클릭하면 그 넷만 밝게 보입니다</span>'}</span></div>`);
    rows.push(`<div class="editrow help"><span class="lab">다음</span><span style="color:var(--muted)">조각 옮기기·재검사·넷 고정·재배선은 다음 단계에서 붙습니다 (symplace/PLAN-edit.md R1~R4).</span></div>`);
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
      if (e.key === "Escape") { rt.net = null; render(); host.redraw(); return true; }
      return false;
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
    routed: (m) => { rt.wires = m?.wires ?? null; rt.net = null; render(); },
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
    },
  };
  return editor;
}
