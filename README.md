# Analog Layout Generator — 정적 사이트

아날로그 회로의 넷리스트(`.sp`)를 넣으면 칩 레이아웃(GDS)을 **브라우저에서** 만든다.
회로 읽기 · 배치 · 배선 · DRC/LVS 검사 · GDS 내보내기까지 이 탭 안에서 돌고, 산출물을 바로
받는다. 서버도 빌드도 없다 — 이 폴더를 정적 호스팅에 그대로 올리면 된다.

배치기·배선기의 소스와 검사, 예제·기준선을 만드는 도구는 `symplace/` 에 있다
(아래 "소스" 절). 앞으로의 재구성과 예제 추가 계획은 [PLAN.md](PLAN.md).

## GitHub Pages 에 올리기

```bash
# 새 저장소에 이 폴더 내용을 넣고
git init && git add . && git commit -m "symmetry placer"
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

첫 화면(ALIGN 기준선·지표)은 **워커 없이** 뜬다. 모듈 워커를 못 쓰는
브라우저(구형 사파리)에서 그림이 통째로 비던 것을 이렇게 고쳤다. 배치 실행도
워커가 안 서면 같은 코드를 메인 스레드에서 돌린다 — 그동안 페이지가 멎지만
아무것도 안 나오지는 않는다.

```bash
python3 -m http.server 8791
# http://127.0.0.1:8791
```

## 저장소에 있는 것과 여기서 만드는 것

이 구분이 중요하다.

- **저장소에 두는 것은 입력과 비교 기준뿐이다.** `data/*.json` (ALIGN 앞단 출력),
  `netlists/*.sp` (예제의 원본 회로), `routed/*.align.json` (네이티브 ALIGN 이 낸
  배선 기하와 DRC). ALIGN 의 배치·배선은 **왼쪽 패널에 그릴 기준선**으로만 쓴다.
- **우리 쪽 결과는 전부 이 자리에서 만든다.** 배치도, 배선도, GDS 도,
  내려받기 칸의 파일도 그렇다. 미리 풀어둔 결과를 올려두고 그리거나
  내려받게 하지 않는다 — 그러면 화면에 있는 것이 방금 푼 것인지 박아둔
  것인지 알 수 없다.

배선이 이 브라우저에서 안 끝나면 **내려받을 배선 산출물도 없다.** 대신
배치 결과(`<이름>.place.json`)는 배치 실행이 끝나는 즉시 받을 수 있다.

## 구성

```
index.html        페이지
worker.mjs        배치를 워커에서 돌리는 얇은 껍데기
routeworker.mjs   배선을 워커에서 — src/route/pipeline.mjs + alignroute.wasm (파이썬 없음)
frontworker.mjs   앞단 — .sp 를 올릴 때만. Pyodide 안에서 ALIGN 앞단(py/front.py)을 그대로 돌린다
view.mjs          캔버스 — 확대/이동, 패널, 배선 레이어
src/job.mjs       배치 한 판 (워커에서도, 메인 스레드에서도 같은 코드가 돈다)
src/baseline.mjs  ALIGN 기준선 뽑기 — 첫 화면이 워커 없이 뜨는 이유
src/*.mjs         배치기 본체 (의존성 없는 ES 모듈)
src/gpu/runner.mjs  연속 단계(Adam)를 WebGPU 컴퓨트 셰이더로 — 있으면 쓰고, 없으면 CPU
src/route/        배선 — ALIGN 배선 단계의 이식: 입력·PnRDB(align/), Rust 배선기(alignroute.wasm),
                  도형 합성, DRC/LVS, GDS
data/*.json       예제 5 개의 ALIGN 앞단 출력 (미리 만들어둬 첫 화면이 빠르다)
data/*.leaves.json  예제의 리프 셀 전체 도형 — 배선할 때만 받는다
netlists/*.sp     예제 5 개의 원본 회로 (회로 올리기에 그대로 넣어 볼 수 있다)
routed/*.align.json  네이티브 ALIGN 이 낸 배선 기하 (비교용 기준선)
py/               앞단용 Pyodide 스택 (원본 약 39 MB, .sp 를 처음 올릴 때만 받는다)
symplace/         소스·검사·도구 — Rust 배선기(alignroute/), node 검사, 예제 묶기(pack-example.mjs),
                  네이티브 ALIGN 으로 기준선 만들기(scripts/align-baseline.sh), ALIGN 메모리 패치
```

## 쓰는 법

1. **예제를 고르거나** `.sp` 넷리스트를 올린다.
2. **배치 실행** — 변이·반전·영역·격자를 JS 배치기가 직접 고른다.
   끝나면 배치 JSON 을 바로 받을 수 있다.
3. **배선 실행** — 이 탭이 배선한다. ALIGN 의 배선 단계를 그대로 옮긴 것이다: 배선기에
   넘기는 자료와 계층 부기는 JS, C++ 배선기(전역·상세·전원)는 Rust(wasm), 도형 합성·DRC/LVS·GDS 는
   ALIGN 의 파이썬을 옮긴 JS. 결과는 `배선` 보기에 그려지고, 아래 내려받기 칸이 그 자리에서 채워진다.
   (옮긴 과정과 대조 결과 — [symplace/PLAN-route-align.md](symplace/PLAN-route-align.md).)

그림은 두 갈래로 고른다 — **무엇을**(배치 / 배선) 과 **누구를**(나란히 / 우리 /
ALIGN). 기본은 `배치 · 나란히` 다. 왼쪽이 ALIGN, 오른쪽이 우리고, 두 패널은
**같은 배율**을 쓴다 (둘을 다 담는 상자에 맞춘다) — 안 그러면 크기 비교가 안 된다.
휠로 확대, 끌어서 이동, 더블클릭으로 초기화.

배선이 끝나면 `배선 · 나란히` 로 넘어간다. **ALIGN 배선은 그대로 남는다** —
비교가 필요한 바로 그 순간에 기준선이 사라지면 안 된다.

우리 배치가 ALIGN 의 **상하 거울상**으로 나오는 경우가 있다 (대칭 자유도라 틀린 게
아니다). 그때는 나란히 놓고 견주기 좋도록 **보기만** 뒤집어 그리고 이름표에 `↕` 를
붙인다. 좌표와 산출물은 안 건드린다.

배선에는 리프 셀의 전체 도형이 든다. 예제는 `data/<예제>.leaves.json` 을 그때 받고
(41~219 KB), 올린 `.sp` 는 앞단이 같이 낸다. 파이썬은 안 뜬다 — 예제를 고르고 배치·배선하는
데는 Pyodide 를 받지 않는다.

## 회로 올리기

`.sp` (또는 `.cir`) 파일 하나면 된다. 제약을 같이 주려면
`<이름>.const.json` 을 함께 올린다.

```
.sp 넷리스트
  -> 앞단  1_topology + 2_primitives   Pyodide 에서 0.7 ~ 9 s
  -> 배치  변이·반전·영역·격자          JS 에서 9 ~ 180 s
  -> 배선  ALIGN 배선 단계의 이식      JS + Rust wasm (전역·상세·전원 배선, 검사, GDS)
  -> GDS + DRC/LVS
```

ALIGN 앞단 출력을 직접 올려도 된다 (그때는 배치까지만 된다 — 리프 전체 도형이 없어서다.
"예제로 저장" 으로 받은 파일은 리프를 담고 있어 배선까지 된다).

```
1_topology/<top>.verilog.json      인스턴스 -> abstract 템플릿, fa_map, 제약
2_primitives/__primitives__.json   concrete -> abstract, x_cells, y_cells
2_primitives/<concrete>.json       bbox, terminals
```

`{topology, primitives, templates}` 로 묶은 JSON 한 파일도 받는다
(`data/*.json` 이 그 형식이다).

## 예제 더 넣기

**쓰기만 할 거면 예제로 만들 필요가 없다** — 회로 올리기에 `.sp` 를 던지면
그 자리에서 돈다. 예제는 "미리 올려둔 회로" 일 뿐이고, 목록은
`data/index.json` 에서 읽는다.

```json
[ { "name": "my_ota", "label": "My OTA" }, ... ]
```

### 1. 브라우저만으로 (네이티브 ALIGN 없이)

1. `.sp` 를 올린다. 앞단이 브라우저에서 한 번 돈다.
2. 올리기 칸 옆의 **예제로 저장** 을 누른다 — `<이름>.json` 이 떨어진다.
3. 그 파일을 `data/` 에 넣고 `data/index.json` 에 한 줄 더한다.

ALIGN 기준선(`place`)은 안 들어간다 — 브라우저 앞단은 배치를 안 하기 때문이다.
그 예제는 **왼쪽 패널이 빈 채로** 돌고, 오른쪽에 우리 배치만 나온다.
면적/HPWL 의 "ALIGN 대비" 칸도 비고, 나머지(겹침·대칭 잔차·격자)는 그대로 나온다.

저장한 파일에는 리프 셀의 전체 도형(`leaves`)도 들어 있다 — 배선기는 이것만 있으면
앞단을 다시 돌리지 않고 배선한다.

### 2. 네이티브 ALIGN 이 있으면 (ALIGN 의 배치·배선 기준선까지)

```bash
./symplace/setup.sh                              # 처음 한 번 — ALIGN 설치 (symplace/README.md)
source symplace/env.sh
./symplace/scripts/align-baseline.sh my_ota --label "My OTA"
```

`align-baseline.sh` 는 ALIGN 을 앞단 → 배치 → 배선까지 돌린 뒤 `pack-example.mjs` 로 묶는다.

```
data/<이름>.json           앞단 출력 + ALIGN 배치 (왼쪽 패널의 기준선). terminals 는 netType == "pin" 만 (84K -> 13K)
data/<이름>.leaves.json    리프 셀의 전체 도형 (src/route/leaves.mjs 형식, 41~219K) — 배선할 때만 받는다
data/index.json            목록 한 줄
routed/<이름>.align.json   ALIGN 배선 기하 {bbox, terminals} — 3_pnr/<TOP>_0.json 의 그 두 필드
routed/index.json          {name, align: {geo, rects, gdsName, gdsBytes, errors: [{file, text}]}} — errors 는 3_pnr/*.errors 의 줄
netlists/<이름>.sp         원본 회로 (+ .const.json) — 회로 올리기에 그대로 넣어 볼 수 있다
```

`pack-example.mjs` 는 ALIGN 작업 디렉터리 없이 앞단 출력만 펼쳐 둔 폴더도 받는다
(`--leaves-only` 면 리프 도형만 쓴다). 지금 저장소의 예제 다섯 개는 ALIGN 출력 모양으로 되돌린
폴더 위에서 이 도구를 다시 돌리면 **내용이 같다.** `routed/*.align.json` 이 없으면 배선 보기의
왼쪽만 빈다 — 배선 자체에는 안 쓰인다.

## 배치 품질 (ALIGN 대비, CPU, 시작점 96, 무게 1, node 단일 스레드)

HPWL 은 양쪽 다 **핀 경계 사각형**으로 잰다 (ALIGN 배치기의 `HPWL_extend` 와 같은 자,
아래 "변이 선택" 절). `node symplace/web/placer/test/place.mjs` 가 찍는 값이다 (2026-09-23).

| 예제 | 면적 | HPWL | 시간 | 변이 |
|---|---|---|---|---|
| telescopic_ota | **1.000×** | **1.000×** | 4 s | ALIGN 과 같다 (5/5) — bbox 까지 같다 |
| current_mirror_ota | **1.000×** | **1.000×** | 4 s | 같다 (5/5) — bbox 까지 같다 |
| five_transistor_ota | **1.000×** | 1.021× | 5 s | 같다 (3/3) — bbox 까지 같다 |
| cascode_current_mirror_ota | **1.000×** | 1.107× | 18 s | 10/11, bbox 같다 |
| high_speed_comparator | 1.111× | 1.044× | 44 s | 4/10 — 계층, 아래 "남은 것" (배정 108 전수, 시작점 324) |

겹침은 다섯 다 정확히 0, 대칭 잔차는 1e-12 이하, 격자 밖 블록 0 이다.

five_transistor 가 1.077× / 0.803× 이던 자리다 — 그 0.803 은 핀을 점으로 잰
착시였다 (같은 배치를 핀 경계로 재면 2.1 배). **씨앗에 따라 흔들린다** — 평면
설계 넷은 이제 씨앗을 바꿔도 같은 변이가 나오지만, hsc 는 아직 아니다.
WebGPU 가 있으면 시작점을 설정마다 수십 개 줄 수 있어 그 흔들림이 준다
(아래 "WebGPU" 절).

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
점수가 표본 서너 개로 정해졌고, 그게 telescopic 이 씨앗에 따라 다른 변이를 고르던
이유였다 (`symplace/PLAN-place-variants-gpu.md` 2.2 절). legalize·반전·정확한 면적은
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
(high_speed_comparator 는 설정이 192 개라 48 을 고르든 288 을 고르든 똑같이
192 번을 돌았다) (2) 예산을 늘려도 **깊이가 안 깊어졌다.**

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
ALIGN 배치기의 비용 `log(area) + LAMBDA x log(HPWL_extend)` 와 같은 꼴이고,
`w = 1` 이 ALIGN 의 `LAMBDA = 1` 이다. 로그라 기준값이 없다 — 면적 10% 와 배선 10%
가 같은 값이고, 로그 눈금 슬라이더의 `w` 가 곧 "면적 1 대 배선 w" 로 읽힌다.
(예전의 `면적/refArea + w x HPWL/refHpwl` 은 refHpwl 을 어떻게 잡느냐에 따라 저울이
움직여서 기본을 2 로 보정해 두고 있었다. 그 보정이 필요 없어졌다.)

이 저울은 **고를 때의 저울과 legalize 뒤의 저울이 같아야** 한다. 다르면
legalize 할 상위 후보를 고르는 기준이 최종 기준과 어긋나 좋은 후보가 먼저
잘린다. 그래서 한 값이 두 곳에 같이 들어간다.

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
(`muRatio` 는 영역 밖으로 나가지 말라는 항이라 품질 저울이 아니다. 안 뺐다.)

**눈금은 결과가 아니라 겹침으로 읽어라.** `lamRatio` 에 대한 연속 단계 겹침은
깨끗하게 단조롭다 (five_transistor_ota, 후보 중앙값):

```
lamRatio   0.25    0.5     1       2       4
연속 겹침  0.216   0.189   0.160   0.140   0.111
```

반면 최종 면적/HPWL 은 **단조롭지 않다** — 같은 조건에서 0.923/1.160 과
1.077/0.765 사이를 오간다. 저울이 탐색을 옮기면 이기는 **이산 변이**가
바뀌고, 그 차이가 저울 차이보다 크기 때문이다. 그래서 화면에도 연속 단계
겹침 중앙값을 같이 띄운다 — 슬라이더가 실제로 무엇을 했는지 보는 눈금이다.

## 변이 선택이 ALIGN 과 갈리는 이유

`2_primitives` 는 같은 소자를 여러 종횡비로 만들어 둔다 (`X1_Y2` 는 800x3528,
`X2_Y1` 은 1120x2352 — 트랜지스터도 파라미터도 같고 **모양만** 다르다).
어느 쪽을 쓰느냐는 연속 최적화로 못 정하는 **이산 선택**이고 배치를 크게 바꾼다.
ALIGN 은 수열쌍 담금질 **안에서** 좌표와 같이 골랐고, 우리는 다중 시작의
한 축으로 넣어 고른다. 갈리는 지점은 셋이다.

1. **배선을 재는 자가 달랐다 — 핀은 점이 아니라 사각형이다.** 우리는 넷마다 핀
   사각형 합집합의 **중심 한 점**으로 HPWL 을 쟀다. ALIGN 의 비용은 `HPWL_extend`,
   핀 **경계 사각형**의 min/max 다. 손가락 16 개를 한 줄로 늘어놓은 `X16_Y1`
   (5600x2352) 은 핀이 폭 5,032 짜리 가로 막대인데 우리 눈에는 블록 가운데 점
   하나였다. 그래서 길쭉한 변이일수록 배선이 공짜로 보였다.

   five_transistor_ota 실측 (같은 두 배치를 두 자로):

   | 배치 | 변이 | bbox | 핀 중심 HPWL | 핀 경계 HPWL (ALIGN) |
   |---|---|---|---|---|
   | ALIGN | X4_Y1 X8_Y2 X4_Y2 | 4160x5880 | 4,260 | 7,860 |
   | 예전 우리 | X4_Y1 **X16_Y1 X8_Y1** | 5600x4704 | **3,420** | **16,732** |

   핀 중심으로는 우리가 이기고 (그래서 0.803× 로 보고했다), 핀 경계로는 2.1 배 진다.
   우리가 만든 후보 60 개를 ALIGN 저울로 다시 세우면 ALIGN 의 배정이 1 위였다.
   고친 것: `templateInfo` 가 넷별 핀 반폭을 남기고, `hpwl` 과 연속 단계의
   `wirelength` 가 `x ± ex` 로 잰다. 점수는 위의 로그 꼴로 바꿨다. 이제 평면
   설계 넷은 전부 ALIGN 과 같은 변이를 고른다 (five_transistor 는 bbox 까지 같다).
   분석 전문은 `symplace/PLAN-place-variants-gpu.md`.

   **후보 점수를 거울 반전 뒤의 배선길이로 매긴다.** 반전은 좌표를 안 건드리고
   핀 위치만 바꾼다. 반전 전 값으로 줄을 세우면 그 차이가 후보마다 다르게 붙어
   순위가 흔들린다. (핀을 점으로 재던 때는 반전 이득이 0.38 배까지 났는데, 그것도
   착시였다 — 경계로 재면 0.7~0.9 배다.)

   **표본이 적으면 순위가 잡음 안에 있다.** 설정마다 시작점이 1~4 개면 배정 하나의
   점수가 표본 서너 개로 정해진다. telescopic 은 우리 저울로도 ALIGN 배정이 전수
   비교에서 1 위인데 실행이 2 위를 고른 적이 있다 — 그 배정의 표본이 한 줄 배치를
   못 찾았기 때문이다. WebGPU 가 있으면 설정당 수십 개를 준다 (위 "WebGPU" 절).
   legalize 뒤에는 상위 후보 몇 개의 분리 방향을 뒤집어 다시 풀어 본다
   (`legalize.mjs` 의 `refineDirections`) — 연속해가 나란히 놓은 쌍을 LP 가 못
   뒤집는 것을 값싸게 보완한다.

2. **조합이 많으면 추첨이다.** 상한을 예산에 묶어둔다. high_speed_comparator 는
   조합이 108 개인데 예전에는 상한이 64 로 고정이라 **ALIGN 이 고른 조합이
   추첨에 아예 안 들어올 수** 있었다. 이제 시작점 96 이면 96 개, 288 이면
   전수를 본다.

3. **계층에서는 하위 모듈이 올린 모양 안에서만 고른다.** 하위 모듈은 종횡비를
   퍼뜨려 3 개(`SUB_VARIANTS`)를 상위의 변이로 올린다. high_speed_comparator 의
   `PRIMITIVE_38447703` 은 후보가 9 개인데 그중 3 개만 올라가므로, ALIGN 이 쓰는
   3520x3528 이 **상위에서 평가되지 못하는** 일이 생긴다. 5 개로 올려 재보면
   상위가 ALIGN 과 같은 모양을 고른다 (면적 1.111x / HPWL 1.043x — 배선을 얻고
   면적을 내주는 쪽이라 기본값은 3 으로 두었다).

표의 "ALIGN" 칸은 **이름이 아니라 모양**으로 견준다. 계층 설계의 하위 모듈은
양쪽이 이름 짓는 법이 달라서 (ALIGN `_PG0_k`, 우리 `__vk`) 이름으로 보면
같은 것을 골라도 전부 "다름" 으로 보인다.

### legalize 실패는 후보를 통째로 날린다

legalize 가 INFEASIBLE 이면 그 후보는 버려진다. 계층 설계에서는 그게 대부분이었다
(hsc 120/144, cascode 28/34). 즉 "변이를 고른다" 가 사실상 살아남은 스무 개
안에서만 일어났다. 지금은 실패하면 **여유 영역을 넓혀 다시 푼다** (1.6 → 3 → 6).
영역 제약은 넓히면 실행가능 집합이 커지기만 하고, 목적함수에 반둘레가 들어 있어
넓혀줘도 알아서 좁게 푼다.

```
                            고치기 전            고친 뒤
cascode_current_mirror_ota  실패 28/34   1.111x   실패 0/34    1.025x
high_speed_comparator       실패 120/144 1.053x   실패 59/144  0.965x
```

### 남은 것 — 계층 설계의 결과는 아직 흔들린다

high_speed_comparator 를 같은 코드로 조건만 바꿔 재보면 이렇다.

```
시작점  96 (배정 96/108 추첨, 설정 288)    면적 0.965x  HPWL 1.084x   177 s
시작점 288 (배정 108 전수, 설정 324)       면적 1.053x  HPWL 1.267x   414 s
후보를 전부 legalize (설정 288, 288 시도)   면적 1.140x  HPWL 1.380x   200 s
하위 모듈을 5 개 모양으로 올림              면적 1.111x  HPWL 1.043x   218 s
```

**예산을 늘린다고 단조롭게 좋아지지 않는다.** 후보를 더 보면 후보 집합 자체가
달라지고 (하위 모듈이 올리는 모양이 바뀌고, legalize 를 통과하는 조합이 바뀐다),
그 차이가 예산의 효과보다 크다. 지금 수치의 ±10% 는 거기서 온다.
고칠 자리는 예산이 아니라 **연속단계 점수가 legalize 뒤 품질을 잘 예측하지
못한다**는 쪽이다 — 상위 후보를 고르는 기준이 실제로 남는 것과 어긋난다.

(위 수치는 핀을 점으로 재던 때의 것이다. 핀 경계로 재는 지금 저울로는 CPU 시작점
96 에서 1.222x / 1.132x, bbox 6080x12936 — ALIGN 보다 한 줄(2352) 높다. 하위
모듈 넷의 변이가 ALIGN 과 다르게 올라간 결과고, 평면 설계 넷이 전부 맞은 뒤에
남은 유일한 자리다. 두 가지가 더 있었다. (1) 시작점 96 이면 배정 108 개 중 96 개만
추첨해서 288 과 답이 달랐다 — 이제 128 개까지는 전수라 96 과 288 이 같은 배정을
본다 (1.111x / 1.044x, 6080x11760). (2) 마지막 단계가 1 분 걸렸다 — 배선 격자를 후보
144 개 전부에 걸어서였다. 격자는 내보낼 것(최선 + 모양별 최선)에만 걸어 3 초다.
WebGPU 로 설정당 시작점 8 개(2,304 개)를 주면 1.111x / 1.109x. 실제 GPU 에서 32 개로
재는 것이 다음이다.)

## 브라우저 배선 — ALIGN 배선 단계의 이식

배선은 **ALIGN 의 배선 단계를 그대로 옮긴 것**이다. 같은 배치를 넣으면 ALIGN 과 같은 배선이 나와야 한다 —
배선기를 새로 짜지 않고 ALIGN 의 알고리즘을 버릇까지 옮겼다 ([symplace/PLAN-route-align.md](symplace/PLAN-route-align.md)).

| 단계 | 어디 | 옮길 때 ALIGN 과 대조한 결과 |
|---|---|---|
| 입력 만들기, PnRDB, 배치 심기, 계층 부기 | `src/route/align/` (JS) | 배선기 입력이 필드마다 같다 (10 판 20 모듈) |
| 전역 배선 (RouteWork 4) | `symplace/alignroute/src/gr` (Rust + lp_solve C 소스) | 기록이 같다 — 20 모듈 + 제약 변형 30 회, ALIGN C++ 을 네이티브로 빌드한 것과 무작위 7,000 회 |
| 상세 배선 (RouteWork 5) | `symplace/alignroute/src/dr` (Rust) | 기록이 같다 — 20 모듈 + 흔든 배치 87 회 + 제약 변형 14 회, ALIGN C++ 네이티브 빌드와 무작위 6,600 회 |
| 전원 격자·전원 배선 (RouteWork 2·3) | `symplace/alignroute/src/pr` (Rust) | 기록이 같다 — 10 판과 일부러 막은 16 판 |
| 도형 합성·DRC/LVS·GDS | `src/route/pipeline.mjs`, `compose.mjs`, `check.mjs`, `gds.mjs` | ALIGN 배선기의 기록을 넣으면 모듈마다 도형(차례까지)·GDS·오류 문구가 같다 (10 판 + 흔든 배치 20 판) |

**한 판 전체도 같았다.** 페이지와 같은 길(`src/route/pipeline.mjs` + `alignroute.wasm`)로 5 예제 x 두 배치, 흔든 배치
36 판, 제약을 바꾼 14 판을 돌려 ALIGN 과 견주면 모듈마다 최종 도형(차례까지)·GDS·DRC/LVS 문구·배선기 단계 기록이
모두 같았다. 브라우저에서 telescopic_ota 0.22 s, high_speed_comparator 0.57 s 다 (ALIGN 원본을 Pyodide 로 돌리면
4.1 s / 14.0 s 였다).

**심판을 먼저 맞췄다.** ALIGN 의 검사기·도형 합성·GDS 쓰기를 JS 로 옮기고 파이썬과 글자·바이트 단위로
대조했다. 저장소에는 그때 뽑은 고정 사례가 남아 있다: 검사기는 일부러 망가뜨린 106 사례 (`test/check.mjs`),
격자 오류 문구 150 개 (`test/compose.mjs`), GDS 바이트 2 사례 (`test/gds.mjs`).

**lp_solve 는 C 소스 그대로 링크한다.** 전역 배선의 ILP 는 최적해가 심하게 겹치고 lp_solve 는 대개 처음 찾은
정수해를 낸다 — 다른 풀이기로는 같은 배선이 안 나온다. clang `wasm32-wasi` 로 빌드한 lp_solve 가 ALIGN 의
것과 합성 ILP 410 개에서 비트까지 같았다.

**ALIGN 원본은 이제 안 쓴다.** 이식이 끝나 대조에 쓰던 것 — 페이지의 "배선 · ALIGN 원본" 버튼과 대조 카드,
Pyodide 에 ALIGN C++ 배선기(PnR 휠)를 올리던 워커, 같은 일을 node 에서 하던 하네스, 기준 덤프를 뜨고 견주던
도구와 시험, PnR 휠 빌드, 네이티브 ALIGN 으로 배선하던 스크립트 — 를 걷어냈다 (마지막으로 들어 있던 커밋
`6655430`). 그보다 전의 새로 짠 격자 배선기(`symplace/router`)는 ALIGN 과 결과가 달라 먼저 걷어냈고, 그 두
경로를 기록한 문서(`PLAN-route.md`, `NOTES-phase0.md`)와 첫 구현인 파이썬 배치기(`gpuplace/`)도 걷어냈다
(커밋 `0e04d6a` 까지 있다). 필요하면 git 기록에서 꺼낸다.

## 소스

`symplace/` 에 소스와 검사, 도구가 있다 — 자세한 것은 [symplace/README.md](symplace/README.md).

```
symplace/alignroute/        Rust 배선기 — build.sh 가 src/route/alignroute.wasm 을 만든다 (lp_solve C 소스를 같이 빌드)
symplace/web/placer/test/   node 검사 — 심플렉스, 에너지 대조, 배치(ALIGN 대조), legalize, 검사기·격자·GDS 고정 사례, 브라우저(WebGPU·페이지)
symplace/web/placer/fixtures/  고정값 — 배치 문제의 정답 4 예제, 검사기 사례 106, 격자 문구 150, GDS 2
symplace/web/placer/pack-example.mjs  ALIGN 작업 디렉터리(또는 앞단 출력 폴더) -> data/, routed/ 의 예제 파일
symplace/web/placer/README.md  배치기 설계 노트 (변이·반전·영역·계층을 어떻게 고르는지, legalize)
symplace/scripts/           align-baseline.sh (네이티브 ALIGN 으로 기준선), measure-memory.sh, z3 빌드,
                            route/node/ (페이지와 같은 배치·배선을 node 에서), place/ (변이 선택 분석)
symplace/setup.sh, env.sh   네이티브 ALIGN 설치·환경 — 기준선을 만들 때만
symplace/patches/           ALIGN 배선 단계 메모리 8.4GB -> 1.45GB 패치
symplace/PLAN-route-align.md          배선기를 ALIGN 알고리즘 그대로 옮긴 계획과 대조 결과
symplace/PLAN-place-variants-gpu.md   변이 선택이 ALIGN 과 갈리던 이유(실측)와 WebGPU 계획·결과
```

배치기 본체(`src/*.mjs`)는 **이 저장소 루트의 것 하나뿐이다.** 사이트가 그대로
읽고, 검사도 그것을 읽는다 (`symplace/web/placer/test/*` 가 `../../../../src/`
를 임포트한다). 검사가 읽는 예제도 사이트가 읽는 `data/<예제>.json` 그대로다. 사본을 두지 않는다 — 두면 갈라진다.

```bash
node symplace/web/placer/test/place.mjs      # 앞단 출력만으로 배치 (본 경로) — ALIGN 과 변이·반전·면적·HPWL 대조
node symplace/web/placer/test/lp.mjs         # 심플렉스 검증
node symplace/web/placer/test/parity.mjs     # 에너지·기울기·영공간을 고정값과 대조
node symplace/web/placer/test/design.mjs     # 앞단 출력에서 만든 문제 == 고정값의 문제
node symplace/web/placer/test/legalize.mjs   # 겹침 0 / 대칭 잔차 / 면적·배선
node symplace/web/placer/test/chunk.mjs      # 끊어 돌린 Adam == 한 번에 돌린 Adam
node symplace/web/placer/test/variants.mjs   # 변이 배정 전수 비교 (ALIGN 배정의 순위)
node symplace/web/placer/test/gpu.mjs        # GPU runner == CPU (headless Chromium, WebGPU)
node symplace/web/placer/test/page.mjs high_speed_comparator gpu 96 32   # 페이지 통째로 (워커 + WebGPU)
node symplace/web/placer/test/leaves.mjs     # 리프 도형 파일이 예제와 맞는가
node symplace/web/placer/test/check.mjs      # JS DRC/LVS 검사기 == ALIGN 파이썬 검사기
node symplace/web/placer/test/compose.mjs    # 배선 도형의 격자 검사 == gen_viewer_json
node symplace/web/placer/test/gds.mjs        # GDS == ALIGN 파이썬 GDS (바이트)
node symplace/scripts/route/node/newroute.mjs all   # 예제 전부를 페이지와 같은 길로 배선 (DRC/LVS 를 찍는다)
```

## 의존성

**페이지를 여는 데 드는 것: 없다.** ES 모듈과 wasm 하나(`src/route/alignroute.wasm`, 1.3 MB)뿐이고,
글꼴도 시스템 것을 쓴다 — 외부 주소를 하나도 안 부른다. 예제를 고르고 배치·배선·GDS 까지 오프라인으로 된다.

| 무엇을 할 때 | 드는 것 |
|---|---|
| `.sp` 를 올릴 때 (앞단) | Pyodide 0.27.8 을 jsDelivr CDN 에서, networkx·pydantic 1.10.13·python-gdsii 를 PyPI 에서 (합쳐 약 16 MB), 저장소의 libz3 (22 MB, `py/z3`) 와 ALIGN 앞단 소스 (0.2 MB, `py/front`). 첫 방문에만 받고 브라우저가 캐시한다 |
| node 검사 | node 22. 브라우저 검사(`gpu.mjs`, `page.mjs`)만 Playwright 전역 설치 |
| 배선기 빌드 | Rust (wasm32-wasip1), clang + wasi-libc, lp_solve 5.5.2.11 C 소스 (`fetch-lpsolve.sh` 가 받는다). crate 는 serde·serde_json 뿐 |
| 새 예제의 ALIGN 기준선 | 네이티브 ALIGN 0.9.8 (`symplace/setup.sh` 가 venv 에 설치한다) |

앞단의 Pyodide 스택이 남은 가장 큰 의존성이다 — ALIGN 앞단(회로 읽기·소자 묶기·템플릿 생성)을 JS 로
옮기면 없어진다. 그 계획은 [PLAN.md](PLAN.md).
