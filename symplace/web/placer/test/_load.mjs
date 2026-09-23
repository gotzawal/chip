/** 앞단 출력 폴더(1_topology + 2_primitives 를 한데 모은 것)를 Design 으로 읽는다.
 *  node 전용(fs). 브라우저에서는 fetch 로 같은 JSON 셋을 모아 readDesign 에 준다.
 */
import fs from "node:fs";
import path from "node:path";
import { readDesign } from "../../../../src/design.mjs";
import { baseline } from "../../../../src/baseline.mjs";

const J = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

export function loadDesign(dir) {
  const files = fs.readdirSync(dir);
  const vname = files.find((f) => f.endsWith(".verilog.json"));
  if (!vname) throw new Error(dir + ": *.verilog.json 이 없다");
  const topology = J(path.join(dir, vname));
  const primitives = J(path.join(dir, "__primitives__.json"));
  const templates = {};
  for (const c of Object.keys(primitives)) {
    const p = path.join(dir, c + ".json");
    if (fs.existsSync(p)) templates[c] = J(p);
  }
  return {
    topology, primitives, templates,
    design: readDesign({ topology, primitives, templates }),
    // ALIGN 배치 결과는 **대조용**이다. 배치에는 쓰지 않는다.
    place: files.includes("__align_place__.json")
      ? J(path.join(dir, "__align_place__.json")) : null,
  };
}

/** ALIGN 의 place 결과에서 기준선(면적, HPWL)을 직접 잰다.
 *  페이지가 쓰는 src/baseline.mjs 와 같은 자다 — 핀 경계 사각형으로 잰 HPWL.
 *  (고정값 파일에는 기대지 않는다: export-fixtures.py 는 `<예제>_ours` 를 먼저
 *  찾으므로 거기 든 좌표가 ALIGN 이 아닐 수 있다.)
 */
export function alignBaseline(place, topName) {
  const b = baseline(place, topName);
  const top = place.modules.find((m) => m.abstract_name === topName)
           ?? place.modules[place.modules.length - 1];
  return { area: b.area, hpwl: b.hpwl, bbox: b.bbox, top };
}
