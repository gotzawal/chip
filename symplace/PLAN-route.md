# 배선 경로 — 지금 도는 모양과, 가볍게 다시 짜는 계획 (2026-09-22)

측정은 전부 node 에서 브라우저 워커와 **같은 코드**를 돌려 쟀다 — Pyodide 0.27.8,
같은 휠, `frontworker.mjs` 의 파이썬 원문을 그 파일에서 그대로 읽는다
(`scripts/route/node/`, 부록 A). 전에는 "Pyodide 를 못 받는 환경" 이라 배선기를
직접 돌려보지 못했는데, 코어는 npm(`pyodide@0.27.8`)에, 파이썬 꾸러미는 PyPI 에
있어서 CDN 없이도 된다. 배치는 페이지 기본값(시작점 96, 무게 2, 퍼뜨리기 1)이다.

## 요약

1. **배선은 ALIGN 의 파이썬 흐름을 통째로 브라우저에 올린 것이다.** 배선 버튼 한 번에
   Pyodide(+libz3 22 MB)를 띄우고, 예제라도 앞단을 다시 돌리고, 우리 배치를 ALIGN place
   단계의 산출물(`__placer_dump__.json`)로 위장해 넣고, ALIGN 이 그걸 pydantic 으로 다시
   읽어 C++ 배선기를 부른 뒤, 파이썬으로 DRC 를 하고 GDS 를 두 벌 만든다.
   받는 것 약 42 MB. 차가운 클릭 한 번 13~20 초 중 **C++ 배선 알고리즘은 1.0~4.5 초**다.
2. **"멈춘다"(null function)의 원인은 축소 빌드가 아니라 lp_solve 의 BLAS 적재 코드와
   Emscripten dlopen 의 조합이다.** 한 wasm 인스턴스 안에서 LP 를 **두 번째로** 만드는
   순간 BLAS 함수 포인터가 NULL 이 된다. 배선하는 모듈 하나에 LP 가 하나라서 평면 설계는
   첫 배선만 살고, 계층 설계는 두 번째 모듈에서, 같은 설계를 두 번 배선하면 두 번째에서
   죽는다. JS 한 줄로 우회된다(검증함). 이러면 **펼치기(flatten)도 필요 없다** —
   계층 그대로 5/5 가 끝까지 간다.
3. **계획: 배선에서 파이썬을 뺀다.** C++ 배선기만 독립 wasm(`route(json) -> json`,
   1.5 MB 안팎)으로 빌드하고, 그 앞(prep)과 뒤(도형 합성·DRC/LVS·GDS)는 JS 로 옮긴다.
   예제는 리프 도형만 더 실으면(5 개 합계 gzip 82 KB) Pyodide 없이 배선된다.
   Pyodide 워커는 `.sp` 를 올릴 때(앞단)만 뜬다.

---

## 1. 지금 도는 모양

### 1.1 배선 버튼 한 번에 일어나는 일

```
index.html  runRoute()
  │  placement = {bbox, instances[name, concrete, oX, oY, sX, sY], subModules}
  ├─ ensureFront()         워커에 이 설계의 앞단 결과가 없으면
  │    runFront(fresh)     워커를 죽이고 새로 띄운다 = Pyodide 부팅부터
  │                        예제도 netlists/<예제>.sp 로 앞단을 다시 돌린다.
  │                        data/<예제>.json 이 있는데도 — 배선기가 원하는
  │                        .lef / 전체 .json / .gds.json 이 거기 없어서다
  └─ frontworker.mjs cmd:"route" -> PYROUTE.route()      (JS 안의 파이썬 약 490 줄)
       _skip_cap_placer           축소 휠에 없는 바인딩을 몽키패치로 피한다
       rm -rf 3_pnr, *.gds        "두 번째 배선이 죽는다" 우회 — 효과 없다 (2 절)
       schematic2layout(3_pnr:prep)
         read_lib_json · VerilogJsonTop(pydantic) · manipulate_hierarchy
         · 제약 변환(*.pnr.const.json) · .map · .lef/.placement_lef 이어붙이기
         · layers.json 과 리프 .json/.gds.json 복사 · cap 맵
       write_dump()               우리 배치를 ALIGN place 단계 산출물로 위장한다
                                  (leaf_map 의 hovertext, metrics 까지 흉내)
                                  계층이면 편다 (_flat_instances — 블록 제약 일부를 버린다)
       schematic2layout(3_pnr:route, router_mode="bottom_up")
         덤프를 pydantic 으로 다시 파싱
         router_driver
           connectivity_change / change_concrete_names
           gen_abstract_verilog_d        pydantic 객체 deepcopy
           디버그 파일 2 개
           gen_DB_verilog_d              C++ PnRDB (PDK, LEF, verilog, 제약, semantic)
           hierarchical_place            C++ PlacerIfc 로 우리 배치를 DB 에 주입
           route_bottom_up               모듈마다 RouteWork 4·5 (+최상위 2·3)
                                         + 중간 JSON 덤프 (DR/PG/PR, GcellGlobalRoute, 보고서)
         _generate_json                  파이썬 cell_fabric: 도형 합성 + DRC/LVS + gds.json
         convert_GDSjson_GDS x2          C++ 판 GDS, 파이썬 판 GDS
       -> GDS(base64) · errors · <TOP>_0.json(도형)
```

### 1.2 받는 것 (첫 방문, 원본 크기)

| 무엇 | 크기 | 배선에 필요한가 |
|---|---|---|
| Pyodide 0.27.8 코어 (asm.wasm 10.1 + stdlib 2.4 + asm.js 1.3) | 13.9 MB | 파이썬을 돌리려고 |
| networkx · pydantic · python-gdsii · typing_extensions · micropip | 2.1 MB | ALIGN 흐름 |
| **libz3** (+ 파이썬 바인딩 0.7 MB) | **22.4 MB** | **아니다** — 앞단의 제약 검증에만 쓴다 |
| PnR 휠 (C++ 배선기) | 0.8 MB (풀면 3.2 MB) | 알맹이. 그중 약 1 MB 는 동적 링킹용 import/export 이름표 |
| align-front.zip | 1.9 MB | **그중 1.68 MB 가 PDF 2 개·PPT·PNG** (어떤 코드도 안 읽는다) |
| 합계 | **약 42 MB** | README 는 25 MB 로 적었다 |

### 1.3 도는 시간 (node, 받는 시간 제외)

차가운 클릭 한 번 (워커를 새로 띄우는 경우 — 예제를 바꾼 뒤 배선이 늘 이렇다):

| | telescopic_ota | high_speed_comparator |
|---|---|---|
| Pyodide + 패키지 + libz3 + import align | 5.0 s | 4.8 s |
| 앞단 다시 돌리기 | 1.6 s | 3.0 s |
| 배선 단계 `route()` | 6.1 s | 11.9 s |
| **합계** | **약 13 s** | **약 20 s** |
| 그중 C++ 배선 알고리즘 (RouteWork 4·5·2·3) | **0.97 s** | **4.52 s** |

배선 단계 안 (`route.mjs --prof`):

| | telescopic | hsc (계층 그대로) |
|---|---|---|
| `gen_abstract_verilog_d` (pydantic deepcopy) | **3.47 s** | **3.40 s** |
| C++ 중간 덤프 (WriteJSON, WriteGcellGlobalRoute, ...) | 0.92 s | 2.22 s |
| C++ 배선 알고리즘 | 0.97 s | 4.52 s |
| PnRDB 구축 + 배치 주입 | 0.13 s | 0.35 s |
| 파이썬 후처리 (도형·DRC·gds.json·GDS 두 벌) | 0.23 s | 0.93 s |
| prep | 0.10 s | 0.20 s |

배선 단계의 절반 넘게가 **배치 정보를 떼어낸 사본 하나를 만드는 deepcopy** 다.
그 넷리스트는 우리가 처음부터 가지고 있다.

### 1.4 메모리

wasm 힙이 배선 한 번에 594 MB, 두 번째에 786 MB, cascode(계층) 1,066 MB 다.
wasm 메모리는 반납되지 않는다. 네이티브에서 잰 C++ 배선기 본체는 72 MB 였다
(NOTES-phase0 S4). 나머지는 파이썬 쪽 중간물이다.

---

## 2. "멈춘다"의 진짜 원인 — lp_solve 가 BLAS 포인터를 NULL 로 둔다

### 2.1 무엇이 죽는가

충돌 오프셋(`wasm-function[10931]:0x2fb8c5`)을 휠의 .so 에서 짚었다
(wasm-objdump, 내보낸 심볼 이름).

```
lin_solve -> spx_solve -> run_BB -> solve_BB -> solve_LP -> spx_run
  -> invert -> recompute_solution -> initialize_solution -> idamax
       call_indirect  *BLAS_idamax          <- 여기가 0 이다
```

전역 배선(GcellGlobalRouter)의 LP 가 lp_solve 의 BLAS 함수 포인터 `BLAS_idamax` 를
부르는데 그 값이 0 이다.

### 2.2 왜 0 이 되는가

lp_solve 의 `make_lp()` 는 LP 를 만들 때마다 이렇게 한다 (역어셈블로 확인).

```c
init_BLAS();                  /* 처음 한 번만 BLAS_* = my_* (내장판), mustinitBLAS = FALSE */
if (is_nativeBLAS())
  load_BLAS("myBLAS");        /* 외부 BLAS 를 찾아본다: dlopen("libmyBLAS.so") */
```

`load_BLAS` 는 dlopen 이 **성공했는데** dlsym 이 NULL 을 주면, 포인터를 NULL 로 둔 채
실패 처리로 가고, 거기서 `mustinitBLAS` 가 이미 FALSE 라 내장판으로 되돌리지 않는다.
lp_solve 자체의 구멍이다 — 리눅스에서는 dlopen 이 늘 실패해서 안 드러난다.

그런데 Emscripten(3.1.58) 의 dlopen 은 **이름을 먼저 등록하고 나서** 적재를 시도한다
(`newDSO` -> `LDSO.loadedLibsByName[name] = dso`). 적재가 실패해도 등록이 남는다
(`exports: "loading"`). 그래서

| LP 생성 | dlopen("libmyBLAS.so") | 결과 |
|---|---|---|
| 첫 번째 | 파일이 없어 실패. 이름은 남는다 | 포인터 그대로 — 산다 |
| 두 번째부터 | 남은 이름을 보고 "이미 적재됨" 으로 성공 | dlsym 전부 NULL -> **BLAS 포인터 NULL** -> 다음 `idamax` 에서 죽는다 |

실측 (`route.mjs telescopic_ota --twice`, 우회책 없이):

```
배선 #1 성공 6.07s   BLAS_idamax=43740 (= my_idamax)  libmyBLAS.so=남아 있음(string)
배선 #2 죽음 2.70s   BLAS_idamax=0                     null function or function signature mismatch
```

### 2.3 지금까지의 증상이 전부 이것으로 설명된다

LP 는 **배선하는 모듈 하나에 정확히 하나** 만든다 (평면 1, cascode 2, hsc 5 — 셌다).

| 증상 / 지금까지의 설명 | 실제 |
|---|---|
| 계층 설계가 **두 번째 모듈**에서 멈춘다 | 두 번째 모듈 = 두 번째 LP. 재현됨 (hsc: `PRIMITIVE_98739713_PG0 (2)` 에서) |
| 평면 설계도 한 세션에서 두 번 배선하면 두 번째에 멈춘다 | 두 번째 배선 = 두 번째 LP |
| "매번 `3_pnr` 을 지우고 prep 부터" 로 고쳤다 | **안 고쳐졌다.** 지금 코드 그대로 두 번째 배선은 죽는다 (재현됨) |
| 펼치면 계층도 된다 (브라우저로 확인 못 함) | 된다 — cascode DRC 1, hsc DRC 0. 모듈이 하나라 LP 가 하나일 뿐이다. 대신 hsc 는 블록 제약 5 개를 버린다 |
| 축소 wasm 빌드가 빠뜨린 간접 호출 대상으로 보인다 | 아니다. 빠진 것은 "외부 BLAS 를 찾지 마라" 는 설정 하나다 |

페이지에서의 모양도 코드상 이렇다: 첫 실패 메시지(`null function ...`)에는 "fatal" 이
없어 `index.html` 의 워커 재시작 분기(`/fatal/i`)를 안 타고, 죽은 인스턴스가 워커에
남는다. 다음 클릭이 실패하면서야 워커를 다시 띄운다(부팅 + 앞단 + 배선).

### 2.4 고치는 법

**지금 코드에서 한 줄 — 검증함.** 워커 부팅 뒤 이 이름이 영영 적재되지 않은 것으로 보이게 막으면 매번 제대로 실패한다.

```js
Object.defineProperty(py._module.LDSO.loadedLibsByName, "libmyBLAS.so",
  { get() { return undefined; }, set() {}, configurable: true });
```

| 예제 | 경로 | 결과 |
|---|---|---|
| telescopic_ota | 평면, 두 번 연속 | 6.2 s / 5.0 s, GDS 80K, DRC 0 · 0 |
| five_transistor_ota | 평면, 두 번 연속 | 6.3 s / 4.8 s, GDS 86K, DRC 0 · 0 |
| current_mirror_ota | 평면, 두 번 연속 | 5.9 s / 4.8 s, GDS 79K, DRC 4 · 4 (ALIGN 자신도 같은 DIFFERENT WIDTH 4 건) |
| cascode_current_mirror_ota | **계층 그대로** | 16.3 s, GDS 194K, DRC 1 |
| high_speed_comparator | **계층 그대로** | 11.9 s, GDS 173K, DRC 0 — 제약을 안 버린다 |

**빌드에서.** `make_lp` 가 `load_BLAS("myBLAS")` 를 부르지 않게 한다. 휠 안에서 `dlopen` 을
부르는 곳은 `load_BLAS` 하나뿐이다. `build-pnr-wasm.sh` 는 lp_solve 를
`-DLoadInverseLib=0 -DLoadLanguageLib=0` 으로 빌드하는데 BLAS 쪽 짝이 빠져 있다.
lp_solve 원본에서 이 호출을 가르는 매크로(`lp_lib.h` 의 `libBLAS`, 또는
`LoadableBlasLib`)를 확인해 끈다. 합격선은 매크로 이름과 무관하다 —
**결과물의 import 에 `env.dlopen` 이 없어야 한다** (`wasm-objdump -x -j Import`).

---

## 3. ALIGN 에서 그대로 끌고 온 것

| 조각 | 하는 일 | 우리에게 | 대신 |
|---|---|---|---|
| Pyodide + pydantic + networkx | ALIGN 파이썬 흐름을 돌린다 | 배선에는 불필요 | — |
| libz3 22.4 MB | 앞단 제약 검증 | 배선에는 불필요 | 앞단 워커에만 |
| 앞단 재실행 (`ensureFront`) | 워커 FS 에 2_primitives 를 다시 만든다 | 리프 도형만 있으면 된다 | 예제 묶음에 리프 도형 (gzip 82 KB) |
| 앞단마다 워커를 새로 (`fresh`) | Pyodide 재부팅 (5 s) | 불필요 | — |
| `__placer_dump__.json` 위장 | 우리 배치를 ALIGN place 산출물로 | 불필요 | 라우터 입력 JSON 에 배치를 바로 |
| 덤프 재파싱 + `gen_abstract_verilog_d` | 배치를 떼어낸 사본 | 불필요 (3.4 s) | 넷리스트는 이미 있다 |
| prep: `.map`/`.lef`/`.placement_lef`/파일 복사 | C++ 가 파일로 읽게 한다 | LEF 는 리프 JSON 의 함수다 (59/59 일치) | JS 에서 문자열로 |
| `PlacerIfc` + placer 전체 + ILP 스텁 | 외부 배치를 DB 에 주입 | 주입만 필요 | 1차는 그대로, 2차에 직접 주입 (코드 321 KB) |
| 중간 JSON 덤프 | 디버그 | 불필요 (0.9~2.2 s) | 안 쓴다 |
| 파이썬 `gen_viewer_json` + cell_fabric DRC | 도형 합성, SHORT/OPEN/DRC | **필요** | JS 로 옮긴다 (파이썬 약 660 줄) |
| `gen_gds_json` + python-gdsii, GDS 두 벌 | GDS | 한 벌이면 된다 | JS GDS 쓰기 |
| 펼치기 (`_flat_instances` 와 제약 옮기기, 약 230 줄) | null function 우회 | 원인이 사라지면 불필요 | 계층 그대로 |
| `_skip_cap_placer`, PnR 스텁 별칭, `browser_stubs` | 축소 빌드·스텁 맞추기 | 파이썬이 빠지면 같이 빠진다 | — |
| 리프 `.gds.json` (예제당 0.7~3.9 MB) | C++ GDS 쓰기가 리프 셀을 읽는다 | 불필요 | 우리 GDS 쓰기 |

**리프 LEF 는 리프 JSON 에서 정확히 나온다** — 5 예제 59 개 전부 일치:
`SIZE` = bbox, `PIN` = `netType == "pin"` 인 도형, `OBS` = 나머지 중 M1~M6·V1~V5.
배선기가 필요로 하는 리프 자료는 리프 JSON 하나다.

---

## 4. 계획

### 목표 모양

```
index.html
 ├─ worker.mjs -> src/job.mjs                   배치 (그대로)
 ├─ routeworker.mjs  (새로)                     배선 — Pyodide 없음
 │    src/route/prep.mjs    설계 + 배치 -> 라우터 입력 JSON
 │                          전원핀 걷기(manipulate_hierarchy), 제약 변환(PnRConstraintWriter),
 │                          리프 LEF 를 리프 JSON 에서
 │    py/router/router.mjs + router.wasm        C++ 배선기 단독 빌드, route(json) -> json
 │    src/route/post.mjs    도형 합성 · DRC/LVS · GDS
 └─ frontworker.mjs  (앞단만)                   .sp 를 올릴 때만 — Pyodide + libz3
data/<예제>.leaves.json                          리프 전체 도형 (배선할 때만 받는다)
```

| | 지금 | 목표 |
|---|---|---|
| 예제 배선에 받는 것 | 약 42 MB | 라우터 1.5 MB 안팎 + 리프 도형 수십 KB |
| 차가운 클릭 (node) | 13~20 s | C++ 알고리즘 1.0~4.5 s + JS 앞뒤 |
| 두 번째 배선 · 계층 설계 | 죽는다 | 된다 (원인 제거) |
| 앞단과 배선 | 같은 워커에 묶여 있다 | 떨어진다 |

라우터 크기는 NOTES-phase0 S6 의 독립 링크(router + PnRDB + lp_solve = 1.3 MB)에
placer 를 더해 어림한 값이다. 2 단계에서 잰다.

### 0 단계 — 지금 구조에서 바로 (작고, 되돌리기 쉽다)

1. BLAS 우회 한 줄을 `frontworker.mjs` 의 `boot()` 끝에 넣는다 (2.4).
2. 펼치기를 기본에서 끈다. 부록 A 로 확인한 뒤 `_flat_instances`·`_remap_pins`·
   `_fix_constraints`·`_prune_constraints` 와 `write_dump` 의 펼침 분기를 지운다.
3. `rm -rf 3_pnr` 의 주석을 바로잡는다 (null function 과 무관하다).
4. `align-front.zip` 에서 PDF 2 개·PPT·PNG·`examples/` 를 뺀다: 1.9 MB -> 약 0.2 MB.
5. 앞단 워커를 설계마다 죽이지 않는다 (`runFront` 의 `fresh`). 1 이 있어야 안전하다.
6. README 의 "배선 3/5" 표와 "멈추는 지점" 진단 절을 고친다.
7. (선택) `gen_abstract_verilog_d` 를 dict 왕복으로, 중간 덤프(최종 GDS 쓰기 한 번만 남긴다)를
   끄는 패치를 align-front.zip 에 — telescopic 배선 단계 6.1 s -> 약 2 s. 2 단계에서 어차피 사라진다.

합격선: 부록 A 로 5 예제 각각 **두 번 연속** 배선 성공, DRC 건수가 지금과 같다
(0 / 0 / 4 / 1 / 0).

### 1 단계 — 라우터 입력을 우리 데이터에서 만든다 (JS, 파이썬과 대조)

- **리프 도형을 예제에 싣는다.** 5 예제 합계: 원본 1.8 MB, 압축 표현
  (`[layer, net, pin, x0, y0, x1, y1]`) 543 KB, gzip 82 KB. 첫 화면을 무겁게 하지 않도록
  `data/<예제>.leaves.json` 으로 떼어 배선할 때만 받는다. `pack-example.mjs` 와
  앞단 워커(`.sp` 업로드)가 같은 모양을 낸다.
- **`src/route/prep.mjs`**
  - `manipulate_hierarchy` 이식 — `remove_pg_pins` 재귀, `<이름>_PG<k>` 사본,
    `clean_if_extra` (파이썬 약 100 줄).
  - `PnRConstraintWriter.map_valid_const` 이식 — 예제가 쓰는 것부터: PowerPorts,
    GroundPorts, ClockPorts, SymmetricBlocks, SymmetricNets, Align, Order,
    HorizontalDistance, VerticalDistance, AspectRatio. **모르는 제약은 조용히 넘기지 않고 멈춘다.**
  - 리프 LEF 생성 (3 절의 규칙).
- 합격선: 5 예제에서 JS 산출물이 파이썬 prep 산출물
  (`3_pnr/inputs/<TOP>.verilog.json`, `*.pnr.const.json`, `<TOP>.lef`) 과 같다.
  기준값은 부록 A 의 `--dump` 로 뽑는다.

### 2 단계 — C++ 배선기를 독립 wasm 으로

NOTES-phase0 **S5 의 원래 결정(C ABI `route(json) -> json`)으로 돌아간다.**
S10/S11 에서 pybind11 로 바꾼 이유는 "router.py 450 줄을 한 줄도 안 건드리려고" 였다.
그런데 우리 경로에서 실제로 쓰는 파이썬은 300 줄 안팎이고, 전부 C++ 메서드를 부르는
접착 코드다. 그 대가로 Pyodide 판 고정, 휠 재태깅, `-sWASM_BIGINT` 맞추기,
파이썬 흐름 전체를 떠안았다.

| 파이썬 (ALIGN) | C++ 드라이버에서 |
|---|---|
| `build_pnr_model._ReadVerilogJson` (60 줄) | JSON 에서 hierNode 를 직접 짓는다 |
| `_attach_constraint_files` | 모듈마다 `ReadConstraint_Json(node, 문자열)` |
| `PnRdatabase()` | `ReadPDKJSON`, `ReadLEFFromString`, `semantic0/1/2` |
| `placer.place()` | `AddingPowerPins` -> `PlacerIfc(use_external_placement_info)` -> `Extract_RemovePowerPins` -> `CheckinHierNode` |
| `router.route_bottom_up` (70 줄) | 그대로 옮긴다 — `TraverseHierTree`, `CheckinChildnodetoBlock`, `AppendToHierTree` |
| `route_single_variant` | `ExtractPinsToPowerPins`, `RouteWork` 4·5 (+최상위 2·3). 중간 덤프 없음 |
| `gen_viewer_json` 이 hN 에서 읽는 것 | 모듈마다 넷 금속·비아·전원 격자·블록 변환을 JSON 으로 내보낸다 |

- 빌드: emcc 직접. `-sMODULARIZE -sEXPORT_ES6 -sALLOW_MEMORY_GROWTH -sENVIRONMENT=worker,node`,
  lp_solve 는 BLAS 외부 적재를 끈다 (2.4). pyodide-build 와 파이썬 판에 묶이지 않는다.
- 1차는 placer 를 그대로 링크한다 — 배치 주입(`setPlacementInfoFromJson`)은 변이·반전·
  핀·HPWL 까지 채우는 코드라 다시 쓰는 위험을 지금 지지 않는다(S12 후속과 같은 판단).
  2차에 직접 주입으로 바꾸면 321 KB 가 빠진다.
- 합격선: 같은 입력에서 **모듈별 배선 사각형 다중집합**이 파이썬 경로와 같다.
  같은 C++ 코드라 같아야 한다 — 다르면 순서 의존을 찾는다. `env.dlopen` import 없음.

### 3 단계 — 후처리를 JS 로

- 도형 합성: 리프 도형을 블록 변환으로 옮기고 배선 도형을 더한다. 계층이면 자식 모듈
  결과를 재귀로. 지금의 `<TOP>_0.json` 과 같은 모양이라 `view.mjs` 의 `drawRouted` 는 그대로다.
- DRC/LVS: `cell_fabric/remove_duplicates.py`(SHORT·OPEN·DIFFERENT WIDTH, 355 줄) +
  `drc.py`(비아·금속 규칙, 255 줄) + `postprocess.py`(47 줄) 이식. `DoNotRoute` 넷은
  열려도 된다(지금과 같다).
- GDS: 평면 GDSII 쓰기 (`layers.json` 의 GDS 층 번호). ALIGN 이 내는 `.python.gds` 와 같은 방식이다.
- 합격선: 5 예제에서 오류 목록이 파이썬과 같다. **일부러 망가뜨린 배치**(도형을 옮겨
  SHORT·OPEN·간격 위반을 만든 것)에서도 같다. GDS 는 `.python.gds` 와 경계 다중집합이 같다.

### 4 단계 — 갈아끼우고 걷어낸다

- `index.html`: `runRoute` 가 routeworker 를 부른다. `ensureFront` 와 앞단-배선 결합
  (`frontFor`, "같은 워커여야 한다")이 사라진다. 앞단 출력 JSON 을 올린 경우도 리프 도형이
  있으면 배선된다 (지금은 배치까지만).
- `frontworker.mjs`: PYROUTE 와 PnR 휠 적재를 지운다 — 앞단만 남는다 (704 줄 -> 200 줄 안팎).
- 지운다: `py/pnr/`, `scripts/wasm/` 의 휠 경로(축소 바인딩, retag-wheel), align-front.zip 의 pnr 쪽.
- README 의 구성·실측 표를 갱신한다.

### 위험

| 위험 | 대응 |
|---|---|
| C++ 드라이버가 hierNode 를 파이썬과 다르게 짓는다 | 1 단계 기준값 + 2 단계 사각형 다중집합 대조. 단계마다 파이썬 경로가 기준으로 남아 있다 |
| DRC 이식이 미묘하게 다르다 | 정상 5 예제 + 망가뜨린 배치로 대조 |
| 빌드 재료(ALIGN-public C++ 원본, boost 헤더, spdlog 1.9.2, nlohmann/json 3.7.3, lp_solve 5.5.2.11)가 이 저장소에 없다 | `symplace/setup.sh` 가 ALIGN-public @ 8d3cc2e 를 받는다. 나머지는 S6 에서 한 번 빌드해 본 판을 그대로 쓴다 |
| 커패시터·가드링 설계 | 지금도 안 된다 (`_skip_cap_placer` 가 멈춘다). 범위 밖으로 두고 입력에서 분명히 거절한다 |
| `.sp` 업로드는 여전히 Pyodide + libz3 가 필요하다 | 이번 범위 밖. 배선과 떨어지므로 나중에 따로 줄일 수 있다 |

---

## 부록 A — 재현 도구 (`scripts/route/node/`)

```bash
cd symplace/scripts/route/node
./setup.sh                                  # npm: pyodide@0.27.8, PyPI: 휠 4 개
node place.mjs telescopic_ota               # 페이지와 같은 배치 (10 s)
node route.mjs telescopic_ota --twice               # 두 번째 배선에서 죽는다
node route.mjs telescopic_ota --twice --blasfix     # 둘 다 산다
node place.mjs high_speed_comparator        # 3~4 분
node route.mjs high_speed_comparator --flatten=0 --blasfix --prof   # 계층 그대로 + 단계별 시간
```

받은 것과 배치 결과는 저장소 밖에 둔다 (`~/.cache/symplace/`, `PYODIDE_CACHE`·`SYMPLACE_CACHE` 로 바꾼다).

- `route.mjs` 는 `frontworker.mjs` 의 `FRONT`·`PYROUTE` 원문을 그 파일에서 읽는다.
  워커를 고치면 다시 돌리기만 하면 된다. `boot()` 의 적재 순서만 손으로 옮겨 두었다.
- 배선마다 `BLAS_idamax` 값, 남은 `libmyBLAS.so` 등록, LP 생성 수, wasm 힙을 찍는다.
- `--dump=<폴더>` 는 Pyodide 안의 `/work/<예제>` 를 꺼낸다 — 1·3 단계의 기준값이다.
- 시간은 node 기준이다. 브라우저는 받는 시간이 더해진다.

## 부록 B — 짚은 순서

1. 두 번 연속 배선에서 telescopic_ota 도 죽는 것을 보고, 충돌 오프셋을 wasm-objdump
   (npm `wabt`) 로 짚었다 -> `idamax` 의 `call_indirect`.
2. `init_BLAS`/`load_BLAS`/`make_lp` 를 역어셈블해 dlopen 시도와 실패 경로를 읽었다.
3. Pyodide 의 `GOT` 와 HEAP 을 직접 읽어 배선 전후의 `BLAS_idamax` 를 봤다 —
   1 회차 뒤 43740 (= `my_idamax`), 2 회차 충돌 때 0.
4. `LDSO.loadedLibsByName` 에 `libmyBLAS.so` 가 `exports: "loading"` 으로 남아 있는 것을 봤다.
5. 그 이름을 등록되지 않게 막고 다섯 예제를 다시 돌렸다 — 두 번 연속, 계층 그대로 전부 통과.

libz3 와의 심볼 충돌도 의심해 봤는데 없었다 (libz3 가 `global` 로 먼저 올라가 GOT 를
선점하지만, libz3 가 내보내는 844 개와 PnR 의 import — GOT 2,333 개, 함수 2,243 개 —
사이에 겹치는 이름이 0 개다).
