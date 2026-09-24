# 배선기를 ALIGN 알고리즘 그대로 Rust 로 — 계획 (2026-09-23)

먼저 새로 짰던 격자 배선기(`symplace/router`, 계획 문서 `PLAN-route.md` — 둘 다 걷어냈다, 커밋 `0e04d6a` 까지)는 ALIGN 과 다른 독립 배선기였다. 결과가
ALIGN 과 달라 쓸모가 없다고 봐서, ALIGN 의 C++ 배선 알고리즘을 그대로 Rust 로 옮긴다. 이 문서는 ALIGN
배선 코드를 네 갈래(입력 DB, 전역 배선, 상세 배선, 전원)로 읽고 돌려 본 결과와, 그에 따른 순서다.
조사에 쓴 도구와 기준값 만드는 법은 `scripts/route/align-ref/` (부록 A).

## 결과 (2026-09-23) — 끝났다

계획대로 옮겼고 **ALIGN 과 같다**. 페이지의 "배선 실행" 이 이 길이다 (`src/route/pipeline.mjs` +
`src/route/alignroute.wasm`, 소스 `symplace/alignroute/`).

> **나중에 걷어낸 것.** 이식이 끝나 ALIGN 원본은 더 쓰지 않는다. 대조에 쓰던 것 — 페이지의
> "배선 · ALIGN 원본" 버튼과 "배선 대조" 카드, Pyodide 에 PnR 휠을 올리던 `alignworker.mjs`·`py/pyroute.py`·
> `py/aligntap.py`·`py/pnr/`, node 하네스(`scripts/route/node/align.mjs`, `route.mjs`, `checkref.mjs`,
> `mutate.mjs`), 부록 A 의 도구(`scripts/route/align-ref/`), 기준 덤프와 견주던 시험(`test/aligndb.mjs`,
> `test/alignroute.mjs`, `test/route.mjs`), 휠 빌드(`scripts/wasm/`) — 는 저장소에서 뺐다. 아래 글과 표는
> 그것들이 있던 때의 기록이다. 필요하면 git 기록에서 꺼낸다 (마지막으로 들어 있던 커밋 `6655430`).

| 단계 | 어디 | 대조 |
|---|---|---|
| 입력·PnRDB·배치 심기·계층 부기 (1) | `src/route/align/` (JS) | 10 판 20 모듈 필드마다 (`test/aligndb.mjs`) |
| 전역 배선, 모드 4 (3) | `alignroute/src/gr` + lp_solve C 소스 | 기준 20 회 + 제약 변형 30 회, ALIGN C++ 네이티브 빌드와 무작위 7,000 회 (내부 상태까지) |
| 상세 배선, 모드 5 (4) | `alignroute/src/dr` (libc++ 18 sort 이식 포함) | 기준 20 회 + 흔든 배치 87 회 + 제약 변형 14 회. ALIGN C++ 을 clang++ + libc++ 18 로 네이티브 빌드한 오라클과 무작위 6,600 회 — 모드 5 차이 없음 (도구 `scripts/route/align-ref/dr/`) |
| 전원 격자·전원 배선, 모드 2·3 (5) | `alignroute/src/pr` | 기준 20 회 + 막기 시험 16 회 |
| 한 판 잇기 (6·7) | `src/route/pipeline.mjs` | 5 예제 x 두 배치, 흔든 배치 47 판, 제약 변형 14 판: 모듈마다 최종 도형(차례까지)·GDS·오류 문구·단계 기록 (`test/route.mjs --router=wasm`) |

- 시간 (브라우저): telescopic_ota 0.22 s (ALIGN 원본 4.1 s), high_speed_comparator 0.57 s (14.0 s).
  예상(0.6~5 s)보다 빠르다. wasm 1.3 MB.
- 옛 독립 배선기(`symplace/router`, `router.wasm`, `problem.mjs`)는 걷어냈다.
- ALIGN 자신이 죽는 입력이 있다 (부록 C). 거기서는 견줄 기준이 없다.
- 아래는 계획 당시의 글이다 (4 절의 `symplace/router`, `router.wasm` 은 `symplace/alignroute`,
  `alignroute.wasm` 이 됐다).

## 요약

- **목표**: 같은 입력(설계, 리프 도형, 배치, PDK)에서 ALIGN 배선기(축소 PnR 휠 `pnr-0.9.8`,
  emscripten 3.1.58, libc++ 18.1.2)와 **같은 도형** — 넷·층·좌표·순서까지, 단계마다(전역 배선, 상세 배선,
  전원 격자, 전원 배선). DRC/LVS 결과도 ALIGN 과 같다.
- **ALIGN 결과는 결정적이다** — 같은 배치를 따로·같은 프로세스에서 두 번 돌려도 단계마다 같다 (1.2).
  그래서 "같다" 로 합격을 가를 수 있다.
- **옮길 C++** (우리 흐름에서 실제로 닿는 곳만): 전역 배선 약 2.1K 줄, 상세 배선 약 5.6K 줄(그중 알맹이
  2.5~3K), 전원 격자·전원 배선 약 4.2K 줄(상세 배선과 겹치는 도우미가 많다). Rust 로 7~8K 줄쯤이다.
- **이미 맞춰 본 것**:
  - 입력 DB(PDK -> Drc_info, LEF, 계층, 배치 주입, bottom-up 부기)를 파이썬으로 다시 지으면 ALIGN 이 배선기에
    넘기는 hierNode 와 10 모듈 전부 필드마다 같다.
  - 전원 격자·전원 배선의 파이썬 시제품이 10/10 (+ 일부러 막은 3 회) 같다.
  - lp_solve 를 같은 C 소스로 clang wasm32 빌드하면 기준 휠의 lp_solve 와 410/410 비트까지 같다. Rust
    (wasm32-wasip1) 에 정적 링크해 JS 에서 부르는 것까지 확인했다.
- **정한 것**:
  1. 경계: **JS 가 DB 와 계층 부기를, Rust 가 "모듈 하나 배선"**(RouteWork 4 + 5, 최상위는 + 2 + 3)을 맡는다.
     주고받기는 JSON, PnRDB 단위(nm 의 2 배).
  2. **lp_solve 는 옮기지 않고 C 소스 그대로 같이 빌드한다.** 전역 배선 ILP 는 최적해가 수백~수천 개씩
     겹쳐서 다른 풀이기는 다른 배선을 고른다 (2.2).
  3. **libc++ 18.1.2 의 `std::sort` 를 옮긴다** (핀 순서 정렬, 동점과 어긋난 비교 함수).
  4. **버그까지 그대로 옮긴다** (부록 B). 고치면 결과가 달라진다 — 조사에서 하나씩 꺼 보고 확인했다.
- **값**: 배선이 지금 1~11 ms 에서 ALIGN 과 비슷한 0.6~5 s 로 느려진다 (예제당, wasm). 배선기 wasm 은
  lp_solve 까지 0.6~0.8 MB (gzip 0.25~0.3 MB) 로 예상한다 — 지금 178 KB, 예전 경로 약 40 MB.
- **알고 가야 할 ALIGN 의 실제 모습**: 대칭 넷은 전역 배선에서 사실상 꺼져 있고(축 좌표가 늘 -1),
  상세 배선에서 짝 넷 경로의 거울상 쪽으로 약하게 당기는 값뿐이다. 전역 배선 ILP 는 대개 lp_solve 가 처음
  찾은 정수해를 그대로 쓴다. 비아가 두 번씩 나가는 등 버그가 여럿 있다. "ALIGN 과 같다" 는 이것까지 같다는 뜻이다.

## 1. 기준 — ALIGN 이 내는 것

### 1.1 흐름 (우리 설정: `router='astar'`, `router_mode='bottom_up'`, ADR·PDN 끔)

```
router_driver                      align/pnr/router.py
  gen_DB_verilog_d                 PnRDB: PDK(layers.json) -> Drc_info, LEF, verilog, 제약
  hierarchical_place               모듈마다 PlacerIfc(use_external_placement_info) — 우리 배치 주입
                                     AddingPowerPins -> 배치 주입 -> Extract_RemovePowerPins -> CheckinHierNode
  route_bottom_up                  TraverseHierTree 순서 (하위 모듈 먼저, 최상위 마지막)
    모듈마다:
      CheckoutHierNode, UR=(w,h), 하위 블록에 배선된 자식 넣기 (CheckinChildnodetoBlock)
      route_single_variant
        ExtractPinsToPowerPins
        RouteWork 4  GcellGlobalRouter(node, drc, Lmetal, Hmetal)       전역 배선
        RouteWork 5  GcellDetailRouter(node, GGR, 1, 1)                  상세 배선 (4 의 객체를 받는다)
        최상위만:
        RouteWork 2  PowerRouter(..., power_grid_metal_l/u, 1, h/v_skip)  전원 격자
        RouteWork 3  PowerRouter(..., power_routing_metal_l/u, 0, ...)    전원 배선
      AppendToHierTree, 부모 기록
  gen_viewer_json (모듈마다)       도형 합성 + DRC/LVS  -> 우리 compose.mjs · check.mjs
```

이 PDK 의 `Design_info`: 신호 배선층 **M1~M5** (0~4), 전원 격자 **M5/M6** (4~5), 전원 배선 M1~M6 (0~5),
`h_skip_factor` 7, `v_skip_factor` 8 (layers.json 에 없어 C++ 기본값). `pnr.const.json` 의 `Route` 제약이
신호 배선층 범위를 바꿀 수 있다. PnRDB 좌표는 nm 의 2 배다 (M2 폭 32 nm -> 64).

### 1.2 ALIGN 결과는 결정적이다

같은 배치를 따로 두 번, 같은 프로세스에서 두 번(`route.mjs --twice`) 배선해 단계별 덤프를 맞췄다.

| 예제 | 모듈 | 전역 배선 | 상세 배선 | 전원 격자 | 전원 배선 | 최종 |
|---|---|---|---|---|---|---|
| telescopic_ota | 1 | 같다 | 같다 | 같다 | 같다 | 같다 |
| high_speed_comparator | 5 (하위 4 + 최상위) | 같다 | 같다 | 같다 | 같다 | 같다 |

다른 것은 GDS 구조 이름의 숫자 꼬리(실행마다 새로 붙는 번호)뿐이다. 조사한 코드에도 난수·시각·포인터
순서가 결과에 닿는 곳이 없다 (lp_solve 의 예외 하나는 3 절).

### 1.3 기준 배선 10 회

5 예제 x 두 배치(ALIGN 배치 = `data/<예제>.json` 의 place, 우리 배치 = 캐시의 페이지 배치)를 RouteWork 탭으로
돌린 것 (`align-ref/tap/runall.mjs`). 시간은 C++ 호출만, wasm(node).

| 예제 | 배치 | 모듈 | 모드 4 | 모드 5 | 모드 2 | 모드 3 | 신호 금속/비아 (최상위) | 격자 VDD/GND | 전원 금속 | DRC/LVS |
|---|---|---|---|---|---|---|---|---|---|---|
| telescopic_ota | ALIGN | 1 | 37 ms | 0.51 s | 22 ms | 0.23 s | 21 / 27 | 36 / 36 | 18 | 0 |
| | 우리 | 1 | 20 ms | 0.55 s | 20 ms | 0.24 s | 19 / 22 | 40 / 39 | 18 | 0 |
| current_mirror_ota | ALIGN | 1 | 11 ms | 0.52 s | 17 ms | 0.31 s | 16 / 16 | 38 / 31 | 16 | 4 |
| | 우리 | 1 | 10 ms | 0.53 s | 17 ms | 0.29 s | 16 / 16 | 38 / 31 | 16 | 4 |
| five_transistor_ota | ALIGN | 1 | 8 ms | 0.37 s | 19 ms | 0.22 s | 6 / 6 | 39 / 39 | 10 | 0 |
| | 우리 | 1 | 15 ms | 0.40 s | 20 ms | 0.29 s | 8 / 10 | 44 / 36 | 10 | 0 |
| cascode_current_mirror_ota | ALIGN | 2 | 38 ms | 3.96 s | 47 ms | 1.25 s | 49 / 80 | 120 / 120 | 49 | 6 |
| | 우리 | 2 | 35 ms | 3.86 s | 45 ms | 1.41 s | 44 / 72 | 120 / 120 | 49 | 1 |
| high_speed_comparator | ALIGN | 5 | 36 ms | 2.69 s | 41 ms | 1.38 s | 46 / 77 | 111 / 106 | 49 | 0 |
| | 우리 | 5 | 38 ms | 2.45 s | 42 ms | 1.18 s | 43 / 82 | 123 / 94 | 49 | 0 |

- DRC/LVS 가 0 이 아닌 것은 전부 리프 셀 안 Rvt 층의 DIFFERENT WIDTH 다 (배선이 만든 오류는 없다).
- 전역 배선의 LP 는 모듈마다 하나 — 설계당 1~5 개, 모듈당 칸(gcell) 5~10 개, 넷 2~16 개(칸을 넘는 넷 6 개 이하).
- 시간 대부분은 상세 배선(A*)과 전원 배선이다. 이식도 같은 알고리즘이라 비슷하게 걸린다.

## 2. 옮길 코드

줄 수는 ALIGN-public `8d3cc2e` 의 `PlaceRouteHierFlow/` 에서 우리 설정으로 실제로 닿는 함수만 센 것이다.

### 2.1 입력 만들기 — JS (PnRDB 와 bottom-up 부기)

파이썬 재구성(`align-ref/db/`, 약 1.0K 줄)이 ALIGN 이 `RouteWork(4)` 에 넘기는 hierNode 를 5 예제 10 모듈
전부 필드마다 똑같이 짓는다. 이것을 명세로 JS 로 옮긴다 (`src/route/align/` 에 둘 생각).

| 단계 | ALIGN | 할 일 |
|---|---|---|
| PDK | `ReadPDKJSON` | Drc_info: 금속·비아 표(2 배), 비아 모델(둘러싸기 사각형), `V0` 이 맨 뒤(14), `unit_R = Mean*0.0005` |
| 리프 | `gen_lef` + `ReadLEF` | 리프 JSON -> LEF 문자열 -> 같은 규칙으로 읽기 (줄 단위, LAYER 마다 첫 RECT 만, 비아는 비아 모델로) |
| 계층 | `_ReadVerilogJson`, `semantic0/1/2` | 넷 순서 = 처음 나온 순서 (이것이 배선 순서다), 전원 넷을 PowerNets 로 (VSS, VCC 순) |
| 제약 | `PnRConstraintWriter` + `ReadConstraint_Json` | 배선기가 읽는 것: SymmNet, ShieldNet, MultiConnection, DoNotRoute, Route (+ 크기를 바꾸는 Boundary). 전원 넷을 떼기 **전에** 읽는다 |
| 배치 | `setPlacementInfoFromJson` + `UpdateHierNode` | 좌표 2 배, 뒤집기는 블록 크기로. **bbox 는 무시** (모듈 크기 = 블록이 닿는 최대), LL/UR 은 (0,0) |
| 부기 | `AddingPowerPins`, `Extract_RemovePowerPins`, `CheckinHierNode`, `CheckinChildnodetoBlock`, `ExtractPinsToPowerPins` | 이름으로 첫 짝 찾기, 배치 때 핀을 M1 로 두기, 전원 핀 전파, 첫 가짜 핀에서 끊기 |
| 출력 | `gen_viewer_json` 의 wires | 넷마다 블록 핀 -> 경로 금속 -> 비아(위·아래·비아), 전원 넷 같이, 그 다음 GND 격자, VDD 격자. bbox 는 배선 뒤 LL/UR (전원 격자로 음수까지 커진다) |

알게 된 것:
- 배치 주입은 좌표를 바꾸지 않는다 (격자 맞춤·난수 없음).
- 대칭 넷의 축 좌표(`axis_coor`)는 어디서도 안 쓰인다 — 주석 처리된 코드 안에 있다. 그래서 늘 -1 이다.
- JS 의 정수 나눗셈은 `Math.trunc` 로 (C++ 은 0 쪽으로 자른다, 파이썬 `//` 은 내린다). 5 예제의 좌표는 전부
  짝수라 차이가 드러나지 않았지만 전원 격자에서 음수가 나온다.

### 2.2 전역 배선 — 모드 4 (Rust + lp_solve)

`GcellGlobalRouter`, `GlobalGrid`, `GlobalGraph` 에서 약 2.7K 줄(주석 빼고 2.1K)이 닿는다. `Grid`,
`A_star`, `Graph` 는 안 닿는다.

1. **칸 격자**: 금속층마다 칸 층 하나. 칸 크기는 트랙 100 x 100 (모듈 넓이가 1e6 단위² 아래면 20 x 20 —
   넓이 곱이 32 비트로 넘쳐서 사실상 이 둘뿐이다). 이 PDK 는 16000 x 16800.
2. **용량**: 칸 경계를 지나는 트랙 수에서 장애물 한 개마다 1.5 를 빼고 버림. 비아 용량은 넓이/비아 간격.
3. **핀 -> 칸**, 넷마다 **후보 트리 5 개**: 모든 칸에서 다익스트라로 트리를 키우고(같은 거리는 먼저 넣은
   것 먼저), 쓴 변의 무게를 두 배로 올려 다음 후보. 약한 반복 스타이너 한 단계.
4. **ILP**: 넷마다 후보 하나를 고르는 0-1 변수, 목적은 혼잡 비율 하나(연속 변수 s)의 최소. lp_solve 5.5.2.11,
   presolve PROBEFIX|ROWDOMINATE, 60 s 제한.

**lp_solve 는 옮기지 않는다.**
- 최적해가 심하게 겹친다: 합성 6~7 넷에서 최적에 닿는 배정이 128~8000 개, 그중 모양이 다른 것 3~126 가지.
- lp_solve 는 목적이 1 단위로 움직인다고 잘못 추정해(`MIP_stepOF`) 대개 **처음 찾은 정수해**를 낸다
  (브루트 포스 8 사례 중 4 개는 "OPTIMAL" 이라면서 최적이 아니었다).
- 후보 순서만 뒤집어도 399/399 사례에서 적어도 한 넷의 모양이 바뀐다.
- 그러니 다른 MILP 풀이기나 정확한 풀이로는 같은 배선이 안 나온다. lp_solve 를 다시 짜는 것(presolve, 스케일링,
  Devex 쌍대/원 심플렉스, LUSOL, 분지한정 — 닿는 곳만 3 만 줄 넘게)도 현실적이지 않다.
- **같은 C 소스를 같이 빌드하면 된다 (확인함)**:
  - 네이티브 gcc + `-DREALXP=__float128`: 450/450 에서 기준 wasm 과 해 벡터까지 비트로 같다 (80 비트
    long double 이면 고른 후보는 같고 목적값 끝자리가 2 번 다르다).
  - **clang 18 `--target=wasm32-wasi`** (이 환경, Debian wasi-libc): 27 파일 중 LP 파일 읽기 2 개(setjmp,
    ALIGN 이 안 부른다)만 빼고 빌드, 410/410 비트까지 같다 (`align-ref/ilp/wasi/`, 빌드 7 s, 풀기 0.44 s).
    wasm32 의 long double 은 binary128 이라 기준(emscripten)과 같다.
  - **Rust `wasm32-wasip1` cdylib 에 정적 링크**해 JS 에서 부르는 것까지 확인했다. JS 쪽은 WASI 함수 6 개를
    흉내 내고(환경 없음, 시각 0, 파일 없음 = EBADF, 출력은 버림) 나머지는 오류를 돌려주면 된다.
    시험 모듈 511 KB (gzip 200 KB).

### 2.3 상세 배선 — 모드 5 (Rust)

`GcellDetailRouter(node, GGR, 1, 1)` 에서 약 5.6K 줄이 닿고(파일 합계 11.4K), 결과에 닿는 알맹이는 2.5~3K
줄이다. `Grid` 는 `Grid(GlobalGrid&, ...)` 생성자(414 줄)와 작은 메서드 12 개쯤만 쓴다. 인자 `1, 1` 은
"연결마다 A* 한 번, 격자 = 트랙 피치" 이고 병렬 배선 장치는 전부 no-op 이 된다.

1. **핀 순서** (`SortPinsOrder`): 넷 중심에서 x+y (대칭 짝이 앞선 넷이면 (폭-x)+y) 로 `std::sort`, 그 다음
   앞의 핀들에 가장 가까운 순으로 다시 `std::sort` — 가까운 이웃 잇기.
2. **모듈 공통 집합**: 모든 블록 내부 금속·핀·비아 사각형(`Set_x`), 비아 위치(`Pset_via`).
3. **넷마다** (넷 순서대로, DoNotRoute 건너뜀, 전역 경로가 없으면 건너뜀):
   - 격자: 전역 경로의 칸 + 핀 칸의 칸 기둥 전체(+ 대칭 짝의 것)에서 트랙을 만든다. **칸 경계에서 같은
     점의 꼭짓점이 두 번 생긴다** — 지도에는 첫 것, 아래층 연결은 마지막 것.
   - 연결마다(핀 0 에서 시작해 정렬 순서로 하나씩): 다른 넷 도형을 끝단 간격만큼 불려 꼭짓점을 끄고,
     출발·도착 꼭짓점을 켜고, 비아 둘러싸기·간격으로 비아 자리를 끈다.
   - **A\***: 열린 목록은 `std::set<(f64 키, 꼭짓점 번호)>`. 값은 지나온 길이 x unit_R (층을 바꾸면 비아 R 더),
     도착까지 맨해튼 x unit_R, 도착과의 층 차 x 비아 R, 넷 중심까지 거리/1e10 의 합이다. 키는 여기에, 대칭
     짝이 이미 배선됐으면 그 거울 경로에서 떨어진 거리 x 0.2 를 더한 것이다(끌림). 층 안에서는 선호 방향으로만,
     층 사이는 위·아래. 최소 길이·비아 간격은 A* 중에 `Extention_check_prime` 으로만 본다.
   - 경로 -> 금속(같은 층 토막마다 하나, 끝 연장 없음, 길이 0 이면 비아 둘러싸기 사각형), 짧은 토막은 label 에
     따라 늘린다. 비아는 넷 전체 금속 쌍에서 다시 뽑아 **연결마다 두 번** 덧붙인다 (중복이 그대로 나간다).
   - 실패하면 재배선 없이 다음 연결로 (도착 핀만 출발 쪽에 더한다).
4. **출력** (`ReturnHierNode`): 넷마다 `path_metal`·`path_via`, 포트에 닿는 넷은 모듈 핀으로(`blockPins`),
   나머지는 모듈 내부 금속(`interMetals`)으로. 블록 내부 금속을 전부 덧붙인다. 단자 접점은 지운다.

### 2.4 전원 격자·전원 배선 — 모드 2·3 (Rust, 파이썬 시제품에서)

닿는 코드는 약 6.7K 줄(주석 빼고 4.2K)이다: 모드 2 약 1.1K, 모드 3 약 3.8K. 많은 부분이 상세 배선과 같은
도우미거나 서로 거의 같은 두 벌(`setSrcDest` 와 `_detail`)이다. 파이썬 시제품(`align-ref/power/`,
`pg_proto.py` 495 줄, `pr_proto.py` 973 줄)이 10/10 과 일부러 M5/M6 도형을 끼운 3 회에서 순서·좌표·중복
비아·bbox 까지 같다 — Rust 로는 이것을 옮긴다.

- **모드 2 (격자)**: `[0, max(UR, (2304, 2016))]` 에 M5(피치 288 x 8 = 2304)·M6(288 x 7 = 2016) 망을 치고
  VDD/GND 를 번갈아(M5 마지막 열의 짝홀이 M6 첫 행으로 이어진다) 준다. 장애물 점에서 끊고, 극성마다 가장 큰
  연결 덩이만 남긴다(재귀 DFS 의 부풀려진 호출 수로 센다). 이웃 꼭짓점 사이 토막마다 금속(양끝 64 연장),
  같은 극성끼리 만나는 곳에 V5. 5 예제는 M5/M6 에 닿는 도형이 없어 격자가 bbox 와 전원 넷 이름만으로 정해진다.
- **모드 3 (전원 배선)**: 전원 넷의 핀마다 따로, M1~M6 격자 A* (값 = 맨해튼 + 비아당 100) 로 자기 극성 M5
  토막 중 가까운 7 개(거리가 같으면 하나로 합쳐진다)까지. 뒤에 짧은 토막 늘리기와 비아 뽑기(핀마다 + 마지막
  한 번 더 덧붙인다). 끝나면 모듈 LL/UR 이 전원 격자까지 커진다 (예제는 (-104, -104) 부터).
- `merged_metals` 는 pybind 가 안 내보낸다 — 모드 2 에서 3 으로 Rust 안에서 넘긴다 (빼면 10 회 중 1 회가 다르다).

### 2.5 출력 -> 도형 합성

- 모듈마다 결과 hierNode 에서 `gen_viewer_json` 의 wires 를 같은 순서로 만든다 (파이썬 참고 `align-ref/db/wires.py`,
  30 줄 — 10 모듈에서 ALIGN 검사기 입력과 원소 순서까지 같다). 꼬리표(`blockPin`, `path_metal`, `path_via`,
  `power grid metal/via`)도 넘겨야 격자 밖 문구가 같다.
- 그 뒤는 지금 것 그대로: `compose.mjs` (도형 합성), `check.mjs` (DRC/LVS), `gds.mjs` (`.python.gds` 와 바이트까지).
- 참고: 예전 페이지(pyroute)가 내려받게 한 것은 C++ `WriteJSON` 이 쓴 `.gds` 였다. 우리는 ALIGN 의 파이썬 GDS
  (`.python.gds`) 를 기준으로 삼는다 — 검사기가 보는 도형과 같은 쪽이다.

### 2.6 옮기지 않는 것

배치 탐색(placer, 우리 배치를 주입만 한다), 옛 라우터(모드 0·1, `assert(0)`), Intel ADR(모드 6), PDN(모드 7)·MNA,
hanan 라우터, cap placer, guard ring, 중간 덤프·로그·그림 파일 쓰기(결과에 안 닿는다 — 실패 때 쓰는 Grid.txt 등도).

## 3. 같은 결과를 막는 것들과 대응

| 무엇 | 어디 | 대응 |
|---|---|---|
| lp_solve 의 해 고르기 | GcellGlobalRouter.cpp:1410-1744 | C 소스 그대로 링크 (2.2). 호출 순서·행 순서·presolve 를 같게. `get_variables` 가 N+1 칸을 쓰는 것도 |
| lp_solve 의 long double | lp_types.h (REALXP) | wasm32 에서 binary128 — clang wasm32 빌드면 같다 |
| lp_solve 의 BLAS 적재 | myblas.h (LoadableBlasLib 를 늘 켠다) | 실패하는 dlopen 을 줘서 내장 BLAS 로 — 기준도 그 길이다 |
| lp_solve 의 시각 씨앗 난수 | lp_utils.c:601 (섭동, 정체 때만) | 기준에서도 나온 적 없다. `perturb_count > 0` 이면 알린다 (ALIGN 자신도 그때는 결정적이지 않다) |
| `std::sort` 동점, 어긋난 비교 함수 | GcellDetailRouter.cpp:300-365 | libc++ 18.1.2 를 그대로 옮긴다: 2~5 개는 `__sort3/4/5`, 6~23 개는 삽입 정렬, 24 개부터 introsort (가운데 셋, 128 개 넘으면 ninther, 깊이 2·log2 n 에서 힙 정렬). Rust 의 안정 정렬은 비교 함수가 온전하고 23 개 이하일 때만 같다 — 단자·접점 없는 핀이 섞이면 비교 함수가 어긋난다 |
| A* 열린 목록 | A_star.cpp:1251-1351 | (f64 값, 꼭짓점 번호) 순서 집합. f64 계산 순서를 C++ 과 같게 (FMA 없음). 지울 때 새 값으로 찾는 것, 두 번째 탐색부터 Cost 를 INT_MAX 로 되돌리는 것까지 |
| 다익스트라의 같은 거리 | GlobalGraph.cpp:529-604 | `multimap` 은 같은 키를 넣은 순서로 — (거리, 일련번호) 키 |
| 꼭짓점 번호 | Grid.cpp:3140-3553 | 트랙 순서, 중복 꼭짓점(지도는 첫 것, 아래 연결은 마지막 것)까지 그대로 — 동점 순서와 늘리기 걸음이 번호에 기댄다 |
| 없는 점이 꼭짓점 0 이 된다 | GcellDetailRouter.cpp:4363-4429, 4598-4657 | `map[p]` 가 0 을 넣는다 — `lookup(p).unwrap_or(0)` 로 따라 한다 |
| `std::map::operator[]` 로 생기는 키 | GcellGlobalRouter.cpp:1070-1243 등 | 없는 이름·층이 0 으로 들어가고 뒤에서 보인다 — 같게 |
| 정수 넘침, 32 비트 long | GcellGlobalRouter.cpp:473, Rdatatype.h:78 | i32 wrapping (wasm32 는 int = long = 32 비트) |
| C 의 나눗셈·나머지 | 곳곳 | Rust i32 `/`, `%` 는 C 와 같다. JS 는 `Math.trunc` |
| f64 주고받기 | unit_R, 비아 R | JS 와 C++ 모두 IEEE 곱셈이라 같은 값. JSON 은 가장 짧은 표기로 쓰고 Rust `str::parse::<f64>`(정확 반올림)로 읽는다 |
| 기준 빌드의 NDEBUG, NRVO | (wasm 디스어셈블로 확인) | assert 는 없는 것으로. `Generate_Grid_Net` 의 격자 복사가 일어나지 않아 넷 중심이 A* 에 남는다 — 그대로 |
| 전원 격자 DFS | Graph.cpp:275-395 | 재귀 대신 명시적 스택, 같은 이웃 순서(N, S, E, W, 위, 아래)와 중복 방문 수 |
| `MetalComp` 가 자기와 비교 | Rdatatype.h:494 | 키가 (층, LP0.x, LP1.x, LP1.y) 가 된다 — 순서·중복 제거를 그대로 |
| 범위 질의가 공간이 아니라 사전 순 | RawRouter.cpp:80-180 | `FindsetPlist`, `Findset`, `findviaset` 를 사전 순 구간으로 그대로 |
| 정의되지 않은 동작 | 부록 B 끝 | 기준에서 관찰한 결과를 따라 하고, 그 길을 탄 사례는 기록해 알린다 |

해시 컨테이너 순회, 포인터 키 정렬, 호출 사이에 남는 전역 상태는 결과에 닿지 않는다 (확인함). 모듈마다
배선기를 새로 만들고, 모드 5 는 같은 모듈의 모드 4 객체만 받는다.

## 4. 경계 — JS 와 Rust

- **Rust 는 모듈 하나를 배선하는 순수 함수다**: `route(job) -> result` = RouteWork 4, 5, 최상위면 2, 3.
  자식 모듈 먼저. 계층 부기(체크인, 전원 핀 전파)는 JS 가 한다 — 이름 기반 규칙과 버릇이 많고 이미 파이썬으로
  검증된 명세가 있다.
- **RouteJob** (JS -> Rust, JSON, PnRDB 단위 i32): PDK 표(금속·비아·비아 모델), 층 범위와 skip, 모듈(이름,
  isTop, 크기, LL/UR), 단자, 넷(연결 목록 원래 순서, 대칭 짝·축 방향·축 좌표, 차폐, 다중 연결), 블록(선택된
  인스턴스만: 핀 접점·핀 비아·내부 금속·내부 비아), 전원 넷(핀), DoNotRoute, 배선층 제약.
  비아는 `[모델, x, y]` 로 보내고 사각형은 모델에서 되살린다 (예제 전부에서 성립함을 변환기에서 확인한다).
- **RouteResult** (Rust -> JS): 넷마다 `path_metal`(층, 폭, 두 점, 사각형)·`path_via`(C++ 벡터 순서, 중복 포함),
  모듈 핀(`blockPins`)·내부 금속/비아, 최상위면 VDD/GND 격자와 전원 넷 경로, 배선 뒤 LL/UR·크기, 배선 보고
  (핀마다 성공 여부 — `Router_Report.txt` 와 대조).
- 탭 덤프의 `10_*_route_in` / `11_*_route_out` 이 이 경계의 기준 쌍이다 (10 모듈 x 2 배치).
- **빌드**: `symplace/router` 를 그대로 쓰고 모듈을 갈아 끼운다. 대상은 `wasm32-wasip1` (lp_solve 가 libc 를
  쓴다). lp_solve 는 `build.sh` 가 clang 으로 정적 라이브러리로 빌드하고 `build.rs` 가 링크한다 (외부 크레이트
  없음, JSON 읽기·쓰기는 직접 — f64 는 `str::parse`). 산출물은 지금처럼 `src/route/router.wasm`.
  JS 는 WASI 흉내 몇 줄(`src/route/router.mjs`).

## 5. 순서와 합격선

모든 단계의 합격선은 **"기준과 글자 그대로 같다"** 다. 비교 대상은 탭 덤프(10 회)와, 8 단계부터는 흔든 배치.

0. **기준 도구 — 대부분 끝남.** `scripts/route/align-ref/` (부록 A): RouteWork 탭, DB 단계별 덤프, 파이썬
   재구성(DB, 전원), lp_solve 빌드·대조. 남은 것: 단계별 출력의 요약값(sha256)을 저장소 고정값으로
   (`web/placer/fixtures/align-route-*.json` — 큰 덤프는 캐시에서 다시 만든다).
1. **입력 만들기 (JS)** — `src/route/align/`: PDK, LEF, 계층, 제약, 배치 주입, 체크인, bottom-up, wires.
   합격: 10 회 모두 모듈마다 `route_in` 과 필드마다 같다. wires 가 검사기 입력(`check/<예제>.json`)과 같다.
2. **lp_solve 를 배선기 크레이트에** — 정적 라이브러리 + Rust FFI(함수 14 개) + JS WASI 흉내.
   합격: 합성 ILP 410 개(+ 흔든 것)가 Rust 를 거쳐도 기준 휠과 비트까지 같다. node 와 브라우저에서 뜬다.
3. **전역 배선 (모드 4)**. 합격: 모드 4 뒤 `tiles_total`, 넷마다 `GcellGlobalRouterPath`·`connectedTile` 이
   같다. 후보 트리 5 개와 ILP 행은 `harness.cpp` 방식으로 합성 격자에서도 맞춘다.
4. **상세 배선 (모드 5)** — 핀 정렬(libc++ sort), 격자, 장애물, 비아 규칙, A*, 늘리기, 출력.
   합격: 모든 모듈에서 넷마다 `path_metal`·`path_via`, `blockPins`, `interMetals`, `interVias`, 배선 보고가 같다.
5. **전원 격자·전원 배선 (모드 2·3)** — 파이썬 시제품을 옮긴다. 탭 입력으로 따로 시험되니 3·4 와 나란히 해도
   된다. 합격: `Vdd`/`Gnd`(merged 포함), `PowerNets` 경로, LL/UR 이 10 회 + 막은 3 회에서 같다.
6. **한 판 잇기** — JS bottom-up 이 모듈마다 Rust 를 부르고 자식을 부모에 넣는다. wires -> `compose.mjs` ->
   `check.mjs` -> `gds.mjs`. 합격: 10 회 모두 모듈마다 검사기 입력·오류 목록이 ALIGN 과 같고, 최상위
   `.python.gds` 가 바이트까지(시각 빼고) 같다.
7. **갈아끼우기** — `pipeline.mjs`·배선 워커가 새 경로를 부른다. 지금 배선기(`grid.rs`, `search.rs`, `legal.rs`,
   `sym.rs`, `problem.mjs` 의 펼치기)와 그 시험(`routefuzz.mjs`)을 걷어낸다. 페이지 상태 줄은 ALIGN 과 같은 말로
   (못 이은 핀 수 등). 브라우저에서 확인.
8. **흔든 배치 대조** — 예제마다 우리 배치기의 시작점·무게를 바꾼 배치 20 개쯤(합 100 개), 전원 쪽 막기
   시험(`power/stress`), 제약이 있는 설계(ALIGN `tests/files/test_circuits/high_speed_comparator_multiconnection`,
   pdk 예제 comparator 의 const, 예제에 ShieldNet·DoNotRoute·Route 를 붙인 것). 단계마다 기준과 같아야 한다.
   어긋나면 가장 작은 재현으로 줄여 고친다.

## 6. 크기·시간

| | 지금 배선기 | 이식 (예상) |
|---|---|---|
| Rust | 1,447 줄 | 7~8K 줄 (+ lp_solve C 소스는 빌드 때 받는다) |
| JS (배선 문제 / DB) | `problem.mjs` 204 줄 | DB·계층·wires 약 1.2K 줄 |
| wasm | 178 KB (gzip 42 KB) | 0.6~0.8 MB (gzip 0.25~0.3 MB) — lp_solve 가 반쯤 |
| 배선 시간 (예제당) | 1~11 ms | 0.6~5 s (ALIGN C++ wasm 과 비슷, 표 1.3) |
| ALIGN 과 같은가 | 아니다 | 같다 (합격선) |

## 7. 위험

| 위험 | 대응 |
|---|---|
| 예제가 안 건드리는 길(제약 대부분, Boundary, 다중 연결, 핀 실패, label 2·3·4, 한 모듈의 여러 variant) | 코드 그대로 옮기고 8 단계의 대상 설계로 기준과 맞춘다. 맞춰 보기 전에는 "확인 안 됨" 으로 적는다 |
| 정의되지 않은 동작에 기댄 결과 | 기준에서 본 것을 따라 하고, 그 길을 탄 사례를 로그로 남긴다 |
| 기준 휠이 결정적이지 않은 곳 (lp_solve 섭동) | 나온 적 없다. 나오면 알린다 |
| 느려진다 (ms -> s) | 워커에서 돌고 진행을 알린다. 결과를 바꾸는 최적화는 하지 않는다 |
| 커패시터·가드링 | ALIGN 도 축소 휠로는 못 했다. 입력에서 분명히 거절한다 |
| 큰 설계에서 재귀·스택 | 전원 DFS 는 명시적 스택. 다른 재귀(역추적)는 반복문으로 |
| `.sp` 올리기 | 앞단(Pyodide) 그대로. 배선은 앞단 출력의 리프 도형으로 같은 길을 탄다 |

## 부록 A — 조사 도구 (`scripts/route/align-ref/`)

지금은 저장소에 없다 — 커밋 `6655430` 에서 꺼낸다. 자세한 것은 그 폴더의 README. 요점:

- `tap/runall.mjs` — 5 예제 x 두 배치를 ALIGN 으로 배선하며 RouteWork 호출마다 앞뒤 hierNode·Drc_info 를
  `~/.cache/symplace/tap/` 에 (10 회 약 5 분).
- `db/dumphn.mjs` + `instrument.py` — DB 를 지은 뒤, 배치 주입 앞뒤, 배선 앞뒤를 덤프. `build_db.py` 가 그
  입력 파일만으로 전부 다시 짓고 대조한다 (ALL OK). `wires.py` 는 도형 합성 입력.
- `power/pg_check.py`, `pr_check.py` — 모드 2·3 파이썬 시제품 vs 탭 (ALL PASS). `stress/` 는 M5/M6 도형을 끼워
  격자 장애물·가장 큰 덩이·M6 버그를 태운다.
- `ilp/` — `harness.cpp` (후보 트리 + ILP 를 C++ 그대로 떼어 합성 격자에서, 동점 세기), `wasm_lp.mjs` (기준 휠의
  lp_solve 로 풀기), `wasi/build.sh` + `check.py` (clang wasm32 빌드와 비트 대조), `build-native.sh`.
- `wasm/` — 기준 휠 바이너리 읽기 (NDEBUG, NRVO 확인).

## 부록 B — 그대로 옮겨야 하는 버릇

고치면 결과가 달라지는 것들이다. 파일은 `PlaceRouteHierFlow/` 기준.

**입력·계층 (JS)**
- 배치의 모듈 bbox 를 안 쓴다. 모듈 크기는 블록이 닿는 최대 (+ Boundary 여백).
- 배치 때 모듈 핀의 층을 "M1" 로 둔다. 배선된 자식을 넣을 때 이름이 안 맞는 핀은 그 M1 도형이 남는다.
- 이름으로 찾을 때 첫 짝을 쓴다. 같은 이름의 모듈이 둘이면 마지막이 자식이 된다.
- `Extract_RemovePowerPins` 는 첫 가짜 전원 핀에서 멈춘다. `CheckoutHierNode` 는 원본에도 덮어쓴다.
- `placeTerminals` 는 넷의 첫 단자 연결만 지운다. `getData` 는 단자 접점 층을 -1 로 둔다.
- 넷별 최대 배선층을 `max(전역, 넷)` 으로 (GcellGlobalRouter.cpp:1083 — `min` 이어야 할 자리).

**전역 배선 (모드 4)**
- ILP 계수가 한 칸 밀린다: 변 사용을 `g+1` 로 적어 **다음** 후보의 변수에 걸린다. 마지막 후보는 안 나온다.
- 변 용량은 **마지막 넷**의 그래프에서 읽는다.
- 스타이너 후보 찾기는 칸 번호까지 키에 넣어서 단자 칸만 돌려준다 (다른 단자와 x 나 y 가 같은 것).
- `Iterated_Steiner` 는 가장 좋은 길이 대신 마지막 후보의 길이를 비교에 쓴다. 후보 목록이 5 번에 걸쳐 줄어든다.
- 대칭 지도는 축 **위의** 칸만 옮긴다. `MirrorSymSTs` 는 축 좌표 자리에 넷 번호를 넘긴다 — 그래서 대칭 행이 안
  생긴다.
- 모듈 넓이 곱이 32 비트로 넘친다. 비아 변의 무게는 0.
- `AdjustVerticalEdgeCapacityfrom*` 는 칸 번호와 좌표를 섞어 사실상 아무것도 안 한다.

**상세 배선 (모드 5)**
- 대칭 거울 축 = 두 넷 핀 중심 x 의 평균 — 가로축 대칭에도 x 로 계산한다 (GcellDetailRouter.cpp:404).
- 가로층 분기에서 x 범위를 y 값으로 계산한다 (GcellDetailRouter.cpp:4277, 4310, 4403, 4422).
- 세로층 도형은 끝단 간격만큼 두 번 불린다 (부르는 쪽과 함수 안).
- `path_via` 가 연결마다 두 번(늘리기 전·후) 덧붙고 비워지지 않는다.
- `Refresh_Grid` 가 연결마다 모든 꼭짓점을 다시 켠다 (앞의 끄기 몇 가지가 헛일이 된다).
- 늘리기 걸음(`Half/Head/Tail`)은 꼭짓점 **번호** ±1 로 걷는다 — 옆 트랙·중복 꼭짓점으로 샐 수 있다.
- `Pre_trace_back` 의 검사는 사실상 늘 참이다. 목적지는 닫지 않는다.
- 비아 간격 막기가 한쪽으로 치우친다 (x0-160 과 x0 은 막고 x0+160 은 안 막는다).

**전원 (모드 2·3)**
- 극성 깃발 하나를 모든 층이 나눠 쓴다 (M5 끝 열의 짝홀이 M6 첫 행으로).
- 가장 큰 덩이는 재귀 DFS 의 부풀려진 호출 수로 고르고, 같으면 먼저 것.
- `MergePowerMetal` 은 벡터 순서에 기댄다. 빈 벡터면 초기화 안 된 금속 하나를 넣는다.
- 가까운 M5 토막 7 개는 거리 키 `std::map` 이라 같은 거리가 하나로 합쳐진다.
- 격자 비아의 위 사각형을 두 번, 아래 사각형은 안 넣는다 (PowerRouter.cpp:1745-1746).
- `RedundantContact` 는 두 넷 모두 아래 접점은 VDD, 위 접점은 GND 병합 금속과 비교한다.
- A* 값이 `pair<int,int>` 에 들어가며 `(int)(DBL_MAX + M)` = INT_MIN 이 된다 (지우기가 헛돈다).
- 창을 [0, width] x [0, height] 로 자른다 — 작은 설계에서는 위쪽 격자 금속에 못 닿는다.

**정의되지 않은 동작 (기준에서 본 것을 따라 한다)**
- 없는 점 조회가 꼭짓점 0 을 만든다 (모드 3 에서 사례당 1~2 만 번, 결과에는 안 닿았다).
- `SinkDataComp` 의 크기 검사 오타로 한 점짜리 키를 읽을 때 범위를 넘는다 (예제에서는 안 탔다).
- `get_variables` 가 N 칸 배열에 N+1 개를 쓴다 (기준에서는 죽은 임시 변수를 덮는다).
- 빈 `node_L_path[0]` 읽기, 빈 multimap 의 `begin()` — 예제에서는 안 탔다.

## 부록 C — ALIGN 자신이 죽는 입력

기준이 없어 "같다" 를 가를 수 없는 경우다. 찾으면 여기에 적는다.

| 입력 | ALIGN (Pyodide) | Rust 이식 |
|---|---|---|
| high_speed_comparator + `Route` 제약 (M2~M5, vin_o·vip_o 는 M2~M3) | 최상위 전역 배선에서 `GlobalGraph::dijkstra` 가 길을 못 찾고 ("ulist empty") 널 함수 호출로 죽는다 | `Err("Empty path")` 로 멈춘다 — ALIGN C++ 네이티브 빌드도 같은 자리에서 `Empty path` 를 던진다 |
| high_speed_comparator, 우리 배치기의 흔든 배치 `b48-w4-l2` (인버터 하위 모듈이 두 줄로 쌓인 변형 640 x 4704) | 배선 **전**, 최상위 모듈의 배치 심기(`PlacerIfc` — `Placer::setPlacementInfoFromJson` 언저리)에서 `memory access out of bounds` 로 죽는다. 같은 배치에서 인버터만 옆으로 놓인 변형으로 바꾸면 안 죽는다 | 끝까지 간다 (DRC/LVS 0). 우리 JS 판은 배치 심기에서 배선기가 읽는 것만 옮겼다 — 배치 비용 셈(HPWL 등)과 `design`·`SeqPair` 생성은 옮기지 않았다 |

