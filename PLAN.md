# 계획 — 깔끔한 재구성과 예제 5 개 추가 (2026-09-23)

이 문서는 두 가지를 적는다. (1) 저장소를 어떤 모양으로 다시 짤 것인가, (2) ALIGN 예제를 다섯 개
더 넣어 열 개로 만들려면 무엇이 필요한가. 둘 다 **지금 도는 것을 한 번도 깨지 않고** 가는 순서로
적었다 — 각 단계가 끝날 때마다 검사가 그대로 통과해야 한다.

## 0. 지금 상태 — 이번 정리에서 한 것

**걷어낸 것** (전부 git 에 있다, 마지막으로 들어 있던 커밋 `0e04d6a`).

| 걷어낸 것 | 왜 |
|---|---|
| `symplace/gpuplace/` 파이썬 배치기, `export-fixtures.py`, `scripts/verify.sh` | 첫 구현. JS 배치기가 변이·반전·영역·계층·WebGPU 까지 가서 그것을 넘어섰고, 파이썬 쪽은 ALIGN 의 place 출력을 읽어 좌표만 덮어쓰는 옛 경로였다. numpy·python-mip 의존이 같이 없어졌다. parity 검사의 고정값은 그대로 둔다 |
| `symplace/web/placer/fixtures/design/` (74 파일), `scripts/route/stage-design.sh` | `data/<예제>.json` 과 같은 앞단 출력을 펼쳐 둔 사본. 검사가 이제 `data/` 를 직접 읽는다 — 사이트와 검사가 같은 입력을 본다 |
| `symplace/PLAN-route.md`, `symplace/NOTES-phase0.md` | 이미 걷어낸 두 배선 경로(Pyodide 위의 ALIGN 배선기, 독립 격자 배선기)와 타당성 스파이크의 기록. 지금 코드를 설명하지 않는다 |
| 페이지의 Google Fonts 링크 | 페이지를 여는 데 외부 주소가 하나도 안 들게 — 시스템 글꼴 스택으로 |

**더한 것.** `scripts/align-baseline.sh` (네이티브 ALIGN 으로 예제 하나를 끝까지 돌려 기준선을 담는다),
`pack-example.mjs` 가 ALIGN 배선 기준선(`routed/`)까지 같이 쓴다. 지금 예제 다섯 개를 ALIGN 출력 모양으로
되돌린 폴더 위에서 다시 묶어 저장소의 파일과 내용이 같음을 확인했다.

**남은 의존성.** 페이지를 열고 예제를 배치·배선·GDS 까지 하는 데는 아무것도 안 든다. `.sp` 를 올릴 때만
Pyodide 스택(CDN 16 MB + 저장소의 libz3 22 MB)이 든다. 검사는 node 22, 브라우저 검사만 Playwright.
배선기 빌드는 Rust + clang(wasi) + lp_solve C 소스, crate 는 serde 둘. 기준선은 네이티브 ALIGN.

**지금 트리** (정리 뒤).

```
index.html  view.mjs  worker.mjs  routeworker.mjs  frontworker.mjs     페이지 (스크립트 1,100 줄이 index.html 안에)
src/*.mjs  src/gpu/                                                  배치기
src/route/  src/route/align/  src/route/alignroute.wasm              배선 (JS + wasm)
data/  netlists/  routed/                                            예제 5 개 (앞단 출력·리프·회로·ALIGN 배선)
py/                                                                  앞단 Pyodide 스택 (23 MB, 거의 libz3)
symplace/alignroute/                                                 Rust 배선기
symplace/web/placer/{test,fixtures,pack-example.mjs,README.md}       검사·고정값·예제 묶기·설계 노트
symplace/scripts/                                                    기준선·메모리·z3 빌드·node 하네스·분석
symplace/{setup.sh,env.sh,patches/}                                  네이티브 ALIGN
symplace/PLAN-*.md                                                   설계 기록 둘
```

---

## 1. 재구성 — 목표 트리와 옮기는 순서

지금 트리의 문제는 셋이다. (a) `symplace/` 라는 이름이 옛 원본 저장소의 흔적이라 "사이트 안의 소스"라는
자리와 안 맞고, 검사가 `../../../../src/` 처럼 네 단계를 올라간다. (b) 예제 하나가 `data/`·`netlists/`·`routed/`
세 곳과 index 두 개에 흩어져 있다. (c) 페이지 스크립트 1,100 줄이 `index.html` 안에 있어 검사할 수도, 나눠
읽을 수도 없다.

### 1.1 목표 트리

```
index.html                  페이지 — HTML 과 CSS 만
app/
  main.mjs                  상태와 이벤트 (지금 index.html 의 <script>)
  draw.mjs                  캔버스 (지금 view.mjs) — 확대/이동, 패널, 배선 레이어
  upload.mjs                회로 올리기 — .sp / 앞단 출력 JSON / 예제로 저장
  results.mjs               지표·변이 표·DRC 표·내려받기
  workers/place.mjs, route.mjs, front.mjs      (지금 worker.mjs, routeworker.mjs, frontworker.mjs)
src/
  place/                    배치기 — linalg, subspace, energy, solver, lp, legalize, design, place, job, baseline, gpu/
  route/                    배선 — 그대로 (align/, pipeline, check, compose, gds, leaves, pdk, hier, alignroute.mjs + .wasm)
  front/                    (3 절) 앞단의 JS 이식이 들어올 자리
examples/
  index.json                예제 목록 하나: {name, label, bytes, align: {geo, rects, gdsName, gdsBytes, errors}}
  <name>/design.json        앞단 출력 + ALIGN 배치 (지금 data/<name>.json)
  <name>/leaves.json        리프 도형 (지금 data/<name>.leaves.json)
  <name>/netlist.sp, netlist.const.json
  <name>/align-routed.json  ALIGN 배선 기하 (지금 routed/<name>.align.json)
pyodide/                    앞단 Pyodide 스택 (지금 py/) — front.py, z3/, align-front.zip
native/
  alignroute/               Rust 배선기 (지금 symplace/alignroute/)
  align/                    setup.sh, env.sh, patches/, align-baseline.sh, measure-memory.sh, build-z3-pyodide.sh
tools/
  pack-example.mjs          ALIGN 작업 디렉터리 -> examples/<name>/
  place.mjs, route.mjs      페이지와 같은 배치·배선을 node 에서 (지금 scripts/route/node/)
  analysis/                 변이 선택 분석 (지금 scripts/place/)
tests/
  run.sh                    빠른 검사 전부 (lp, parity, design, chunk, leaves, check, compose, gds) — 1 분
  run-slow.sh               place(5 예제), variants, legalize, route(5 예제) — 5 분
  *.mjs, fixtures/          (지금 symplace/web/placer/test, fixtures)
docs/
  placer.md                 배치기 설계 노트 (지금 symplace/web/placer/README.md)
  router.md                 배선기 이식 기록 (지금 PLAN-route-align.md)
  variants-gpu.md           변이 선택·WebGPU 기록 (지금 PLAN-place-variants-gpu.md)
  memory-patch.md           ALIGN 메모리 패치 (지금 patches/README.md)
README.md                   하나 — 쓰는 법, 구성, 측정치, 예제 넣기, 의존성
PLAN.md                     이 문서
```

원칙: **빌드 단계·번들러·프레임워크·npm 의존을 더하지 않는다.** 지금처럼 정적 호스팅에 폴더째 올리면
돌아야 한다. 경로가 바뀌는 것뿐이고 코드는 그대로다.

### 1.2 옮기는 순서 — 단계마다 검사가 통과한다

1. **검사를 `tests/` 로.** `symplace/web/placer/test/*` 와 `fixtures/` 를 옮기고 import 경로를
   `../src/` 로 줄인다. `tests/run.sh`, `tests/run-slow.sh` 를 만든다. 검사: run.sh 전부 통과.
2. **예제를 `examples/<name>/` 로.** `data/`·`netlists/`·`routed/` 를 예제별 폴더로 모으고 index 를 하나로
   합친다. 손대는 곳: `index.html` 의 fetch 경로 6 곳(`loadExampleList`, `loadExample`, `leavesFor`,
   `loadRouted`, `drcRec`), `tests/leaves.mjs`, `tools/route.mjs`, `pack-example.mjs`, `_load.mjs`.
   "예제로 저장"이 내려주는 파일 이름과 README 의 "예제 더 넣기" 절도 같이. 검사: run.sh + `page.mjs` 한 예제.
3. **도구를 `tools/` 로, 네이티브를 `native/` 로.** 코드 변경 없음, 경로만. `alignroute/build.sh` 의 출력
   경로(`../../src/route/alignroute.wasm`)를 고친다. wasm 은 다시 빌드하지 않는다 (같은 파일).
4. **배치기를 `src/place/` 로.** 11 개 파일 이동, `job.mjs`·`baseline.mjs`·워커·검사의 import 갱신.
   검사: run.sh + place.mjs 한 예제 + gpu.mjs.
5. **페이지 스크립트를 `app/` 로 가른다.** 지금 `<script type="module">` 을 네 모듈로 나눈다. 상태(`what/who/frame/
   ours/base/routed`)는 `main.mjs` 하나가 갖고 나머지는 함수로 받는다 — 지금도 `view.mjs` 가 그렇게 돼 있다.
   이 단계가 유일하게 코드를 옮기며 손대는 곳이라 마지막에 두고, `page.mjs` 로 배치·배선 끝까지 확인한다.
6. **문서를 `docs/` 로.** README 셋을 하나로 합치고 (루트 README 가 이미 대부분을 담고 있다), 설계 기록 셋을
   `docs/` 로. `symplace/` 폴더가 비면 지운다.
7. **CI.** GitHub Actions 하나: node 22 로 `tests/run.sh`. 외부 의존이 없어 설치 단계가 없다. 느린 검사는
   손으로 (또는 주 1 회 스케줄).

각 단계는 커밋 하나다. 2 와 5 만 코드가 바뀌고 나머지는 `git mv` 다.

### 1.3 같이 손볼 것 (작은 것)

- `src/route/align/*.mjs` 의 export 를 파일 밖에서 쓰는 것만 남긴다 (지금 60 개 중 40 개가 내부용).
- `index.html` 의 `FALLBACK_EXAMPLES` 목록을 없앤다 — index 를 못 읽으면 빈 목록과 문구만 보이면 된다
  (예제를 더 넣을 때 두 군데를 고치게 만드는 함정이다).
- `routed/index.json` 의 같은 문구 반복(current_mirror 의 DIFFERENT WIDTH 4 건)은 ALIGN 이 낸 그대로다 — 건드리지 않는다.

---

## 2. 예제 5 개 추가 — 열 개로

### 2.1 전제 — 어느 다섯인가

ALIGN-public(`8d3cc2e`) 의 `examples/` 에는 41 개가 있고, 지금 저장소에는 그중 다섯
(telescopic_ota, current_mirror_ota, five_transistor_ota, cascode_current_mirror_ota, high_speed_comparator)이 있다.
"나머지 다섯"이 어느 것인지 정해진 목록이 없어서, **지금 파이프라인(모의 FinFET PDK, MOS 소자, 평면 또는
얕은 계층)에 맞고 지금 다섯이 안 건드리는 것을 하나씩 더하는** 순서로 골랐다. 다른 목록이 있으면 표만
바꾸면 되고 절차(2.2)는 같다.

| 순서 | 예제 | 소자 | 제약 | 새로 건드리는 것 |
|---|---|---|---|---|
| 1 | `buffer` | MOS 4, 평면 | 없음 (`.const.json` 이 없다) | 제약 파일 없는 경로. ALIGN 자신의 CI 벤치마크 셋에 든다 |
| 2 | `double_tail_sense_amplifier` | MOS 14, 평면 | PowerPorts, GroundPorts, ConfigureCompiler | 클럭 래치 — 대칭 쌍이 많은 평면 설계, `ConfigureCompiler` 는 앞단만 본다 |
| 3 | `telescopic_ota_with_bias` | MOS 36 (직렬 쌍), 평면 | PowerPorts, GroundPorts | 크기 — 블록 수와 변이 조합이 지금의 세 배. 예산·시간의 한계를 본다 |
| 4 | `variable_gain_amplifier` | MOS 17 + 저항 2 | PowerPorts, GroundPorts, CompactPlacement | **저항 소자** (앞단이 Res 템플릿을 만든다), `CompactPlacement` 를 배치기가 어떻게 받을지 |
| 5 | `linear_equalizer` | MOS (nfet2x 하위 회로) + 저항 4 + 커패시터 2 | PowerPorts, GroundPorts | **커패시터 소자**(GroupCaps 없이 잎 하나로), 하위 회로 계층 |

대안 (같은 절차로 들어간다): `single_to_differential_converter` (MOS 2 + R 3 + C 3, 작다),
`sc_dc_dc_converter` (MOS 7 인데 nf=832 라 소자 하나가 거대하다), `comparator1` (MOS 25, 서브서킷 6 단),
`five_transistor_ota_Bulk` / `_high_frequency` (지금 예제의 변형), `switched_capacitor_filter` (아래 2.5 —
`GroupCaps` 가 ALIGN 의 커패시터 배치기(C++)를 요구해 지금은 못 한다).

### 2.2 예제 하나를 넣는 절차

```
1  기준선   source symplace/env.sh && ./symplace/scripts/align-baseline.sh <예제> --label "..."
            -> data/<예제>.json, .leaves.json, routed/<예제>.align.json, netlists/, 두 index
            ALIGN 이 실패하면 (PLAN-route-align.md 부록 C 처럼 죽는 입력이 있다) 기준선 없이 간다:
            페이지에서 .sp 를 올려 "예제로 저장" -> data/ 에 넣는다 (왼쪽 패널만 빈다)
2  앞단     페이지의 회로 올리기에 netlists/<예제>.sp (+ .const.json) 를 넣어 브라우저 앞단이 도는지 본다.
            1_topology·2_primitives 가 네이티브(1 의 작업 디렉터리)와 같은지 — 지금 다섯은 바이트까지 같았다
            (PYTHONHASHSEED=0). 다르면 앞단 스택(py/front/align-front.zip 의 stub·shim)이 빠뜨린 것이 있다
3  배치     node symplace/web/placer/test/design.mjs   (평면이면 고정값 없이 문제 생성만 본다)
            node symplace/web/placer/test/place.mjs <예제>   면적·HPWL 비, 변이·반전 일치, 겹침 0, 대칭 잔차
            node symplace/web/placer/test/variants.mjs       (평면) ALIGN 배정의 순위
4  배선     node symplace/web/placer/test/leaves.mjs
            node symplace/scripts/route/node/newroute.mjs <예제>          ALIGN 배치로 — DRC/LVS 가 routed/index 의 ALIGN 것과 같아야 한다
            node symplace/scripts/route/node/place.mjs <예제> && newroute.mjs <예제> --place=ours   우리 배치로
5  페이지   node symplace/web/placer/test/page.mjs <예제> cpu 48   (GPU 가 있으면 gpu)
6  기록     README 의 "배치 품질" 표에 한 줄, 새로 건드린 것이 있으면 이 문서 2.3 에 결과
```

1 은 네이티브 ALIGN 이 있는 기계에서 (예제 하나에 2~5 분, 메모리 1.5 GB 안쪽). 2~5 는 어디서나.

### 2.3 예제마다 예상되는 일 — 지금 코드로 어디까지 되나

앞단(Pyodide 의 ALIGN)은 MOS·저항·커패시터 템플릿을 다 만든다 (PDK 의 `unit_size_cap`, `unit_height_res` 가
있고 `cell_fabric` 생성기가 zip 에 들어 있다). 배치기는 `SymmetricBlocks`·`Align`·`Order`·`AspectRatio`·
`GroupBlocks`(앞단이 하위 모듈로) 를 처리하고, 배선 입력 쪽(`src/route/align/prep.mjs`)은 ALIGN 의 제약 표
전부를 옮겨 두었다.

| 예제 | 앞단 | 배치기 | 배선 | 할 일 |
|---|---|---|---|---|
| buffer | 됨 | 됨 (제약 없음 = 대칭 없음, 영공간이 전체) | 됨 | 없음. `.const.json` 이 없을 때 `PowerPorts` 도 없어서 VDD/VSS 를 넷 이름으로만 거른다 (`powerGroundNets` 의 기본 집합) — 이름이 `vdd`/`vss` 라 걸린다 |
| double_tail_sense_amplifier | 됨 (`ConfigureCompiler` 는 앞단 옵션) | 됨 — 앞단이 찾는 대칭 쌍이 많아 영공간이 작다 | 됨 | 없음. 클럭 넷(`CLK`)이 `ClockPorts` 로 안 잡혀 있어 HPWL 에 든다 — ALIGN 도 같다 |
| telescopic_ota_with_bias | 됨 | **볼 것** — 앞단이 직렬 쌍(m9/m9s)을 stack 소자로 묶어 블록은 ~18 개. 변이 조합이 128 을 넘으면 추첨이 되고, 밀도 격자와 legalize 쌍 수(153)가 늘어 시간이 hsc 의 몇 배 | 됨 | 예산 기본값(96)으로 결과가 흔들리면 조합 상한과 라운드 배분을 다시 본다 |
| variable_gain_amplifier | 됨 — `Res` 템플릿 | **볼 것** — 저항은 변이가 하나인 블록이라 문제없다. `CompactPlacement` 는 배치기에 없다: 무시해도 되는 제약(면적 최소화는 기본 동작)이지만 명시적으로 받아 로그에 남긴다 | 됨 (저항 잎의 핀은 M1/M2) | `CompactPlacement` 를 "안다"고 등록 (`design.mjs`), 저항 잎의 DRC 문구가 ALIGN 과 같은지 |
| linear_equalizer | 됨 — `Cap`·`Res` 템플릿, `nfet2x` 는 하위 모듈 또는 stack | **볼 것** — 커패시터 잎(정사각형에 가까움, 큰 면적)이 밀도항의 격자 결정을 흔들 수 있다 | 됨 | 커패시터 잎을 넣은 배치의 겹침·격자를 place.mjs 로 확인 |

### 2.4 합격선

예제마다 지금 다섯과 같은 기준을 건다.

- 배치: 겹침 정확히 0, 대칭 잔차 1e-9 아래, 격자 밖 블록 0, `Order` 위반 0, 면적이 ALIGN 의 3 배 안쪽 (구조 검사).
  면적·HPWL 비는 보고만 한다 — 목표는 평면 설계에서 1.0x 안팎, 계층은 1.1x 안쪽.
- 배선: ALIGN 배치를 넣으면 DRC/LVS 문구가 ALIGN 의 것과 같다 (`newroute.mjs` 대 `routed/index.json`).
  우리 배치를 넣으면 SHORT·OPEN 0.
- 페이지: 예제를 고르고 배치·배선·GDS 내려받기까지 `page.mjs` 가 끝까지 간다.

### 2.5 위험

- **`GroupCaps`** (switched_capacitor_filter): ALIGN 은 커패시터 묶음을 배치 단계의 C++ 커패시터 배치기
  (`PlaceRouteHierFlow/cap_placer/capplacer.cpp`, 80 KB)로 공통 중심 배열로 만들고 그 안을 배선한다. 우리
  배선기 이식(RouteWork 4·5·2·3)에는 없다. 넣으려면 그 C++ 도 Rust 로 옮겨야 한다 — 배선기 이식과 같은
  방식(같은 입력에서 같은 도형)으로, 규모는 상세 배선의 1/3 쯤. 다섯 개에서 뺐다.
- **크기**: 36 소자 예제에서 시간이 예산에 선형으로만 늘지 않는다 (설정 수 = 배정 x 영역 후보). WebGPU 가
  있는 기계에서 재는 것이 먼저다 — 아직 SwiftShader 로만 쟀다.
- **ALIGN 이 죽는 입력**: 기준선이 없는 예제가 생길 수 있다. 그때는 우리 결과만 보이고 "ALIGN 대비" 칸이 빈다 —
  이미 지원하는 경로다.
- **앞단 비결정성**: ALIGN 앞단은 `PYTHONHASHSEED` 없이는 실행마다 다르다. 브라우저는 0 으로 고정했고,
  `align-baseline.sh` 는 ALIGN 기본 실행이라 다를 수 있다 — 기준선의 변이 이름이 다르게 보일 수 있지만
  모양으로 견주므로(표의 "같은 모양") 문제가 안 된다.

---

## 3. 의존성 더 줄이기 — 앞단을 JS 로

남은 큰 의존성은 `.sp` 를 올릴 때의 Pyodide 스택이다 (CDN 16 MB + libz3 22 MB, 첫 방문 10 초 안팎).
ALIGN 앞단을 JS 로 옮기면 없어지고, 회로 올리기가 예제 고르기처럼 즉시 된다.

옮길 것 (zip 안의 파이썬, 파일 수와 크기):

```
align/compiler     12 파일 115 KB   SPICE 읽기, 계층·소자 묶기(networkx 그래프 매칭), 제약 찾기, 이름 짓기
align/schema       16 파일 139 KB   제약 스키마(pydantic)와 검사기(z3)
align/primitive     5 파일  19 KB   템플릿 생성 진입
align/cell_fabric  16 파일  95 KB   MOS·Cap·Res 셀 생성기, 격자, 후처리, LEF
align/pdk          10 파일  36 KB   PDK 읽기
```

순서와 합격선:

1. **스키마와 검사기부터.** z3 는 제약 검사(`ConstraintDB.append` 의 `verify`)에만 쓰인다. 지금 다섯 예제와
   추가할 다섯의 제약 종류는 열 개 남짓이라, 그 검사를 JS 로 직접 쓴다 (충돌하는 대칭·순서·정렬의 검출).
   합격: 열 예제의 제약 파일 전부에서 같은 판정. 이것만으로 libz3 22 MB 가 빠진다 (앞단 스택이 17 MB 로).
2. **소자 묶기(compiler).** 그래프 매칭(`match_graph.py`, `create_database.py`, `preprocess.py`)을 옮긴다.
   합격: 열 예제에서 `1_topology/*.verilog.json` 이 네이티브와 같다 (인스턴스, fa_map, 제약).
3. **템플릿 생성(primitive + cell_fabric).** MOS 부터, 그다음 Res·Cap. 합격: `2_primitives/*.json` 이 같다
   (bbox·terminals — 배선까지 같아야 하므로 도형 전부).
4. 페이지의 `frontworker.mjs` 를 JS 앞단으로 바꾸고 `py/` 를 지운다. 지금 Pyodide 경로는 3 이 끝날 때까지 둔다.

검증 방법은 배선기 이식 때와 같다 — 같은 입력에서 네이티브와 **같은 출력**. 네이티브 출력은
`align-baseline.sh` 의 작업 디렉터리에 그대로 남는다.

그 밖의 의존은 그대로 둔다: serde 둘(Rust JSON), Playwright(브라우저 검사만), 네이티브 ALIGN(기준선만).

---

## 4. 순서

```
A  재구성 1~4 (검사·예제·도구·배치기 경로)      코드 변경 거의 없음, 커밋 4 개
B  예제 1~2 (buffer, double_tail_sense_amplifier)   기준선 + 절차 2.2 그대로 — 절차가 맞는지 확인하는 단계
C  재구성 5~7 (app/ 분리, docs, CI)
D  예제 3~5 (telescopic_ota_with_bias, variable_gain_amplifier, linear_equalizer)   2.3 의 "볼 것"을 하나씩
E  앞단 JS 이식 1 (z3 대체) — 그다음 2·3 은 별도 계획으로
```

B 를 A 와 C 사이에 둔 것은 예제 절차가 새 트리에서도 그대로인지 일찍 보려는 것이다. B 에서 절차가
바뀌면 C 의 문서에 반영한다.
