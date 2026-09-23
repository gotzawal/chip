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
3. **계획: 배선에서 파이썬을 빼고, 배선기는 Rust 로 새로 짠다.** ALIGN 의 C++ 배선기를
   옮기는 대신(우리 경로만 2 만 4 천 줄) 이 PDK 와 이 크기에 맞춘 격자 배선기를 새로 짜서
   wasm 하나로 돌린다. 심판(DRC/LVS)은 ALIGN 의 검사기를 JS 로 옮겨 파이썬과 대조한다.
   예제는 리프 도형만 더 실으면(5 개 합계 gzip 82 KB) Pyodide 없이 배선된다.
   Pyodide 워커는 `.sp` 를 올릴 때(앞단)만 뜬다. (4 절)

**진행.** 0 단계 끝남 (`4c907d4`): 워커의 BLAS 우회로 5 예제가 두 번 연속, 계층 그대로
배선된다 (DRC 0/4/0/1/0). 나머지는 4 절의 순서대로.

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
(배선기를 Rust 로 새로 짜기로 했으므로(4 절) 이 휠은 다시 빌드하지 않는다. JS 우회는
파이썬 배선 경로를 걷어낼 때 같이 사라진다.)

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

## 4. 계획 — 배선기를 Rust 로 새로 짠다

### 4.1 왜 C++ 을 옮기지 않고 새로 짜는가

ALIGN 원본(`8d3cc2e`, 이 저장소가 고정한 판)을 재 봤다. 옛 라우터(모드 0·1)는
`assert(0)` 로 막혀 있어 죽은 코드고, 우리 경로(RouteWork 4·5·2·3)는
`RawRouter -> GcellGlobalRouter -> GcellDetailRouter -> PowerRouter` 에 격자·그래프·A* 다.

| 1:1 로 옮긴다면 | 규모 |
|---|---|
| 라우터 중 우리 경로 (옛 라우터 3.8K 제외) | 19.4K 줄 |
| PnRDB (데이터 모델, PDK/LEF/제약 읽기, 계층 연산 — WriteJSON 제외) | 4.6K 줄 |
| lp_solve — 전역 배선의 0-1 ILP (후보 스타이너 트리 고르기) | Rust MILP 로 바꿔야 한다 |
| placer 13.5K 줄 | 필요 없다 — 배치는 좌표로 바로 넘긴다 |

2 만 4 천 줄을 옮겨도 가벼워지는 몫은 작다. 무거운 것은 C++ 이 아니라 파이썬 스택이었고,
C++ 알맹이는 이미 1~4.5 초, 독립 빌드로 1.5 MB 안팎이다. 대신 문제가 작고 규칙이 단순하다:

| 예제 | 크기 | 트랙 M1/M2/M3/M4 | 격자 노드 | 넷 (모든 모듈) |
|---|---|---|---|---|
| telescopic_ota | 1492 x 11844 | 18/141/18/141 | 12k | 15 |
| current_mirror_ota | 8852 x 2436 | 110/29/110/29 | 15k | 10 |
| five_transistor_ota | 4212 x 5964 | 52/71/52/71 | 17k | 8 |
| cascode_current_mirror_ota | 6532 x 11844 | 81/141/81/141 | 53k | 24 |
| high_speed_comparator | 6132 x 10668 | 76/127/76/127 | 45k | 30 |

PDK(FinFET14nm_Mock_PDK/layers.json)는 층마다 한 방향, 고정 피치·고정 폭이다.

| 층 | 방향 | 피치 | 폭 | MinL | EndToEnd |
|---|---|---|---|---|---|
| M1 / M3 | 세로 | 80 | 32 / 40 | 180 / 210 | 48 |
| M2 / M4 | 가로 | 84 | 32 / 40 | 200 / 140 | 48 / 65 |
| M5 / M6 | 세로 / 가로 | 144 | 64 | 100 / 360 | 65 / 70 |

비아 V1·V2 는 32x32 (V3 40x40), 둘러싸기는 금속 방향으로 20, 비아 간격(V1 48/52,
V2 48/40, V3 40/44)은 **이웃 격자점끼리 정확히 맞게** 잡혀 있다 — 격자 위에 놓기만 하면
비아 간격은 저절로 지켜진다. 남는 규칙은 끝단 간격(EndToEnd), 최소 길이(MinL),
비아 둘러싸기뿐이다. 트랙 격자 위의 A* 에 맞는 모양이다.

언어: 이 크기면 JS 로도 A* 한 번이 수 ms 라 성능 때문에 Rust 가 필요하지는 않다.
Rust 를 고른 것은 기하 코드에서 타입이 실수를 잡아 주고, 더 큰 설계로 갈 여유가 있어서다.
`wasm32-unknown-unknown` 으로 빌드하면 JS 접착 코드가 없다 — serde_json 을 넣은 시험
모듈이 97 KB, import 0 개였다. 경계를 JSON 으로 두므로 나중에 언어를 바꿔도 앞뒤는 그대로다.

### 4.2 목표 모양

```
index.html
 ├─ worker.mjs -> src/job.mjs                  배치 (그대로)
 ├─ routeworker.mjs  (새로)                    배선 — Pyodide 없음
 │    src/route/problem.mjs   설계 + 배치 + 리프 도형 -> 배선 문제
 │                            (펼친 넷리스트, 핀, 장애물, 대칭 넷, 전원 넷)
 │    route/router.wasm       Rust 배선기 (소스 symplace/router), route(json) -> json
 │    src/route/compose.mjs   리프 도형 + 배선 도형 -> 레이어별 사각형
 │    src/route/check.mjs     DRC/LVS (ALIGN cell_fabric 이식)
 │    src/route/gds.mjs       GDS 쓰기
 └─ frontworker.mjs  (앞단만)                  .sp 를 올릴 때만 — Pyodide + libz3
data/<예제>.leaves.json                         리프 전체 도형 (배선할 때만 받는다)
```

| | 지금 | 목표 |
|---|---|---|
| 예제 배선에 받는 것 | 약 40 MB | 배선기 수백 KB + 리프 도형 수십 KB |
| 차가운 클릭 (node) | 13~20 s | 배선기 시간 + JS 앞뒤 |
| 앞단과 배선 | 같은 워커에 묶여 있다 | 떨어진다 |

### 4.3 순서와 합격선

**0 단계 — 끝남** (`4c907d4`). BLAS 우회 한 줄, 펼치기 제거, 워커 재사용, align-front.zip
1.9 -> 0.2 MB, README. 5 예제 두 번 연속 배선, DRC 0/4/0/1/0. 새 배선기가 합격할 때까지
이 경로가 폴백이자 기준선이다.

**1 단계 — 리프 도형과 배선 문제 (JS).**
- `data/<예제>.leaves.json`: 리프 전체 도형의 압축 표현 (`[layer, net, pin, x0, y0, x1, y1]`).
  앞단 워커(`.sp` 업로드)도 같은 모양을 낸다.
- `src/route/problem.mjs`: 하위 모듈을 펼쳐 절대 좌표로(변환 합성), 넷 이름 가르기
  (하위 모듈 포트 -> 상위 넷, 전역 넷은 그대로, 내부 넷은 `<인스턴스>_<넷>`), 핀·장애물을
  리프 도형에서, `SymmetricNets` 의 핀 참조를 펼친 소자 핀으로 옮기기, 전원 넷.
- 합격선: 지운 `test/flatten.py` 의 검사를 JS 로 — 이름이 안 겹친다, 개수, 좌표가 계층으로
  읽은 것과 정확히 같다, bbox 안, 넷 묶음(핀의 분할)이 계층 넷리스트와 같다, 대칭 넷의 핀이
  실재한다. 더해서 ALIGN 이 배선한 결과(`<TOP>_0.json`)의 핀 넷 이름과 우리 핀 넷 이름이 같다.

**2 단계 — 심판: DRC/LVS · 도형 합성 · GDS (JS).** 새 배선기의 좋고 나쁨을 가를 기준이라
배선기보다 먼저다.
- `check.mjs`: `cell_fabric/remove_duplicates.py`(SHORT·OPEN·DIFFERENT WIDTH, 355 줄) +
  `drc.py`(255 줄) + `postprocess.py`(47 줄) + `gen_viewer_json` 의 격자 밖 검사.
- `compose.mjs`: `gen_viewer_json` 이 하는 도형 합성. `gds.mjs`: `gen_gds_json.translate` +
  GDSII 쓰기.
- 합격선: ALIGN 이 배선한 5 예제(하네스 `--dump` 로 뽑은 검사기 입력)에서 오류 목록이
  파이썬과 같다. 일부러 망가뜨린 배치(도형을 옮겨 SHORT·OPEN·간격·최소 길이 위반을 만든 것)
  에서도 같다. GDS 는 ALIGN 의 `.python.gds` 와 경계·라벨 다중집합이 같다.

**3 단계 — Rust 배선기** (`symplace/router`).
- 격자: x 는 M1/M3 트랙(80), y 는 M2/M4 트랙(84). 신호는 M1~M4, 필요하면 M5/M6.
- 장애물: 리프 도형(M1·M2·V1·V2), 다른 넷의 도형과 그 끝단 간격 후광.
- 핀 접근: 리프 핀(M2) 안의 격자점 중 비아 둘러싸기를 지키는 곳.
- 넷: 다중 핀은 이미 이은 트리에서 가장 가까운 핀으로 A*. 충돌은 협상형 재배선(PathFinder).
- 규칙 마무리: 최소 길이 늘리기, 끝단 간격, 비아 둘러싸기를 **정확한 구간 계산**으로.
- 대칭 넷: 한쪽을 배선하고 축에 대해 거울로. 축은 40 의 배수라 거울 경로도 트랙 위다.
- 합격선, 차례로: (a) telescopic 신호 넷 DRC/LVS 0 -> (b) 평면 셋 (current_mirror 는
  리프 고유 4 건만) -> (c) 대칭 넷 거울 배선 -> (d) 전원 넷 -> (e) 계층 둘 DRC/LVS 0 ->
  (f) 배선 길이·비아 수·시간을 ALIGN 과 표로, 페이지 "배선 · 나란히" 로 눈으로.
- 빌드: `cargo build --release --target wasm32-unknown-unknown`, 산출물 `route/router.wasm` 을
  커밋한다. 내보내는 함수는 `alloc` · `route` · `out_len` 셋. node 와 브라우저가 같은 파일을 쓴다.

**4 단계 — 갈아끼우고 걷어낸다.**
- `index.html`: `runRoute` 가 routeworker 를 부른다. `ensureFront` 와 앞단-배선 결합이 사라진다.
  앞단 출력 JSON 을 올린 경우도 리프 도형이 있으면 배선된다.
- `frontworker.mjs`: PYROUTE 와 PnR 휠 적재를 지운다. PYROUTE 는 하네스로 옮겨 ALIGN 기준
  경로로 남긴다 (대조용).
- 지운다: `py/pnr/`, `scripts/wasm/` 의 휠 경로. README 의 구성·실측 표를 갱신한다.

### 4.4 위험

| 위험 | 대응 |
|---|---|
| 새 배선기가 어떤 설계에서 DRC 0 에 못 닿는다 | 전환 기간에는 0 단계 경로를 폴백으로 둔다. 5 예제 합격 뒤 걷어낸다 |
| 핀 접근이 까다롭다 (핀은 M2, 그 아래 M1 은 소자 내부 배선) | 핀 안의 격자점만 쓰고 V2 로 올라간다. 둘러싸기를 격자점 단위로 미리 거른다 |
| 끝단 간격과 최소 길이가 서로 걸린다 | 라우터 안에서 정확한 구간으로 검사하고, 어긴 자리는 비용을 올려 다시 배선한다 |
| 대칭 거울 경로가 막힌다 | 대칭을 깨고 따로 배선하되 보고한다 |
| 심판 이식이 미묘하게 다르다 | 정상 5 예제 + 망가뜨린 배치로 파이썬과 대조 |
| 커패시터·가드링 | 지금도 안 된다. 입력에서 분명히 거절한다 |
| `.sp` 업로드는 여전히 Pyodide + libz3 | 이번 범위 밖. 배선과 떨어지므로 나중에 따로 |

## 부록 A — 재현 도구 (`scripts/route/node/`)

```bash
cd symplace/scripts/route/node
./setup.sh                                  # npm: pyodide@0.27.8, PyPI: 휠 4 개
node place.mjs telescopic_ota               # 페이지와 같은 배치 (10 s)
node route.mjs telescopic_ota --twice               # 워커 그대로: 둘 다 산다
node route.mjs telescopic_ota --twice --no-blasfix  # 우회를 끄면 두 번째에서 죽는다
node place.mjs high_speed_comparator        # 3~4 분
node route.mjs high_speed_comparator --prof # 계층 그대로 + 단계별 시간
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
