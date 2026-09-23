# 배선기를 ALIGN 알고리즘 그대로 Rust 로 — 계획 (2026-09-23, 초안)

[PLAN-route.md](PLAN-route.md) 3·4 단계의 배선기는 ALIGN 과 다른 독립 배선기다 (5 절). 결과가
ALIGN 과 달라 쓸모가 없다고 봐서, ALIGN 의 C++ 배선 알고리즘을 그대로 Rust 로 옮긴다.

> 초안이다. 옮길 코드의 호출 그래프, 줄 수, 같은 결과를 막는 곳(정렬 동점, 해시 순서, lp_solve 등)은
> 코드를 읽는 중이고, 끝나면 2·3 절을 채운다. 1 절은 돌려서 확인한 것이다.

## 요약

- **목표**: 같은 입력(설계, 리프 도형, 배치, PDK)에서 ALIGN 배선기(축소 PnR 휠 `pnr-0.9.8`,
  emscripten 3.1.58)와 **같은 도형** — 넷·층·좌표까지, 단계마다(전역 배선, 상세 배선, 전원 격자,
  전원 배선). DRC/LVS 결과도 ALIGN 과 같아야 한다 (ALIGN 이 남기는 오류까지).
- **옮기는 것**: `Router::RouteWork` 의 모드 4 (`GcellGlobalRouter`), 5 (`GcellDetailRouter`),
  2·3 (`PowerRouter`)과 거기서 닿는 코드, bottom-up 계층 연산(PnRDB 의 Checkout/Checkin,
  TransformNode, 전원 핀 옮기기), 그 앞의 입력 만들기(PDK -> Drc_info, 리프 -> 핀·내부 금속,
  배치 주입)가 같은 값을 내게.
- **안 옮기는 것**: 배치 탐색(placer), 옛 라우터(모드 0·1, `assert(0)`), Intel ADR(6), PDN(7)·MNA,
  hanan 라우터, cap placer, guard ring, 중간 덤프 쓰기(WriteJSON 등).
- **그대로 쓰는 것**: 검사기(`check.mjs`), 도형 합성(`compose.mjs`), GDS(`gds.mjs`), 리프 도형
  (`data/*.leaves.json`), 배선 워커와 페이지. 지금 배선기(`symplace/router` 의 격자·협상·구간
  규칙)는 이식이 합격하면 걷어낸다.

## 1. 기준 — ALIGN 이 내는 것

### 1.1 흐름 (우리 설정: `router='astar'`, `router_mode='bottom_up'`, ADR·PDN 끔)

```
router_driver                      align/pnr/router.py
  gen_DB_verilog_d                 PnRDB: PDK(layers.json) -> Drc_info, LEF, verilog, 제약
  hierarchical_place               모듈마다 PlacerIfc(use_external_placement_info) — 우리 배치 주입
                                     AddingPowerPins -> 배치 주입 -> Extract_RemovePowerPins -> CheckinHierNode
  route_bottom_up                  TraverseHierTree 순서 (하위 모듈 먼저, 최상위 마지막)
    모듈마다:
      CheckoutHierNode, 하위 블록에 배선된 자식 넣기 (CheckinChildnodetoBlock)
      route_single_variant
        ExtractPinsToPowerPins
        RouteWork 4  GcellGlobalRouter(node, drc, Lmetal, Hmetal)       전역 배선
        RouteWork 5  GcellDetailRouter(node, GGR, 1, 1)                  상세 배선
        최상위만:
        RouteWork 2  PowerRouter(..., power_grid_metal_l/u, 1, h/v_skip)  전원 격자
        RouteWork 3  PowerRouter(..., power_routing_metal_l/u, 0, ...)    전원 배선
      AppendToHierTree, 부모 기록
```

이 PDK 에서 `Design_info` (RouteWork 탭으로 읽은 값): 신호 배선층 0~4 (**M1~M5**), 전원 격자
4~5 (**M5/M6**), 전원 배선 0~5 (M1~M6), `h_skip_factor` 7, `v_skip_factor` 8. `pnr.const.json` 의
`Route` 제약이 신호 배선층 범위를 바꿀 수 있다. PnRDB 좌표는 nm 의 2 배다 (M2 폭 32 nm -> 64).

### 1.2 ALIGN 결과는 결정적이다 (확인함)

같은 배치를 따로 두 번, 같은 프로세스에서 두 번(`route.mjs --twice`) 배선해 단계별 덤프를 맞췄다.

| 예제 | 모듈 | 전역 배선 | 상세 배선 | 전원 격자 | 전원 배선 | 최종 |
|---|---|---|---|---|---|---|
| telescopic_ota | 1 | 같다 | 같다 | 같다 | 같다 | 같다 |
| high_speed_comparator | 5 (하위 4 + 최상위) | 같다 | 같다 | 같다 | 같다 | 같다 |

다른 것은 GDS 구조 이름의 숫자 꼬리(`_1790144488` 같은, 실행마다 새로 붙는 번호)뿐이다. 그래서
"ALIGN 과 같은 도형" 은 잘 정의된 합격선이다.

### 1.3 기준값을 뽑는 도구

- **ALIGN 자신의 중간 덤프** — 하네스 `route.mjs --dump=<폴더>` 가 이미 꺼낸다 (`3_pnr/Results/`):
  `<모듈>_GcellGlobalRoute_*.json` (넷마다 전역 경로와 이은 핀), `<모듈>_DR_*.gds.json` (상세 배선
  뒤), `<최상위>_PG_0.gds.json` (전원 격자 뒤), `<최상위>_PR_0.gds.json` (전원 배선 뒤), 최종
  `<최상위>_0.gds.json`, `Router_Report.txt` (넷·핀마다 길 찾기 성공 여부).
- **RouteWork 탭** (시험해 봄): pybind 로 묶인 `PnR.Router.RouteWork` 를 감싸, 호출마다 앞뒤로
  hierNode 전체와 Drc_info 를 JSON 으로 뜬다. 바인딩이 자료 구조를 거의 다 내보내서(필드 305 개)
  넷마다 `path_metal`·`path_via`, `GcellGlobalRouterPath`, `Vdd`/`Gnd` 격자, `PowerNets`, `SNets`
  (대칭 넷)까지 구조째 나온다. telescopic: 모드 4 입력 260 KB, 5 출력 415 KB, 3 출력 476 KB.
  입력이 같은지(우리가 만든 입력 == ALIGN 의 모드 4 입력)와 단계별 출력이 같은지를 둘 다 이것으로
  잰다. 0 단계에서 하네스에 정식으로 넣는다.
- 걸리는 시간 (wasm, PLAN-route.md 1.3): C++ 배선 알고리즘 telescopic 0.97 s, comparator 4.52 s.
  이식도 같은 알고리즘이라 지금 배선기(1~11 ms)보다 느려진다 — 같은 결과의 값이다.

## 2. 옮길 코드 (조사 중)

`PlaceRouteHierFlow/router` 23.2K 줄(단위 시험 포함), `PnRDB` 5.7K 줄 중 우리 흐름에서 닿는 곳.
모드별 호출 그래프·줄 수·알고리즘을 여기 적는다.

## 3. 같은 결과를 막는 것들 (조사 중)

C++ 을 Rust 로 옮길 때 결과가 갈릴 수 있는 곳을 코드 위치와 함께 적는다:

- `std::sort` 의 동점 순서 — libc++ (emscripten 3.1.58) 의 introsort 를 그대로 옮겨 써야 할 수 있다.
- `unordered_map`/`unordered_set` 순회 순서, 포인터 키 정렬, 초기화 안 된 값, 호출 사이에 남는
  전역 상태 (bottom-up 은 모듈마다 배선기를 다시 부른다).
- 부동소수와 libm 함수.
- **lp_solve** (5.5.2.11, ALIGN 이 고정한 판) — 전역 배선의 ILP. 최적해가 여럿이면 풀이기마다 다른
  답을 낼 수 있다. 같은 C 소스를 배선기 wasm 에 같이 빌드하는 길을 본다 (이 환경의 clang 18 이
  wasm32 로 C 를 빌드한다, libc 는 wasi-libc 패키지).

## 4. 순서와 합격선 (초안)

0. **기준 도구**: RouteWork 탭을 하네스에 (`scripts/route/node/`), 5 예제 x 두 배치(ALIGN 배치,
   우리 배치)의 모드별 앞뒤 덤프를 캐시에. 배치를 조금씩 흔든 사례 생성기.
1. **입력 만들기 (JS)**: 설계 + 리프 도형 + 배치 + PDK -> 모드 4 직전 hierNode 와 Drc_info.
   합격: 탭이 뜬 ALIGN 입력과 필드마다 같다 (모든 예제, 모든 모듈).
2. **전역 배선 (모드 4)**. 합격: 모드 4 뒤 덤프(넷마다 `GcellGlobalRouterPath` 등)가 같다.
3. **상세 배선 (모드 5)**. 합격: 넷마다 `path_metal`·`path_via` 가 같다.
4. **계층 (bottom-up)**: 자식 결과를 부모 블록으로, 좌표 변환, 전원 핀 옮기기.
   합격: 계층 예제 둘에서 모듈마다 2·3 이 같다.
5. **전원 격자 (모드 2)**. 합격: `Vdd`/`Gnd` 가 같다.
6. **전원 배선 (모드 3)**. 합격: `PowerNets` 가 같고, 최종 도형과 DRC/LVS 목록이 ALIGN 과 같다.
7. **갈아끼우기**: `src/route/pipeline.mjs` 가 이식한 배선기를 부른다. 지금 배선기 코드를 걷어낸다.
   페이지에서 확인.
8. **흔든 배치 대조**: 예제마다 배치를 흔든 사례 수백 개에서 ALIGN 과 단계별로 같다. 어긋나면 가장
   작은 재현 사례로 줄여 고친다.
