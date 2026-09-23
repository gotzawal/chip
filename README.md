# Analog Layout Generator — 정적 사이트

아날로그 회로의 넷리스트(`.sp`)를 넣으면 칩 레이아웃(GDS)을 **브라우저에서** 만든다.
회로 읽기 · 배치 · 배선 · DRC/LVS 검사 · GDS 내보내기까지 이 탭 안에서 돌고, 산출물을 바로
받는다. 서버도 빌드도 없다 — 이 폴더를 정적 호스팅에 그대로 올리면 된다.

배치기·배선기의 소스와 검사, 예제를 만드는 도구는 `symplace/` 에 있다 (아래 "소스" 절).
앞으로의 재구성과 예제 추가 계획은 [PLAN.md](PLAN.md).

## GitHub Pages 에 올리기

```bash
# 새 저장소에 이 폴더 내용을 넣고
git init && git add . && git commit -m "analog layout generator"
git branch -M main
git remote add origin git@github.com:<사용자>/<저장소>.git
git push -u origin main
```

저장소 Settings → Pages → Source 를 **Deploy from a branch**, 브랜치 `main`,
폴더 `/ (root)` 로 두면 몇 분 뒤 `https://<사용자>.github.io/<저장소>/` 에서 뜬다.

`.nojekyll` 이 들어 있다 (Jekyll 처리를 건너뛰어 `py/`, `_`로 시작하는 파일도
그대로 서빙된다).

## 로컬에서 보기

`file://` 로는 안 된다 — ES 모듈과 워커가 막힌다. HTTP 로 띄워야 한다.

```bash
python3 -m http.server 8791
# http://127.0.0.1:8791
```

배치는 모듈 워커에서 돈다. 워커를 못 쓰는 브라우저(구형 사파리)에서는 같은 코드를 메인
스레드에서 돌린다 — 그동안 페이지가 멎지만 아무것도 안 나오지는 않는다.

## 저장소에 있는 것과 여기서 만드는 것

- **저장소에 두는 것은 입력뿐이다.** `data/*.json` (앞단 출력: 회로의 소자 묶음과 템플릿),
  `data/*.leaves.json` (리프 셀의 전체 도형 — 배선할 때만 받는다), `netlists/*.sp` (예제의 원본 회로).
- **결과는 전부 이 자리에서 만든다.** 배치도, 배선도, GDS 도, 내려받기 칸의 파일도 그렇다.
  미리 풀어둔 결과를 올려두고 그리거나 내려받게 하지 않는다 — 그러면 화면에 있는 것이
  방금 푼 것인지 박아둔 것인지 알 수 없다.

## 구성

```
index.html        페이지
worker.mjs        배치를 워커에서 돌리는 얇은 껍데기
routeworker.mjs   배선을 워커에서 — src/route/pipeline.mjs + alignroute.wasm (파이썬 없음)
frontworker.mjs   앞단 — .sp 를 올릴 때만. Pyodide 안에서 ALIGN 앞단(py/front.py)을 그대로 돌린다
view.mjs          캔버스 — 확대/이동, 패널, 배선 레이어
src/job.mjs       배치 한 판 (워커에서도, 메인 스레드에서도 같은 코드가 돈다)
src/*.mjs         배치기 본체 (의존성 없는 ES 모듈)
src/gpu/runner.mjs  연속 단계(Adam)를 WebGPU 컴퓨트 셰이더로 — 있으면 쓰고, 없으면 CPU
src/route/        배선 — ALIGN 배선 알고리즘의 이식: 입력·PnRDB(align/), Rust 배선기(alignroute.wasm),
                  도형 합성, DRC/LVS, GDS
src/schematic/    회로도·묶음 보기 — SPICE 읽기(spice.mjs), .sp 와 앞단 출력에서 회로 만들기(circuit.mjs),
                  자동 배열(layout.mjs), 캔버스 그리기(draw.mjs)
data/*.json       예제의 앞단 출력 (미리 만들어둬 첫 화면이 빠르다), data/index.json 이 목록
data/*.leaves.json  예제의 리프 셀 전체 도형 — 배선할 때만 받는다
netlists/*.sp     예제의 원본 회로 (회로도 보기가 읽고, 회로 올리기에 그대로 넣어 볼 수도 있다)
py/               앞단용 Pyodide 스택 (원본 약 39 MB, .sp 를 처음 올릴 때만 받는다)
symplace/         소스·검사·도구 — Rust 배선기(alignroute/), node 검사, 예제 묶기(pack-example.mjs)
```

## 쓰는 법

1. **예제를 고르거나** `.sp` 넷리스트를 올린다.
2. **배치 실행** — 변이·반전·영역·격자를 배치기가 직접 고른다. 끝나면 배치 JSON 을 바로 받을 수 있다.
3. **배선 실행** — 이 탭이 배선한다. ALIGN 의 배선 알고리즘을 그대로 옮긴 것이다: 배선기에
   넘기는 자료와 계층 부기는 JS, 전역·상세·전원 배선은 Rust(wasm), 도형 합성·DRC/LVS·GDS 는
   JS. 결과는 `배선` 보기에 그려지고, 아래 내려받기 칸이 그 자리에서 채워진다.

그림은 흐름 순서대로 넷이다 — `회로도` / `묶음` / `배치` / `배선`. 휠로 확대, 끌어서 이동, 더블클릭으로
초기화. 배선 보기에서는 금속·비아·소자층·웰을 묶음으로 껐다 켤 수 있다.

- **회로도** — 넷리스트(.sp)를 그대로 그린 것. 트랜지스터 하나하나가 기호로 놓이고, 서브서킷 계층은
  펼치되 점선 상자로 남는다. 넷이나 소자에 마우스를 올리면 이름과 연결이 아래 줄에 뜬다.
- **묶음** — 앞단(1_topology + 2_primitives)이 소자를 묶은 결과, 곧 **배치기가 놓는 블록**이다. 차동쌍·전류
  거울 같은 잎 묶음은 색 상자로, GroupBlocks 나 서브서킷으로 만든 모듈은 점선 상자로 감싸고,
  SymmetricBlocks 제약의 거울 쌍은 대칭축 양쪽에 거울로 놓는다. 스택·병렬로 합쳐진 소자는 하나로
  보인다 (`stack 2`, `m=4`). 그림 아래 표가 블록마다 종류·소자·변이 후보(2_primitives 의 크기)·제약을 적는다.

회로도·묶음 모듈(`src/schematic/`)은 페이지가 **따로, 필요할 때** 받는다 — 못 받아도 예제 목록과 배치·배선은
그대로 돈다. 빌드가 없는 정적 사이트라 브라우저가 옛 모듈을 캐시에 쥔 채 새 `index.html` 만 받는 일이 있는데,
그때 페이지가 통째로 비지 않게 하려는 것이다 (`test/stale.mjs` 가 그 상황을 만들어 본다).

두 그림은 같은 배열기가 놓는다 (`src/schematic/layout.mjs`). 넷의 높이를 스프링으로 풀어(전원 위, 접지
아래, 트랜지스터마다 한 단) 세로를 정하고, 직렬로 이어진 소자를 한 열에 세운 뒤 열끼리의 친화도로
피들러 벡터를 구해 가로 순서를 정한다. 거울 쌍이 있으면 축 양쪽에 거울로 두고, 양쪽에 채널로 닿는
열(꼬리 전류원)은 축 위에 둔다. 회로도는 앞단의 묶음을 .sp 소자에 되맞춰 같은 대칭 배열을 쓴다.
앞단 출력만 올린 설계는 원문이 없어 회로도가 없고 묶음만 된다.

배선에는 리프 셀의 전체 도형이 든다. 예제는 `data/<예제>.leaves.json` 을 그때 받고
(6~219 KB), 올린 `.sp` 는 앞단이 같이 낸다. 파이썬은 안 뜬다 — 예제를 고르고 배치·배선하는
데는 Pyodide 를 받지 않는다.

## 회로 올리기

`.sp` (또는 `.cir`) 파일 하나면 된다. 제약을 같이 주려면 `<서브서킷>.const.json` 을 함께
올린다 — 서브서킷마다 하나씩 여러 개여도 된다.

```
.sp 넷리스트
  -> 앞단  1_topology + 2_primitives   Pyodide 에서 0.7 ~ 9 s
  -> 배치  변이·반전·영역·격자          JS 에서 3 ~ 60 s (WebGPU 가 있으면 시작점을 더 준다)
  -> 배선  ALIGN 배선 알고리즘의 이식   JS + Rust wasm (전역·상세·전원 배선, 검사, GDS)  0.1 ~ 1 s
  -> GDS + DRC/LVS
```

앞단 출력을 직접 올려도 된다 (그때는 배치까지만 된다 — 리프 전체 도형이 없어서다.
"예제로 저장" 으로 받은 파일은 리프를 담고 있어 배선까지 된다).

```
1_topology/<top>.verilog.json      인스턴스 -> abstract 템플릿, fa_map, 제약
2_primitives/__primitives__.json   concrete -> abstract, x_cells, y_cells
2_primitives/<concrete>.json       bbox, terminals
```

`{topology, primitives, templates}` 로 묶은 JSON 한 파일도 받는다 (`data/*.json` 이 그 형식이다).

배치기가 다루는 제약은 `SymmetricBlocks`, `Align`, `Order`, `AspectRatio`, `HorizontalDistance` /
`VerticalDistance` / `BlockDistance`, `GroupBlocks`(앞단이 하위 모듈로 만든다) 다. 앞단·배선기 몫인
제약(`PowerPorts`, `SymmetricNets`, `ConfigureCompiler` 등)은 그대로 넘어가고, 어느 쪽도 아닌 것
(`GroupCaps`, `GuardRing`, `Boundary` 등)은 설계 표에 "배치기가 무시한 제약" 으로 보인다.

## 예제 더 넣기

**쓰기만 할 거면 예제로 만들 필요가 없다** — 회로 올리기에 `.sp` 를 던지면
그 자리에서 돈다. 예제는 "미리 올려둔 회로" 일 뿐이고, 목록은 `data/index.json` 에서 읽는다.

```json
[ { "name": "my_ota", "label": "My OTA" }, ... ]
```

1. `.sp` 를 올린다. 앞단이 브라우저에서 한 번 돈다.
2. 올리기 칸 옆의 **예제로 저장** 을 누른다 — `<이름>.json` 이 떨어진다 (리프 도형까지 든다).
3. 그 파일을 `data/` 에 넣고 `data/index.json` 에 한 줄 더한다. 첫 화면을 가볍게 하려면
   `node symplace/web/placer/pack-example.mjs` 로 `data/<이름>.json` 과 `data/<이름>.leaves.json`
   둘로 나눈다 (앞단 출력 폴더를 받는다).

지금 예제 12 개는 ALIGN-public 의 `examples/` 에서 가져온 회로들이다: telescopic_ota,
current_mirror_ota, five_transistor_ota, cascode_current_mirror_ota, high_speed_comparator, buffer,
inverter_v1/v2/v3, common_source, block_spacing_bug, five_transistor_ota_high_frequency.

## 배치 결과 (CPU, 시작점 96, 무게 1, node 단일 스레드)

`node symplace/web/placer/test/place.mjs` 가 찍는 값이다. HPWL 은 **핀 경계 사각형**으로 잰다
(아래 "변이 선택"). 겹침은 전부 정확히 0, 대칭 잔차는 1e-12 이하, 격자 밖 블록 0 이다.

| 예제 | 블록 | 변이 조합 | bbox | 채움 | HPWL | 시간 |
|---|---|---|---|---|---|---|
| telescopic_ota | 5 | 8 | 1440×11760 | 0.87 | 15916 | 4 s |
| current_mirror_ota | 5 | 2 | 8800×2352 | 1.00 | 18156 | 4 s |
| five_transistor_ota | 3 | 60 | 4160×5880 | 0.83 | 8028 | 5 s |
| cascode_current_mirror_ota | 11 (계층 2) | 16 | 6480×11760 | 0.86 | 75396 | 18 s |
| high_speed_comparator | 10 (계층 5) | 108 | 6080×11760 | 0.72 | 28364 | 44 s |

## WebGPU — 연속 단계를 GPU 에서

브라우저에 WebGPU 가 있으면 (Chrome/Edge, Firefox, Safari 26) 연속 단계(Adam 600 스텝)를
컴퓨트 셰이더로 돈다 (`src/gpu/runner.mjs`). 워크그룹 하나가 시작점 하나고, 한 스텝이
여섯 패스(centers, wire, overlap, spectrum, grad, adam)다. CPU 의 `Objective.eval` +
`adam` 과 **같은 계산**이다 — 좌표를 영역 긴 변으로 나눈 무차원 문제를 f32 로 풀고,
calibrate 가 lam·mu 를 기울기 비로 잡으므로 궤적이 같다. `test/gpu.mjs` 가 재는 값:
calibrate 한 번의 W·D·B·lam·mu 가 CPU(f64) 와 상대오차 1e-5~1e-7, 600 스텝 뒤 최선
점수가 소수 넷째 자리까지 같고, 40 스텝씩 끊어 돌린 것이 비트까지 같다.

GPU 일 때 예산의 뜻이 바뀐다. 총 시작점이 아니라 **설정(변이 배정 x 영역)마다
"GPU 시작점/설정"** 개다 (기본 32). CPU 의 시작점 96 은 설정당 1~4 개라 배정 하나의
점수가 표본 서너 개로 정해져 순위가 잡음 안에 있었다. legalize·반전·정확한 면적은
CPU(f64) 에 남는다. 어댑터가 없으면 CPU 로 조용히 떨어지고 화면에 CPU 라고 적는다.

GPU 가 없는 기계에서 헤드리스 Chromium 의 SwiftShader(소프트웨어)로 잰 값이라 절대
시간은 참고만: five_transistor 설정 180 x 8 = 1,440 시작점이 164 s 였다 (같은 조건의
CPU 는 시작점 180 개에 6.5 s). 실제 GPU 에서의 시간은 아직 재지 못했다.

## 예산은 **라운드로** 쓴다

"시작점" 은 총 시작점 수다. 설정(= 변이 배정 x 영역 후보) 수가 하한이고,
남는 예산은 **잘 되는 설정에 더 준다**.

```
1 라운드 (너비)     설정마다 시작점 하나 — 모든 설정을 한 번은 본다
2 라운드 이후 (깊이) 점수 상위 설정에만 하나씩 더. 볼 설정 수를 라운드마다
                    반으로 줄이고, 하나까지 가면 다시 절반에서 시작한다
```

전에는 `설정마다 floor(예산/설정수) 개` 를 똑같이 흩뿌리고 끝이었다.
설정이 예산보다 많으면 그 몫이 1 로 깔려서 (1) 예산 설정이 아무 일도 안 하고
(2) 예산을 늘려도 **깊이가 안 깊어졌다.** 변이 조합은 128 개까지 전수로 보고
(WebGPU 면 512), 그보다 많으면 추첨한다.

## 저울 두 개 — 둘 다 연속으로 돌린다

면적과 배선의 맞바꿈은 **두 단계에 걸쳐** 있고, 둘은 하는 일이 다르다.

| | 무엇을 바꾸나 | 파라미터 | 슬라이더 | 기본 |
|---|---|---|---|---|
| 연속 단계 | **어떤 해가 나오는가** | `lamRatio` | 배선 ↔ 퍼뜨리기, 1/4 ~ 4 | 1 |
| 선택 | **나온 해 중 무엇을 고르나** | `hpwlWeight` | 면적 ↔ 배선, 1/16 ~ 16 | 1 |

둘 다 **로그 눈금**이다. 저울은 비율이라 2 배와 1/2 배가 슬라이더에서 같은
거리여야 한다. 한 칸이 `2^0.1 = 1.072` 배고, 기본값이 눈금에 정확히 떨어진다.

### 선택 저울 — 왜 `hpwlWeight` 인가

점수가 `log(면적) + w x log(HPWL) + 3 x 겹침` 이다 (`solver.mjs` 의 `scoreOf`).
로그라 기준값이 없다 — 면적 10% 와 배선 10% 가 같은 값이고, 로그 눈금 슬라이더의 `w` 가
곧 "면적 1 대 배선 w" 로 읽힌다. 이 저울은 **고를 때의 저울과 legalize 뒤의 저울이 같아야**
한다. 다르면 legalize 할 상위 후보를 고르는 기준이 최종 기준과 어긋나 좋은 후보가 먼저 잘린다.

### 연속 단계 저울 — 왜 `lamRatio` 인가

에너지는 `E = W + lam x D + mu x B` 다. 여기서 **`W` 에 무게를 곱하는 것은
아무 효과가 없다** — `calibrate` 가 `lam` 과 `mu` 를 `|grad W|` 로 정규화하기
때문에 스케일이 그대로 상쇄된다.

```
lam = lamRatio * |grad W| / |grad D|      mu = muRatio * |grad W| / |grad B|
```

즉 이 단계에서 저울을 실제로 움직이는 양은 하나뿐이다 — **밀도 기울기를 배선
기울기의 몇 배로 둘 것인가**, 그게 `lamRatio` 다. 낮추면 넷이 더 세게 당겨
배선이 짧아지고 겹침이 많이 남는다. 높이면 퍼뜨려 겹침이 적게 남는다.
겹침은 legalize 가 어차피 0 으로 만드니, 이건 "얼마나 무른 유체로 둘 것인가" 다.

**눈금은 결과가 아니라 겹침으로 읽어라.** `lamRatio` 에 대한 연속 단계 겹침은
깨끗하게 단조롭다 (five_transistor_ota, 후보 중앙값):

```
lamRatio   0.25    0.5     1       2       4
연속 겹침  0.216   0.189   0.160   0.140   0.111
```

반면 최종 면적/HPWL 은 **단조롭지 않다.** 저울이 탐색을 옮기면 이기는 **이산 변이**가
바뀌고, 그 차이가 저울 차이보다 크기 때문이다. 그래서 화면에도 연속 단계
겹침 중앙값을 같이 띄운다 — 슬라이더가 실제로 무엇을 했는지 보는 눈금이다.

## 변이 선택 — 핀은 점이 아니라 사각형이다

`2_primitives` 는 같은 소자를 여러 종횡비로 만들어 둔다 (`X1_Y2` 는 800x3528,
`X2_Y1` 은 1120x2352 — 트랜지스터도 파라미터도 같고 **모양만** 다르다).
어느 쪽을 쓰느냐는 연속 최적화로 못 정하는 **이산 선택**이고 배치를 크게 바꾼다.
다중 시작의 한 축으로 넣어 고른다. 여기서 중요한 것 셋.

1. **배선을 재는 자.** 넷마다 핀 사각형 합집합의 **중심 한 점**으로 HPWL 을 재면 손가락 16 개를
   한 줄로 늘어놓은 `X16_Y1` (핀이 폭 5,032 짜리 가로 막대) 이 블록 가운데 점 하나로 보여
   길쭉한 변이일수록 배선이 공짜로 보인다. 그래서 핀 **경계 사각형**의 min/max 로 잰다
   (`templateInfo` 가 넷별 핀 반폭을 남기고, `hpwl` 과 연속 단계의 `wirelength` 가 `x ± ex` 로 잰다).
   후보 점수는 거울 반전 뒤의 배선길이로 매긴다 — 반전 전 값으로 줄을 세우면 그 이득이 후보마다
   다르게 붙어 순위가 흔들린다.
2. **표본.** 설정마다 시작점이 1~4 개면 배정 하나의 점수가 표본 서너 개로 정해진다.
   WebGPU 가 있으면 설정당 수십 개를 준다. legalize 뒤에는 상위 후보 몇 개의 분리 방향을 뒤집어
   다시 풀어 본다 (`legalize.mjs` 의 `refineDirections`).
3. **계층.** 하위 모듈은 종횡비를 퍼뜨려 3 개(`SUB_VARIANTS`)를 상위의 변이로 올린다. 하위 모듈의
   점수에는 종횡비가 없고, 상위가 어떻게 쓸지는 그 자리에서 판단할 수 없기 때문이다.

legalize 가 INFEASIBLE 이면 그 후보는 버려진다. 계층 설계에서는 그게 대부분이었으므로 실패하면
**여유 영역을 넓혀 다시 푼다** (1.6 → 3 → 6). 영역 제약은 넓히면 실행가능 집합이 커지기만 하고,
목적함수에 반둘레가 들어 있어 넓혀줘도 알아서 좁게 푼다.

자세한 설계 노트(변이·반전·영역·계층·legalize)는 [symplace/web/placer/README.md](symplace/web/placer/README.md).

## 브라우저 배선 — ALIGN 배선 알고리즘의 이식

배선기는 새로 짠 것이 아니라 **ALIGN 의 배선 단계를 그대로 옮긴 것**이다
([symplace/PLAN-route-align.md](symplace/PLAN-route-align.md) 에 옮긴 과정과 대조 방법이 있다).

| 단계 | 어디 |
|---|---|
| 입력 만들기, PnRDB, 배치 심기, 계층 부기 | `src/route/align/` (JS) |
| 전역 배선 (RouteWork 4) | `symplace/alignroute/src/gr` (Rust + lp_solve C 소스) |
| 상세 배선 (RouteWork 5) | `symplace/alignroute/src/dr` (Rust) |
| 전원 격자·전원 배선 (RouteWork 2·3) | `symplace/alignroute/src/pr` (Rust) |
| 도형 합성·DRC/LVS·GDS | `src/route/pipeline.mjs`, `compose.mjs`, `check.mjs`, `gds.mjs` |

브라우저에서 telescopic_ota 0.22 s, high_speed_comparator 0.57 s 다. 검사기·도형 합성·GDS 쓰기는
고정 사례로 지킨다: 검사기 106 사례 (`test/check.mjs`), 격자 오류 문구 150 개 (`test/compose.mjs`),
GDS 바이트 2 사례 (`test/gds.mjs`).

**lp_solve 는 C 소스 그대로 링크한다.** 전역 배선의 ILP 는 최적해가 심하게 겹치고 lp_solve 는 대개
처음 찾은 정수해를 낸다 — 다른 풀이기로는 같은 배선이 안 나온다. clang `wasm32-wasi` 로 빌드해
Rust 에 정적으로 링크한다.

## 소스

`symplace/` 에 소스와 검사, 도구가 있다 — 자세한 것은 [symplace/README.md](symplace/README.md).

```
symplace/alignroute/        Rust 배선기 — build.sh 가 src/route/alignroute.wasm 을 만든다 (lp_solve C 소스를 같이 빌드)
symplace/web/placer/test/   node 검사 — 심플렉스, 에너지 대조, 배치, legalize, 검사기·격자·GDS 고정 사례, 브라우저(WebGPU·페이지)
symplace/web/placer/fixtures/  고정값 — 배치 문제의 정답 4 예제, 검사기 사례 106, 격자 문구 150, GDS 2
symplace/web/placer/pack-example.mjs  앞단 출력 폴더 -> data/ 의 예제 파일
symplace/web/placer/README.md  배치기 설계 노트 (변이·반전·영역·계층을 어떻게 고르는지, legalize)
symplace/scripts/           z3 빌드, route/node/ (페이지와 같은 배치·배선을 node 에서), place/ (분석)
symplace/PLAN-route-align.md          배선기를 ALIGN 알고리즘 그대로 옮긴 계획과 대조 기록
symplace/PLAN-place-variants-gpu.md   변이 선택 분석과 WebGPU 계획·결과
```

배치기 본체(`src/*.mjs`)는 **이 저장소 루트의 것 하나뿐이다.** 사이트가 그대로
읽고, 검사도 그것을 읽는다 (`symplace/web/placer/test/*` 가 `../../../../src/`
를 임포트한다). 검사가 읽는 예제도 사이트가 읽는 `data/<예제>.json` 그대로다. 사본을 두지 않는다.

```bash
node symplace/web/placer/test/place.mjs      # 앞단 출력만으로 배치 (본 경로) — 겹침·대칭·Order·격자 검사
node symplace/web/placer/test/lp.mjs         # 심플렉스 검증
node symplace/web/placer/test/parity.mjs     # 에너지·기울기·영공간을 고정값과 대조
node symplace/web/placer/test/design.mjs     # 앞단 출력에서 만든 문제 == 고정값의 문제
node symplace/web/placer/test/legalize.mjs   # 겹침 0 / 대칭 잔차 / 면적
node symplace/web/placer/test/chunk.mjs      # 끊어 돌린 Adam == 한 번에 돌린 Adam
node symplace/web/placer/test/variants.mjs   # 변이 배정 전수 — 배정이 결과를 가르는가
node symplace/web/placer/test/gpu.mjs        # GPU runner == CPU (headless Chromium, WebGPU)
node symplace/web/placer/test/page.mjs high_speed_comparator gpu 96 32   # 페이지 통째로 (워커 + WebGPU)
node symplace/web/placer/test/leaves.mjs     # 리프 도형 파일이 예제와 맞는가
node symplace/web/placer/test/check.mjs      # JS DRC/LVS 검사기 == 고정 사례
node symplace/web/placer/test/compose.mjs    # 배선 도형의 격자 검사 == 고정 사례
node symplace/web/placer/test/gds.mjs        # GDS == 고정 사례 (바이트)
node symplace/web/placer/test/schematic.mjs  # 회로도·묶음 배열 — 예제 전부에서 겹침 0, 선이 핀에 닿는가, 거울 쌍 대칭
node symplace/web/placer/test/views.mjs      # 페이지의 회로도·묶음 보기 (headless Chromium) — 예제 전부 + 올리기
node symplace/web/placer/test/stale.mjs      # 옛 모듈이 브라우저 캐시에 남은 채 새 판을 새로고침해도 예제 목록이 뜨는가
node symplace/scripts/route/node/newroute.mjs all   # 예제 전부를 배치하고 페이지와 같은 길로 배선 (DRC/LVS 를 찍는다)
```

## 의존성

**페이지를 여는 데 드는 것: 없다.** ES 모듈과 wasm 하나(`src/route/alignroute.wasm`, 1.3 MB)뿐이고,
글꼴도 시스템 것을 쓴다 — 외부 주소를 하나도 안 부른다. 예제를 고르고 배치·배선·GDS 까지 오프라인으로 된다.

| 무엇을 할 때 | 드는 것 |
|---|---|
| `.sp` 를 올릴 때 (앞단) | Pyodide 0.27.8 을 jsDelivr CDN 에서, networkx·pydantic 1.10.13·python-gdsii 를 PyPI 에서 (합쳐 약 16 MB), 저장소의 libz3 (22 MB, `py/z3`) 와 ALIGN 앞단 소스 (0.2 MB, `py/front`). 첫 방문에만 받고 브라우저가 캐시한다 |
| node 검사 | node 22. 브라우저 검사(`gpu.mjs`, `page.mjs`)만 Playwright 전역 설치 |
| 배선기 빌드 | Rust (wasm32-wasip1), clang + wasi-libc, lp_solve 5.5.2.11 C 소스 (`fetch-lpsolve.sh` 가 받는다). crate 는 serde·serde_json 뿐 |

앞단의 Pyodide 스택이 남은 가장 큰 의존성이다 — ALIGN 앞단(회로 읽기·소자 묶기·템플릿 생성)을 JS 로
옮기면 없어진다. 그 계획은 [PLAN.md](PLAN.md).
