/** 계층 다루기 — 배선이 보는 모듈 구조.
 *
 *  ALIGN 의 배선 단계는 1_topology 의 계층을 그대로 쓰지 않는다. prep 단계가
 *  manipulate_hierarchy (align/pnr/manipulate_hierarchy.py) 로 **전원 포트를 걷어낸다**:
 *
 *    - 최상위 포트에서 전역 신호(global_signals: VCC, VSS ...)를 뺀다
 *    - 전역 신호에 물린 하위 모듈 포트를 인스턴스에서 떼고, 그 포트를 뺀 사본 모듈
 *      <이름>_PG<i> 를 만들어 인스턴스가 그걸 가리키게 한다 (포트 목록이 같으면 사본을 같이 쓴다)
 *    - 사본 안에서는 그 포트에 물린 리프 핀이 전역 넷에 직접 물린다
 *
 *  그래서 하위 모듈 안의 리프 전원 핀은 "P0" 가 아니라 "VSS" 로 읽힌다. 도형 합성의 넷 이름,
 *  "열려도 되는 넷", SymmetricNets 의 핀 참조가 모두 이 구조를 기준으로 한다.
 */

const clone = (x) => JSON.parse(JSON.stringify(x));

/** manipulate_hierarchy 의 remove_pg_pins + clean_if_extra. 입력은 건드리지 않는다. */
export function pgHierarchy(topology, top) {
  const modules = clone(topology.modules);
  const pg = new Map((topology.global_signals ?? []).map((g) => [g.actual, g.actual]));
  removePgPins(modules, top, pg);
  const used = new Set([top, ...modules.flatMap((m) => m.instances.map((i) => i.abstract_template_name))]);
  return { modules: modules.filter((m) => used.has(m.name)), global_signals: clone(topology.global_signals ?? []) };
}

function removePgPins(modules, subckt, pgConn) {
  const params = new Map(modules.map((m) => [m.name, m.parameters]));
  const name = params.has(subckt) ? subckt : params.has(subckt.toUpperCase()) ? subckt.toUpperCase() : null;
  if (!name) throw new Error(`${subckt} 가 설계에 없다`);
  const found = modules.filter((m) => m.name === name);
  if (found.length !== 1) throw new Error(`${name} 가 여러 번 정의돼 있다`);
  const module = found[0];
  module.parameters = module.parameters.filter((p) => !pgConn.has(p));
  for (const inst of module.instances) {
    if (params.has(inst.abstract_template_name)) {
      const hier = new Map(inst.fa_map.filter((c) => pgConn.has(c.actual)).map((c) => [c.formal, pgConn.get(c.actual)]));
      if (hier.size) {
        inst.fa_map = inst.fa_map.filter((c) => !hier.has(c.formal));
        const nn = pgCopy(modules, inst.abstract_template_name, hier);
        inst.abstract_template_name = nn;
        removePgPins(modules, nn, hier);
      }
    } else {
      inst.fa_map = inst.fa_map.map((c) => ({ formal: c.formal, actual: pgConn.get(c.actual) ?? c.actual }));
    }
  }
}

/** modify_pg_conn_subckt — 포트를 뺀 사본. 같은 포트 목록의 사본이 이미 있으면 그걸 쓴다. */
function pgCopy(modules, subckt, pp) {
  const nm = clone(modules.find((m) => m.name === subckt));
  nm.parameters = nm.parameters.filter((p) => !pp.has(p));
  const params = new Map(modules.map((m) => [m.name, m.parameters]));
  for (let i = 0; ; i++) {
    const cand = `${subckt}_PG${i}`;
    if (!params.has(cand)) { nm.name = cand; modules.push(nm); return cand; }
    if (JSON.stringify(params.get(cand)) === JSON.stringify(nm.parameters)) return cand;
  }
}

/** 아무 데도 인스턴스로 안 쓰이는 모듈이 최상위다. */
export function topModule(topology) {
  const used = new Set(topology.modules.flatMap((m) => m.instances.map((i) => i.abstract_template_name)));
  const tops = topology.modules.filter((m) => !used.has(m.name));
  if (tops.length !== 1) throw new Error(`최상위 모듈이 ${tops.length} 개다: ${tops.map((m) => m.name).join(", ")}`);
  return tops[0];
}

/** ALIGN 의 배치 결과(scaled_placement_verilog — data/<예제>.json 의 place)를 배선이 받는 배치 모양으로.
 *  예제 파일에 늘 들어 있으므로 캐시 없이 배선 경로를 시험할 수 있다. */
export function placementFromAlign(place) {
  const used = new Set(place.modules.flatMap((m) => m.instances.map((i) => i.concrete_template_name)));
  const tops = place.modules.filter((m) => !used.has(m.concrete_name));
  if (tops.length !== 1) throw new Error(`ALIGN 배치의 최상위가 ${tops.length} 개다`);
  const inst = (i) => ({ name: i.instance_name, concrete: i.concrete_template_name,
                         oX: i.transformation.oX, oY: i.transformation.oY, sX: i.transformation.sX, sY: i.transformation.sY });
  return {
    bbox: tops[0].bbox.slice(),
    instances: tops[0].instances.map(inst),
    subModules: place.modules.filter((m) => m !== tops[0]).map((m) => ({
      abstract: m.abstract_name, concrete: m.concrete_name, bbox: m.bbox.slice(), instances: m.instances.map(inst) })),
  };
}
