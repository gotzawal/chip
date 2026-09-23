/** 검사기 대조용 고정 사례 — 바탕 모듈 하나에 망가뜨리는 조작을 얹는다.
 *
 *  symplace/web/placer/fixtures/check-<이름>.json
 *    { format: "check-fixture/1", source,
 *      base:    { rows: [[layer, netName, netType, x0, y0, x1, y1], ...], subinsts, netsAllowedToBeOpen, postprocess },
 *      cases:   [{ label, ops: [...], netsAllowedToBeOpen?, postprocess? }],
 *      results: [ 파이썬 답 (summarize 꼴) ] }
 *
 *  조작 (i 는 바탕 rows 의 번호)
 *    {op:"net", i, net}      넷 이름을 바꾼다 (null 이면 지운다, "<inst>:<pin>" 이면 단자)
 *    {op:"type", i, type}    netType 을 바꾼다
 *    {op:"del", i}           지운다
 *    {op:"move", i, dx, dy}  민다
 *    {op:"rect", i, rect}    사각형을 바꾼다
 *    {op:"add", row}         더한다
 *
 *  조작과 파이썬 답은 ALIGN 의 파이썬 검사기로 한 번 뽑아 박아 둔 것이다
 *  (뽑은 도구 scripts/route/node/mutate.mjs·checkref.mjs 는 걷어냈다 — 커밋 6655430 에 있다).
 */
import crypto from "node:crypto";

export const FIXTURE_FORMAT = "check-fixture/1";

const toTerm = ([layer, netName, netType, x0, y0, x1, y1]) => ({ layer, netName, netType, rect: [x0, y0, x1, y1] });

/** 사례 하나를 검사기 입력으로 편다. */
export function expandCase(base, c) {
  const ts = base.rows.map(toTerm);
  const dead = new Set(), extra = [];
  for (const op of c.ops) {
    const t = ts[op.i];
    if (op.op === "net") t.netName = op.net;
    else if (op.op === "type") t.netType = op.type;
    else if (op.op === "del") dead.add(op.i);
    else if (op.op === "move") t.rect = [t.rect[0] + op.dx, t.rect[1] + op.dy, t.rect[2] + op.dx, t.rect[3] + op.dy];
    else if (op.op === "rect") t.rect = op.rect.slice();
    else if (op.op === "add") extra.push(toTerm(op.row));
    else throw new Error("모르는 조작: " + op.op);
  }
  return {
    label: c.label,
    terminals: [...ts.filter((_, i) => !dead.has(i)), ...extra],
    subinsts: base.subinsts,
    netsAllowedToBeOpen: c.netsAllowedToBeOpen ?? base.netsAllowedToBeOpen,
    postprocess: c.postprocess ?? base.postprocess,
  };
}

/** 열쇠 순서와 무관한 직렬화. */
export const canon = (x) => JSON.stringify(x, (k, v) =>
  v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((q) => [q, v[q]])) : v);

/** 정리된 도형 목록의 지문 — 고정 사례에는 도형 대신 이것만 둔다. */
export const digest = (terminals) =>
  crypto.createHash("sha256").update(terminals.map(canon).join("\n")).digest("hex").slice(0, 20);

/** JS check() 결과 -> 비교할 기록 (고정 사례의 파이썬 답과 같은 꼴). */
export function summarize(r) {
  return {
    shorts: r.shorts, opens: r.opens,
    differentWidths: r.differentWidths.map((w) => ({ msg: w.msg, indices: w.indices, v: w.v })),
    drc: r.drc, post: r.post,
    nOut: r.terminals.length, out: digest(r.terminals),
  };
}
