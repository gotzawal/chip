/** SPICE 넷리스트 읽기 — 회로도를 그리는 데 필요한 만큼만.
 *
 *  ALIGN 앞단이 받는 방언을 그대로 받는다: .subckt / .ends, .model, .global, '+' 와 '\' 줄 잇기,
 *  '*' 와 '//' 주석, '$' 뒤 주석, `nf= _par2` 처럼 '=' 앞뒤에 빈칸이 든 파라미터.
 *  소자는 첫 글자로 가른다 — M(트랜지스터) R C L D X(서브서킷) Q. 전원·제어원(V I E F G H K B)은
 *  그리지 않으므로 버린다.
 *
 *  이름과 넷은 **대문자**로 맞춘다. ALIGN 이 그렇게 하므로 앞단 출력(1_topology)의 이름과
 *  맞춰 볼 수 있다 (`circuit.mjs` 의 adoptGroups).
 */

const up = (s) => String(s ?? "").toUpperCase();

/** 줄 잇기와 주석 처리. '+' 로 시작하는 줄은 앞 줄에 붙고, '\' 로 끝나는 줄은 다음 줄과 붙는다. */
function joinLines(text) {
  const out = [];
  let pend = null;
  for (const raw of String(text).split(/\r?\n/)) {
    let l = raw.replace(/\$.*$/, "").replace(/\/\/.*$/, "").trim();
    if (pend != null) { l = pend + " " + l; pend = null; }
    if (l.endsWith("\\")) { pend = l.slice(0, -1); continue; }
    if (!l || l.startsWith("*")) continue;
    if (l.startsWith("+")) {
      if (out.length) out[out.length - 1] += " " + l.slice(1);
      continue;
    }
    out.push(l);
  }
  if (pend != null && pend.trim()) out.push(pend);
  return out;
}

/** 빈칸으로 자르되 `k= v`, `k =v`, `k = v` 를 `k=v` 하나로 붙인다. */
function tokens(line) {
  const raw = line.split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    let t = raw[i];
    if (t === "=" && out.length && i + 1 < raw.length) { out[out.length - 1] += "=" + raw[++i]; continue; }
    if (t.startsWith("=") && out.length) { out[out.length - 1] += t; continue; }
    if (t.endsWith("=") && i + 1 < raw.length) t += raw[++i];
    out.push(t);
  }
  return out;
}

/** `k=v` 토큰들 -> {k: v} (키는 소문자). */
function kv(toks) {
  const o = {};
  for (const t of toks) {
    const k = t.indexOf("=");
    if (k > 0) o[t.slice(0, k).toLowerCase()] = t.slice(k + 1);
  }
  return o;
}

/** 소자 줄 하나 -> { name, type, nets, model, params }. 그리지 않는 소자면 null. */
function device(toks) {
  const c = toks[0][0].toUpperCase();
  const pos = toks.filter((t) => !t.includes("="));
  const params = kv(toks.slice(1));
  const name = up(pos[0]);
  const nets = (a, b) => pos.slice(a, b).map(up);
  switch (c) {
    case "M": {
      // 이름 d g s [b] 모델 — 노드가 넷이 보통이고, 셋이면 벌크 = 소스
      const n = pos.length >= 6 ? 4 : 3;
      const ns = nets(1, 1 + n);
      if (ns.length < 3) return null;
      if (ns.length === 3) ns.push(ns[2]);
      return { name, type: "M", nets: ns, model: pos[1 + n] ?? "", params };
    }
    case "X": {
      if (pos.length < 3) return null;
      return { name, type: "X", nets: nets(1, pos.length - 1), model: up(pos[pos.length - 1]), params };
    }
    case "R": case "C": case "L": case "D": {
      if (pos.length < 3) return null;
      return { name, type: c, nets: nets(1, 3), model: pos[3] ?? "", params };
    }
    case "Q": {
      if (pos.length < 5) return null;
      const n = pos.length >= 6 ? 4 : 3;
      return { name, type: "Q", nets: nets(1, 1 + n), model: pos[1 + n] ?? "", params };
    }
    default:
      return null;
  }
}

/** 아무도 인스턴스로 쓰지 않는 서브서킷이 top 이다. 여럿이면 소자가 (계층을 펼쳐) 가장 많은 것. */
function pickTop(subckts) {
  const used = new Set();
  for (const s of subckts.values())
    for (const d of s.devices) if (d.type === "X") used.add(d.model);
  const cands = [...subckts.keys()].filter((n) => !used.has(n));
  if (!cands.length) return subckts.size ? [...subckts.keys()].at(-1) : null;
  if (cands.length === 1) return cands[0];
  const count = (n, seen = new Set()) => {
    const s = subckts.get(n);
    if (!s || seen.has(n)) return 0;
    seen.add(n);
    let k = 0;
    for (const d of s.devices) k += d.type === "X" ? count(d.model, seen) : 1;
    return k;
  };
  let best = cands[0], bestN = -1;
  for (const c of cands) { const k = count(c); if (k >= bestN) { best = c; bestN = k; } }
  return best;
}

/** 넷리스트 원문 -> { subckts, models, globals, loose, top }.
 *  subckts: Map<이름, { name, ports, devices, params }>, models: Map<모델 이름, 종류>,
 *  globals: .global 넷, loose: .subckt 밖의 소자, top: 최상위 서브서킷 이름. */
export function parseSpice(text) {
  const subckts = new Map();
  const models = new Map();
  const globals = new Set();
  const loose = [];
  let cur = null;
  for (const line of joinLines(text)) {
    const toks = tokens(line);
    if (!toks.length) continue;
    const head = toks[0].toLowerCase();
    if (head.startsWith(".")) {
      if (head === ".subckt") {
        const pos = toks.slice(1).filter((t) => !t.includes("="));
        if (!pos.length) continue;
        cur = { name: up(pos[0]), ports: pos.slice(1).map(up), devices: [], params: kv(toks.slice(1)) };
        subckts.set(cur.name, cur);
      } else if (head === ".ends" || head === ".end") {
        cur = null;
      } else if (head === ".model" && toks.length >= 3) {
        models.set(up(toks[1]), toks[2].toLowerCase());
      } else if (head === ".global") {
        for (const t of toks.slice(1)) globals.add(up(t));
      }
      continue;
    }
    const d = device(toks);
    if (d) (cur ? cur.devices : loose).push(d);
  }
  return { subckts, models, globals, loose, top: pickTop(subckts) };
}

/** 트랜지스터 모델 이름 -> "nmos" | "pmos". .model 선언이 있으면 그것을, 없으면 이름으로 짐작한다. */
export function mosKind(model, models) {
  const m = String(model ?? "").toLowerCase();
  const t = models?.get(up(m));
  if (t) {
    if (/^p/.test(t)) return "pmos";
    if (/^n/.test(t)) return "nmos";
  }
  if (/pfet|pmos|pch/.test(m)) return "pmos";
  if (/nfet|nmos|nch/.test(m)) return "nmos";
  if (/^p/.test(m)) return "pmos";
  if (/^n/.test(m)) return "nmos";
  if (m.includes("p") && !m.includes("n")) return "pmos";
  return "nmos";
}
