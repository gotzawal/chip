# 계획 — 깔끔한 재구성과 ALIGN 예제 확장 (2026-09-23)

이 문서는 두 가지를 적는다. (1) 저장소를 어떤 모양으로 다시 짤 것인가, (2) ALIGN 예제를 더 넣으려면
무엇이 필요한가. 둘 다 **지금 도는 것을 한 번도 깨지 않고** 가는 순서로
적었다 — 각 단계가 끝날 때마다 검사가 그대로 통과해야 한다.

## 0. 지금 상태 — 이번 정리에서 한 것

**걷어낸 것** (전부 git 에 있다, 마지막으로 들어 있던 커밋 `0e04d6a`).

| 걷어낸 것 | 왜 |
|---|---|
| `symplace/gpuplace/` 파이썬 배치기, `export-fixtures.py`, `scripts/verify.sh` | 첫 구현. JS 배치기가 variant·반전·영역·계층·WebGPU 까지 가서 그것을 넘어섰고, 파이썬 쪽은 ALIGN 의 place 출력을 읽어 좌표만 덮어쓰는 옛 경로였다. numpy·python-mip 의존이 같이 없어졌다. parity 검사의 고정값은 그대로 둔다 |
| `symplace/web/placer/fixtures/design/` (74 파일), `scripts/route/stage-design.sh` | `data/<예제>.json` 과 같은 앞단 출력을 펼쳐 둔 사본. 검사가 이제 `data/` 를 직접 읽는다 — 사이트와 검사가 같은 입력을 본다 |
| `symplace/PLAN-route.md`, `symplace/NOTES-phase0.md` | 이미 걷어낸 두 배선 경로(Pyodide 위의 ALIGN 배선기, 독립 격자 배선기)와 타당성 스파이크의 기록. 지금 코드를 설명하지 않는다 |
| 페이지의 Google Fonts 링크 | 페이지를 여는 데 외부 주소가 하나도 안 들게 — 시스템 글꼴 스택으로 |

**ALIGN 결과를 넣거나 비교하는 것도 전부 걷어냈다.** ALIGN 의 배치·배선 기준선(`routed/`, `data/*.json` 의
`place`), 그것을 뽑던 네이티브 ALIGN 도구(`setup.sh`, `env.sh`, `patches/`, `align-baseline.sh`,
`measure-memory.sh`), 페이지의 ALIGN 패널·"ALIGN 대비" 지표·DRC 비교, 검사의 ALIGN 대조, 분석 스크립트
(`hpwl_extend.mjs`, `rescore.mjs`) — 커밋 `9a16a42` 까지 있다. 저장소에는 입력(앞단 출력·리프 도형·회로)만 있고
결과는 전부 페이지가 그 자리에서 만든다. 배선기가 ALIGN 알고리즘의 이식이라는 사실과 그 대조 기록
(`PLAN-route-align.md`)은 그대로다.

**더한 것.** 회로 올리기가 서브서킷마다 있는 제약 파일을 전부 받고, 배치기가 블록 간격 제약
(`HorizontalDistance` 등)을 legalize 에 넣으며, 모르는 제약을 페이지에 알린다. 예제가 12 개다.

**남은 의존성.** 페이지를 열고 예제를 배치·배선·GDS 까지 하는 데는 아무것도 안 든다. `.sp` 를 올릴 때만
Pyodide 스택(CDN 16 MB + 저장소의 libz3 22 MB)이 든다. 검사는 node 22, 브라우저 검사만 Playwright.
배선기 빌드는 Rust + clang(wasi) + lp_solve C 소스, crate 는 serde 둘.

**지금 트리** (정리 뒤).

```
index.html  view.mjs  worker.mjs  routeworker.mjs  frontworker.mjs     페이지 (스크립트 1,100 줄이 index.html 안에)
src/*.mjs  src/gpu/                                                  배치기
src/route/  src/route/align/  src/route/alignroute.wasm              배선 (JS + wasm)
src/schematic/                                                       회로도·묶음 보기 (SPICE 읽기, 회로, 자동 배열, 그리기)
data/  netlists/                                                    예제 12 개 (앞단 출력·리프·회로)
py/                                                                  앞단 Pyodide 스택 (23 MB, 거의 libz3)
symplace/alignroute/                                                 Rust 배선기
symplace/web/placer/{test,fixtures,pack-example.mjs,README.md}       검사·고정값·예제 묶기·설계 노트
symplace/scripts/                                                    z3 빌드·node 하네스·분석
symplace/PLAN-*.md                                                   설계 기록 셋 (배선기 이식, variant·GPU, 편집)
```

---

## 1. 재구성 — 목표 트리와 옮기는 순서

지금 트리의 문제는 셋이다. (a) `symplace/` 라는 이름이 옛 원본 저장소의 흔적이라 "사이트 안의 소스"라는
자리와 안 맞고, 검사가 `../../../../src/` 처럼 네 단계를 올라간다. (b) 예제 하나가 `data/` 와 `netlists/`
두 곳에 흩어져 있다. (c) 페이지 스크립트 1,100 줄이 `index.html` 안에 있어 검사할 수도, 나눠
읽을 수도 없다.

### 1.1 목표 트리

```
index.html                  페이지 — HTML 과 CSS 만
app/
  main.mjs                  상태와 이벤트 (지금 index.html 의 <script>)
  draw.mjs                  캔버스 (지금 view.mjs) — 확대/이동, 패널, 배선 레이어
  upload.mjs                회로 올리기 — .sp / 앞단 출력 JSON / 예제로 저장
  results.mjs               지표·variant 표·DRC 표·내려받기
  workers/place.mjs, route.mjs, front.mjs      (지금 worker.mjs, routeworker.mjs, frontworker.mjs)
src/
  place/                    배치기 — linalg, subspace, energy, solver, lp, legalize, design, place, job, gpu/
  route/                    배선 — 그대로 (align/, pipeline, check, compose, gds, leaves, pdk, hier, alignroute.mjs + .wasm)
  schematic/                회로도·묶음 보기 — 그대로 (spice, circuit, layout, draw)
  front/                    (3 절) 앞단의 JS 이식이 들어올 자리
examples/
  index.json                예제 목록: {name, label, bytes}
  <name>/design.json        앞단 출력 (지금 data/<name>.json)
  <name>/leaves.json        리프 도형 (지금 data/<name>.leaves.json)
  <name>/netlist.sp, *.const.json
pyodide/                    앞단 Pyodide 스택 (지금 py/) — front.py, z3/, align-front.zip, build-z3-pyodide.sh
native/
  alignroute/               Rust 배선기 (지금 symplace/alignroute/)
tools/
  pack-example.mjs          앞단 출력 폴더 -> examples/<name>/
  place.mjs, route.mjs      페이지와 같은 배치·배선을 node 에서 (지금 scripts/route/node/)
  analysis/                 variant 선택 분석 (지금 scripts/place/)
  edit/                     편집 계획의 실측 (지금 scripts/edit/)
tests/
  run.sh                    빠른 검사 전부 (lp, parity, design, chunk, leaves, check, compose, gds) — 1 분
  run-slow.sh               place(예제 전부), variants, legalize, route(예제 전부) — 5 분
  *.mjs, fixtures/          (지금 symplace/web/placer/test, fixtures)
docs/
  placer.md                 배치기 설계 노트 (지금 symplace/web/placer/README.md)
  router.md                 배선기 이식 기록 (지금 PLAN-route-align.md)
  variants-gpu.md           variant 선택·WebGPU 기록 (지금 PLAN-place-variants-gpu.md)
  edit.md                   배치·배선 편집과 토폴로지 유지 최적화 계획 (지금 PLAN-edit.md)
README.md                   하나 — 쓰는 법, 구성, 측정치, 예제 넣기, 의존성
PLAN.md                     이 문서
```

원칙: **빌드 단계·번들러·프레임워크·npm 의존을 더하지 않는다.** 지금처럼 정적 호스팅에 폴더째 올리면
돌아야 한다. 경로가 바뀌는 것뿐이고 코드는 그대로다.

### 1.2 옮기는 순서 — 단계마다 검사가 통과한다

1. **검사를 `tests/` 로.** `symplace/web/placer/test/*` 와 `fixtures/` 를 옮기고 import 경로를
   `../src/` 로 줄인다. `tests/run.sh`, `tests/run-slow.sh` 를 만든다. 검사: run.sh 전부 통과.
2. **예제를 `examples/<name>/` 로.** `data/`·`netlists/` 를 예제별 폴더로 모은다. 손대는 곳:
   `index.html` 의 fetch 경로 3 곳(`loadExampleList`, `loadExample`, `leavesFor`), `tests/leaves.mjs`,
   `tools/route.mjs`, `pack-example.mjs`, `_load.mjs`.
   "예제로 저장"이 내려주는 파일 이름과 README 의 "예제 더 넣기" 절도 같이. 검사: run.sh + `page.mjs` 한 예제.
3. **도구를 `tools/` 로, Rust 를 `native/` 로.** 코드 변경 없음, 경로만. `alignroute/build.sh` 의 출력
   경로(`../../src/route/alignroute.wasm`)를 고친다. wasm 은 다시 빌드하지 않는다 (같은 파일).
4. **배치기를 `src/place/` 로.** 10 개 파일 이동, `job.mjs`·워커·검사의 import 갱신.
   검사: run.sh + place.mjs 한 예제 + gpu.mjs.
5. **페이지 스크립트를 `app/` 로 가른다.** 지금 `<script type="module">` 을 네 모듈로 나눈다. 상태(`what/who/frame/
   ours/routed`)는 `main.mjs` 하나가 갖고 나머지는 함수로 받는다 — 지금도 `view.mjs` 가 그렇게 돼 있다.
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

---

## 2. 예제 확장

### 2.1 지금까지 — 29 개

ALIGN-public(`8d3cc2e`) 의 `examples/` 41 개 중 29 개가 들어 있다 (루트 README 의 표). 전부 배치(겹침 0,
대칭 잔차 0)·배선·페이지 검사를 통과한다. 넣으면서 고친 것: 계층이 세 단 이상인 설계(comparator1,
variable_gain_amplifier)의 하위 모듈을 재귀로 배선기에 넘기고, 같은 모듈을 다른 variant 로 두 번 쓰는 설계
(vco_type2_65)는 variant 마다 다른 abstract 로 낸다. 저항·커패시터 잎처럼 폭이 pitch 의 배수가 아닌 블록은
반전 부호에 맞는 격자 앵커를 쓴다.

### 2.2 예제 하나를 넣는 절차

```
1  앞단    페이지의 회로 올리기에 <예제>.sp (+ <서브서킷>.const.json 전부) 를 넣는다 — Pyodide 앞단이 돈다
2  저장    "예제로 저장" -> <예제>.json (앞단 출력 + 리프 도형). data/ 에 넣고 data/index.json 에 한 줄
           (첫 화면을 가볍게 하려면 pack-example.mjs 로 design 과 leaves 를 둘로 나눈다)
3  배치    node symplace/web/placer/test/place.mjs <예제>      겹침 0, 대칭 잔차, Order 위반 0
           node symplace/web/placer/test/variants.mjs           (평면) 배정이 결과를 가르는가
4  배선    node symplace/web/placer/test/leaves.mjs
           node symplace/scripts/route/node/newroute.mjs <예제>  배치 -> 배선 -> DRC/LVS (SHORT·OPEN 0 이어야 한다)
5  페이지  node symplace/web/placer/test/page.mjs <예제> cpu 48   (GPU 가 있으면 gpu)
6  기록    README 의 예제 목록과 "배치 결과" 표에 한 줄
```

### 2.3 남은 예제 12 개 — 무엇이 더 필요한가

| 예제 | 막힌 것 |
|---|---|
| five_transistor_ota_Bulk, test_vga | ALIGN 앞단 자체가 죽는다 ("number of fins must be more than 1") |
| vco_dtype_12_hierarchical, vco_dtype_12_hierarchical_res_constrained | ALIGN 앞단이 `LVTPFET` 소자의 생성기를 못 찾는다 (`ConfigureCompiler` 와 함께 쓰일 때) |
| sc_dc_dc_converter | `nf=832` 소자라 리프 도형이 20 MB — 저장소와 페이지에 못 싣는다. 리프 형식을 반복 구조로 압축해야 한다 |
| powertrain_binary | 블록 63 개(배열 16 + 32 + 17), variant 조합 1.8e11 — 배치에 10 분. 배열 계층을 한 블록으로 접는 처리가 필요하다 |
| switched_capacitor_filter | `GroupCaps` 커패시터 배열: ALIGN 배치 단계의 C++ 커패시터 배치기(`cap_placer/capplacer.cpp`, 80 KB)가 공통 중심 배열을 만들고 그 안을 배선한다. 배선기 이식에 없다 |
| telescopic_ota_guard_ring | `GuardRing`: PnR 의 `GuardRing.cpp` 20 KB (블록을 링으로 감싸고 전원에 잇는 것)가 배치기·배선기 양쪽에 없다 |
| fixed_height | 블랙박스 GDS 입력 (`-b gdsfiles/ --scale 1e9`): 브라우저 앞단이 gdspy 를 스텁으로 막아 두었다. JS GDS 읽기와 `gds2lefjson` 이식, 페이지에 블랙박스 폴더 올리기 |
| bottom_plate_4path_beamforming (2 종) | `.sp` 없이 LEF 만 있는 잎으로 시작하는 입력. `pnrdb.mjs` 에 LEF 파서가 있지만 리프 형식이 전체 도형을 요구한다 |
| mimo_bulk | 인스턴스 116, 서브서킷 21 — legalize LP 가 쌍 수에 제곱으로 커지고 Pyodide 앞단도 분 단위 |

**들어간 예제 중 남은 것.** 저항 잎(`RES_2T_*`)의 핀이 M1/M3 의 80 pitch 격자에 있지 않아(ALIGN 의 Res 생성기)
배선이 "Wire to color is offgrid" 로 찍힌다 — variable_gain_amplifier 10 건, linear_equalizer·
single_to_differential_converter 수백 건. 소자 자체의 문제라 우리 쪽에서 고칠 것이 없고, ALIGN 도 같은 문구를
낼 것이다. comparator1 은 VSS 에 OPEN 1 건 — 세 단 계층의 전원 배선에서 나며 아직 원인을 짚지 못했다.

### 2.4 합격선

- 배치: 겹침 정확히 0, 대칭 잔차 1e-9 아래, 격자 밖 블록 0, `Order` 위반 0, 면적이 블록 합계의 3 배 안쪽.
- 배선: SHORT·OPEN 0. `DIFFERENT WIDTH` 는 소자 variant 가 섞일 때 나는 것이라 건수만 기록한다.
- 페이지: 예제를 고르고 배치·배선·GDS 내려받기까지 `page.mjs` 가 끝까지 간다.

### 2.5 위험

- 36 소자 예제에서 시간이 예산에 선형으로만 늘지 않는다 (설정 수 = 배정 x 영역 후보). WebGPU 가 있는
  기계에서 재는 것이 먼저다 — 아직 SwiftShader 로만 쟀다.
- 브라우저 앞단은 ALIGN 의 파이썬을 그대로 돌리므로 ALIGN 앞단이 못 받는 회로는 우리도 못 받는다.

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

검증 방법은 배선기 이식 때와 같다 — 같은 입력에서 지금의 Pyodide 앞단과 **같은 출력**
(1_topology·2_primitives 를 바이트까지). 그 출력은 페이지의 "예제로 저장" 으로 얻는다.

그 밖의 의존은 그대로 둔다: serde 둘(Rust JSON), Playwright(브라우저 검사만).

---

## 4. 순서

```
A  재구성 1~4 (검사·예제·도구·배치기 경로)      코드 변경 거의 없음, 커밋 4 개
B  comparator1 의 VSS OPEN 원인 찾기; 저항 잎의 핀 격자는 앞단 JS 이식(3 절) 때 같이 본다
C  재구성 5~7 (app/ 분리, docs, CI)
D  2.3 의 남은 예제 — 배열 접기(powertrain_binary), 리프 압축(sc_dc_dc_converter) 부터
E  앞단 JS 이식 1 (z3 대체) — 그다음 2·3 은 별도 계획으로
F  배치·배선 비주얼 편집과 토폴로지 유지 최적화 — symplace/PLAN-edit.md (P0~P4, R0~R4). A 뒤 어디든 끼울 수 있다
```

B 를 A 와 C 사이에 둔 것은 예제 절차가 새 트리에서도 그대로인지 일찍 보려는 것이다. B 에서 절차가
바뀌면 C 의 문서에 반영한다.
