/** 예제 파일(data/<이름>.json)을 Design 으로 읽는다. node 전용(fs).
 *
 *  페이지가 fetch 로 읽는 바로 그 파일이다 — {topology, primitives, templates}.
 *  검사와 사이트가 같은 입력을 보므로, 예제를 더 넣거나 고치면 검사가 그것을 그대로 본다.
 *  (예전에는 fixtures/design/ 에 같은 앞단 출력을 펼쳐 두고 따로 읽었다 — 사본이라 갈라질 수 있어 걷어냈다.)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readDesign } from "../../../../src/design.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const J = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

/** data/index.json 에 든 예제 이름들 (페이지의 목록 순서). */
export function exampleNames() {
  return J(path.join(ROOT, "data/index.json")).map((x) => (typeof x === "string" ? x : x.name));
}

export function loadDesign(name) {
  const { topology, primitives, templates } = J(path.join(ROOT, "data", name + ".json"));
  return { topology, primitives, templates, design: readDesign({ topology, primitives, templates }) };
}
