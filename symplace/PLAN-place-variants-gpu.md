# 변이 선택이 ALIGN 과 갈리는 이유, 그리고 배치기를 WebGPU 로 옮기는 계획

배치기가 ALIGN 원본보다 길쭉한 변이를 고르고 면적·배선 효율이 떨어진다는 관찰에서
출발한다. 1 절은 ALIGN 원본이 변이를 고르는 방식(소스 근거), 2 절은 우리 배치기가
어디서 갈리는지를 실측으로 짚고, 3 절이 처방, 4 절이 WebGPU 계획이다.

실측은 전부 이 저장소의 코드로 다시 낼 수 있다 (`symplace/web/placer/test/variants.mjs`,
`test/place.mjs`, 그리고 이 문서를 쓰며 만든 스크립트 셋 — 5 절).

## 0. 요약

원인은 셋이고 무게가 다르다.

1. **배선 저울이 핀의 길이를 안 본다** (가장 크다). 우리 HPWL 은 넷마다 핀 사각형
   합집합의 **중심 한 점**을 쓴다. ALIGN 의 비용은 `HPWL_extend` — 핀 **경계 사각형**의
   min/max 다. 손가락 16 개를 한 줄로 늘어놓은 `X16_Y1` 은 핀이 폭 5,032 짜리 가로
   막대인데, 우리 눈에는 블록 중앙의 점 하나다. 그래서 길쭉한 변이일수록 배선이
   공짜로 보인다. five_transistor_ota 에서 우리 배정은 우리 저울로 ALIGN 배정을
   이기지만 (2.68 대 3.00), ALIGN 저울로는 배선이 2.1 배 길다 (16,732 대 7,860).
   **우리가 만든 후보들을 ALIGN 저울로 다시 줄 세우면 ALIGN 의 배정이 60 개 중 1 위다.**
2. **배정 하나의 점수가 표본 서너 개로 정해진다.** 설정(배정 x 영역)마다 시작점이
   1~4 개고, 씨앗에 따른 흔들림(±10%)이 배정 간 점수 차(3~9%)보다 크다.
   telescopic_ota 에서는 우리 저울로도 ALIGN 배정이 전수 비교에서 1 위인데, 실제
   실행은 2 위를 골랐다. 같은 배정의 우리 표본이 1440x11760 (ALIGN) 대신
   2560x9408 (1.42 배) 에 머물렀기 때문이다.
3. **후보의 면적을 압축하지 않고 잰다.** ALIGN 은 수열쌍마다 ILP 로 좌표를 압축해
   그 배치 위상의 최소 면적을 잰다. 우리는 slack 1.25 영역에서 퍼뜨린 연속해를
   L1 이동 최소 LP 로 굳힌 면적을 잰다. 분리 방향을 연속해에서 읽어 박으므로,
   연속해가 두 줄로 놓은 것을 LP 가 한 줄로 되돌리지는 못한다. 2 번의 표본 문제가
   면적 항에 그대로 실린다.

1 은 저울 수정으로 고친다 (3.1 절, GPU 와 무관, 먼저 한다). 2 와 3 은 표본을
수십 배 늘려야 하고, 그게 WebGPU 를 쓰는 이유다 (4 절). 연속 단계의 시간 90% 가
밀도항의 DCT 행렬곱인데, 이건 시작점 축으로 완전히 독립이라 컴퓨트 셰이더에
그대로 맞는다. 옮기기 전에 밀도항을 랭크 N 항등식으로 3 배 줄인다 (4.2 절) —
CPU 도 같이 빨라지고, GPU 가 흉내낼 알고리즘이 하나로 정리된다.

## 1. ALIGN 원본은 변이를 어떻게 고르나

ALIGN-public `PlaceRouteHierFlow/placer/` (master, 2026-09 기준) 을 읽었다.
저장소에는 이 소스가 없다 — 배선기(`alignroute`)만 옮겼고 배치기는 새로 짰기 때문이다.

**탐색.** `Placer::PlacementCoreAspectRatio_ILP` 가 수열쌍(sequence pair) 담금질을
돈다. 상태는 `(posPair, negPair, selected[])` — `selected[i]` 가 블록 i 의 변이다.
이동은 일곱 가지 중 무작위고 그중 하나가 `ChangeSelectedBlock` (블록 하나를 골라
변이를 아무거나로 바꾼다). 온도는 `T_INT 0.5 -> T_MIN 0.05`, `ALPHA 0.995` 라
온도 단계가 460 개고, 단계마다 `effort` 번 이동한다. 수열쌍 수 x 변이 조합 수가
460 이하면 담금질 대신 **전수 열거**한다 (`SeqPairEnumerator`). 예제 다섯 개의
최상위는 전부 한도를 넘어 담금질이다 (five_transistor 는 36 x 60 = 2,160).
hsc 의 블록 두 개짜리 하위 모듈은 4 x 변이 조합이라 전수 열거 범위에 들 수 있다.

**좌표.** 후보 `(sp, selected)` 마다 `ILP_solver::GenerateValidSolution` 이 좌표를
ILP 로 푼다. 목적함수는 `LAMBDA x 핀 중심 HPWL + 추정 둘레` 이고, 거울 반전
(`H_flip`, `V_flip`)은 ILP 안의 이진 변수다. 즉 **위상이 주어지면 그 위상의 가장
빽빽한 좌표**가 나온다.

**비용** (`ILP_solver::CalculateCost(design, sp)`):

```
cost = log(area) + LAMBDA * log(HPWL_extend_net_priority) + LAMBDA * log(cfcost)
     + 제약 벌점 (match / linear / multi_linear)
LAMBDA = 1.0 (PlacerHyperparameters.h)
```

- `area` 는 전체 bbox 면적.
- `HPWL_extend` 는 넷마다 **핀 경계 사각형** (`blockPins[].boundary`, 반전 적용)
  의 `min llx / max urx / min lly / max ury` 로 잰 반둘레. 핀이 막대면 막대 전체가
  들어간다. 넷 가중치 `weight` 를 곱한 것이 `_net_priority` (기본 1).
- 종횡비는 비용이 아니라 **가부**다. `ratio = UR.x / UR.y` 가 `Aspect_Ratio[0..1]`
  (제약 없으면 `[0, 100]`) 밖이면 후보 자체를 버린다 (-1).
- `log` 라 정규화 상수가 없다. 면적 10% 와 배선 10% 가 같은 값이다.

## 2. 갈리는 지점 — 실측

### 2.1 배선 저울이 핀의 길이를 안 본다

five_transistor_ota, ALIGN 배치와 우리 배치(시작점 96, 씨앗 1, 격자)에 두 저울을
같이 댔다 (`symplace/scripts/place/hpwl_extend.mjs`).

| 배치 | 변이 | bbox | 면적 | 핀 중심 HPWL (우리) | HPWL_extend (ALIGN) |
|---|---|---|---|---|---|
| ALIGN | X4_Y1 X8_Y2 X4_Y2 | 4160x5880 | 24.46M | 4,260 | 7,860 |
| 우리 | X4_Y1 **X16_Y1 X8_Y1** | 5600x4704 | 26.34M | **3,420** | **16,732** |

넷별로 보면 무슨 일인지 바로 보인다.

| 넷 | 우리 (중심) | ALIGN (경계) |
|---|---|---|
| VON | 252 | 5,316 |
| VOP | 912 | 5,856 |
| TAIL | 2,256 | 5,560 |

`DP_NMOS_B_29120057_X16_Y1` (5600x2352) 의 핀은 `DA [284..5316]`, `GA [284..5316]`
처럼 **폭 5,032 의 가로 막대**다. `X8_Y2` (3040x3528) 의 같은 핀은 폭 40 의 세로
막대다. 우리 `templateInfo` 는 넷별 합집합 사각형의 중심만 남기므로 (`design.mjs`),
막대의 길이가 통째로 사라진다. 결과로

- 우리 저울: 우리 배치 2.68 < ALIGN 배치 3.00 — 우리가 이긴다.
- ALIGN 저울 `log(area) + log(HPWL_extend)`: 26.81 > 25.98 — `e^0.83 = 2.3 배` 진다.

이 착시는 **길쭉한 변이에 체계적으로 유리하다.** 핀 막대의 길이는 변이의 폭에
비례하는데 핀 중심은 늘 블록 가운데 근처라, 넷이 블록 중심만 맞추면 배선이 0 에
가깝게 보인다. 반전 고르기가 HPWL 을 8,964 -> 3,420 (0.38 배) 으로 줄인 것도 같은
착시다 — 진짜 배선은 그만큼 줄지 않는다.

**후보를 ALIGN 저울로 다시 세우면 어떻게 되나** (`symplace/scripts/place/rescore.mjs`: 배정을
전수로 돌려 legalize 까지 간 배정별 최선을 세 저울로 줄 세운다).

| 예제 | (a) 우리 점수 | (b) ALIGN 저울 | (c) 우리 점수에 HPWL_extend 만 끼움 |
|---|---|---|---|
| five_transistor_ota (60 배정) | ALIGN 배정 4 위 | **1 위** | 2 위 |
| telescopic_ota (8 배정) | 4 위 | 2 위 | 2 위 |
| current_mirror_ota (2 배정) | 1 위 | 1 위 | 1 위 |

five_transistor 는 저울만 바꾸면 끝난다. telescopic 은 저울을 바꿔도 2 위인데,
그 이유가 2.2 절이다.

### 2.2 배정 하나의 점수가 표본 몇 개로 정해진다

telescopic_ota 의 ALIGN 배정 `[1,1,0,0,1]` (X2_Y1 X2_Y1 X1_Y1 X1_Y1 X3_Y1) 은
블록을 폭 1440 한 줄로 쌓으면 1440x11760 = 16.93M 이다. 우리 후보 중 그 배정의
최선은 실행에 따라 다르다.

```
variants.mjs (무게 1, 격자 없음, 씨앗 1)   1440x11760   면적 1.000x   -> 1 위
rescore.mjs  (무게 2, 격자 없음, 씨앗 1)   2560x9408    면적 1.42x    -> 4 위 (우리 저울)
place.mjs    (무게 2, 격자,      씨앗 1)   X1_Y2 를 고름 1440x12936  면적 1.100x
```

같은 코드, 같은 씨앗인데 무게 하나가 바뀌자 그 배정의 표본이 한 줄 배치를 못
찾았고, 그 순간 배정 간 순위가 뒤집혔다. 설정이 24 개에 시작점 96 이면 설정당
4 개, 라운드를 거쳐도 배정당 열 개 남짓이다. 씨앗에 따른 흔들림이 ±10% (README)
인데 상위 배정 간 점수 차는 3~9% 다. **순위가 표본 잡음 안에 있다.**

### 2.3 후보의 면적을 압축하지 않고 잰다

ALIGN 은 위상(수열쌍)마다 ILP 로 좌표를 압축한다 — 그 위상에서 가장 작은 면적을
잰다. 우리 legalize 는 연속해에서 쌍마다 분리 방향을 읽어 **박은 뒤** L1 이동을
최소화한다 (`legalize.mjs`). 연속해가 두 블록을 나란히 놓았으면 LP 는 그 둘을
위아래로 못 옮긴다. 목적함수의 반둘레 항(`0.5 x n x 반둘레`)은 방향이 허락하는
범위 안에서만 당긴다. 그래서 2.2 의 2560x9408 이 그대로 남는다 — 면적 항이
"그 배정의 면적" 이 아니라 "그 표본이 우연히 도달한 면적" 이다.

이건 2.2 와 같은 처방(표본 늘리기)으로 대부분 가려지고, 남는 것은 4.6 절의
방향 뒤집기다.

### 2.4 계층 설계에서는 같은 원인이 아래층에서 위층으로 올라간다

hsc 의 하위 모듈 `PRIMITIVE_*` 는 블록이 두 개다. 그 안에서 2.1 의 착시로 길쭉한
변이를 고르면 모듈 자체가 길쭉해지고 (README 의 1280 x 19992), 그것이 상위의
입력이 된다. `spreadShapes` 로 여러 모양을 올리는 것은 증상을 덮는 장치지
원인을 없애지 않는다. 저울을 고치면 하위 모듈에서부터 달라진다.

### 2.5 갈리지 않는 것

- 면적 정의는 같다 (bbox). 전원 넷 제외도 우리와 같은 효과다 (ALIGN 은 핀이 없는
  넷을 `floating_pin` 으로 빼는데, 전원 넷 처리는 이번에 확인하지 못했다).
- 종횡비: ALIGN 도 비용에 안 넣는다. 우리 영역 후보 사다리는 ALIGN 의
  `Aspect_Ratio` 가부와 역할이 같다.
- `hpwlWeight` 의 무게 자체는 문제가 아니다. 2.1 은 무게를 어떻게 두어도 안
  고쳐진다 — 잰 양이 다르다.

## 3. 처방 (저울) — GPU 와 무관하고, 먼저 한다

### 3.1 핀을 점이 아니라 사각형으로

`design.mjs`
- `templateInfo`: 넷별 합집합 사각형에서 중심 오프셋과 함께 **반폭 `[ex, ey]`** 를
  남긴다. 반전은 오프셋 부호만 바꾸고 반폭은 그대로다.
- `buildProblem`: `pinOff` 옆에 `pinExt` (핀당 `[ex, ey]`) 를 둔다.

`solver.mjs` `hpwl`: 넷 bbox 를 `min(x - ex)`, `max(x + ex)` 로 잰다. 이게 곧
`HPWL_extend` 다 (합집합 사각형이 개별 사각형들의 min/max 와 같다).

`energy.mjs` `wirelength`: 부드러운 max 에 `x + ex`, 부드러운 min 에 `x - ex` 를
넣는다. 식은 그대로고 입력 점만 바뀐다 — 기울기는 두 항이 같은 `x` 로 흘러
들어가므로 합치면 된다. 비용 증가 0.

`refineFlips` 는 `hpwl` 을 부르므로 따라온다.

### 3.2 점수를 ALIGN 형태로

```
score = log(area) + hpwlWeight * log(HPWL_extend)      (겹침 벌점은 그대로)
```

`refArea / refHpwl` 정규화가 사라진다 — README 가 두 절에 걸쳐 설명하는 "기준을
배정 전체에 걸쳐 하나로" 문제가 애초에 생기지 않는다. `hpwlWeight` 는 `LAMBDA`
자리에 그대로 남고, 기본은 1 이 자연스럽다 (ALIGN 과 같은 저울). 슬라이더의 로그
눈금도 그대로 맞는다.

### 3.3 검증

- `test/variants.mjs` 에 `hpwl_extend` 열과 (b) 순위를 찍는다. five_transistor 에서
  ALIGN 배정이 1 위, current_mirror 1 위가 나와야 한다.
- `test/place.mjs` 다섯 예제. 기대: five_transistor 가 ALIGN 과 같은 변이 (3/3),
  hsc 하위 모듈의 폭 1280 홀쭉이가 사라짐. telescopic 은 3 절만으로는 씨앗 운이
  남는다 (2.2) — 4 절 뒤에 다시 잰다.
- `hpwlBeforeFlip -> hpwl` 의 반전 이득이 0.38 배 같은 값에서 ALIGN 급 (0.7~0.9)
  으로 돌아오는지 본다. 착시가 사라졌다는 뜻이다.

## 4. WebGPU 계획

### 4.1 시간이 어디에 가나

한 시작점(Adam 600 스텝)을 항별로 쟀다 (`symplace/scripts/place/prof.mjs`, node 단일 스레드).

| 예제 | n | theta | 격자 | Adam 600 | eval x600 | 밀도항 | 배선 | 면적 |
|---|---|---|---|---|---|---|---|---|
| five_transistor_ota | 3 | 5 | 8x48 | 99 ms | 65 ms | 66 ms | 2 ms | 4 ms |
| telescopic_ota | 5 | 7 | 8x48 | 76 ms | 73 ms | 62 ms | 6 ms | 2 ms |

밀도항이 90% 다. 그 안은 `overlap1d` (N x M) 가 아니라 **DCT 네 번의 행렬곱**
(`Cx rho Cy^T` 와 역변환, 각 `M^3`) 과 `rho`, 기울기의 `N x Mx x My` 합이다.
시작점 하나가 0.1~0.2 초고, 예제 전체로는 five_transistor 180 시작점 33 초,
hsc 288 시작점 170 초다. 2.2 가 요구하는 "설정당 수십 개" 는 CPU 로는 분 단위가
아니라 시간 단위가 된다.

### 4.2 옮기기 전에 — 밀도항은 랭크 N 이다

`rho` 는 블록마다 1 차원 겹침의 외적 합이다.

```
rho = (1/cell) * sum_i  ox_i oy_i^T          ox_i in R^Mx,  oy_i in R^My
```

DCT 가 직교라 변환이 외적 안으로 들어간다.

```
R   = Cx rho Cy^T = (1/cell) * sum_i  u_i v_i^T        u_i = Cx ox_i,  v_i = Cy oy_i
S   = R  o  invDen                                       (invDen[0,0] = 0)
D   = (cell/2) <rho, psi> = (cell/2) <R, S>              (psi = Cx^T S Cy, 직교)
gcx_i = dox_i^T psi oy_i = (Cx dox_i)^T S v_i
gcy_i = ox_i^T psi doy_i = u_i^T S (Cy doy_i)
```

평균 빼기(`rho -= mean`)는 `R[0,0]` 만 바꾸고 그것은 `invDen[0,0] = 0` 이 지우므로
그대로 성립한다. `psi` 와 `rho` 를 **아예 만들지 않는다.** 시작점당 남는 격자
상태는 `S` (Mx x My) 하나다.

| | 곱셈 수 (N=11, 48x48) |
|---|---|
| 지금 (DCT 4 번 + rho + 기울기) | 4·48³ + 2·11·48² ≈ 490k |
| 랭크 N | 4·11·48² + 2·11·48² + 48² ≈ 155k |

3 배다. 실수 산술로는 같은 식이라 결과가 반올림 오차 안에서 같다 —
`test/parity.mjs` 의 허용오차로 확인한다. **CPU 판에 먼저 넣는다.** 그러면
CPU 가 3 배 빨라지고, GPU 커널이 흉내낼 알고리즘이 하나다.

### 4.3 무엇을 옮기고 무엇을 남기나

| 단계 | 어디 | 이유 |
|---|---|---|
| 배정 열거, 영역 후보, `makeObjective` (영공간, DCT 행렬) | CPU | 설정당 한 번, 싸다 |
| `initTheta` (시작점 뽑기) | CPU | mulberry32 재현성을 지킨다. B x P 개 실수 |
| **Adam 600 스텝 (eval + 갱신)** | **GPU** | 시간의 전부. 시작점 축으로 독립 |
| `exactArea`, `exactOverlap`, `hpwl`, `refineFlips` | CPU | 읽어온 theta 로 f64 재계산. 후보당 ms |
| legalize (LP, 격자 분기) | CPU | f64 심플렉스. 상위 후보만 |

경계는 `multiStartVariants` 의 `runOne` 이다. 그 자리를 `runner.runMany(jobs)`
로 바꾼다 — `jobs = [{configIndex, theta0}]`, 반환은 시작점마다 `{theta, cx, cy}`.
CPU runner 가 지금 코드고, GPU runner 가 새 코드다. 라운드 구조(너비 -> 깊이)는
그대로 두되 한 라운드가 한 번의 `runMany` 가 된다.

### 4.4 자료 배치

정밀도: WGSL 은 f32 다. 좌표를 **영역의 긴 변으로 나눠** 무차원으로 둔다
(`x' = x / span`). 그러면 `gamma = 0.02`, `beta = 8`, `lr = 1/400` 이 상수가 되고
면적 ~1, 배선 ~1 이라 f32 로 충분하다. `calibrate` 가 `lam`, `mu` 를 기울기
비로 잡으므로 스케일은 어차피 상쇄된다. 지수는 이미 최댓값을 빼고 있다.

설정은 `n`, `P`, `Mx`, `My` 가 제각각이다. 모듈 하나의 설정 전체를 **한 디스패치**
에 넣기 위해 최댓값(`NMAX`, `PMAX`, `MMAX = 48`)으로 채운다. 설정표 (storage):

```
config[c] = { n, P, rows, Mx, My, hx, hy, x0, y0, span,
              off_z0, off_N, off_wh, off_pinByBlock, off_pinByNet, off_Cx, off_Cy, off_invDen, region }
start[b]  = { c, t }                                  b 가 워크그룹 번호
```

시작점당 상태 (f32): `theta, m, v, grad` (4·P), `cx, cy, gz` (3·2n),
`u, v, a, b` (4·N·MMAX = 8.4 KB), `S` (MMAX² = 9.2 KB). 합 ≈ 18 KB.
시작점 4,096 개 한 판이 74 MB 라 한 버퍼(기본 256 MB) 안이다. 그 이상은 판을
나눠 돌린다.

### 4.5 커널 — 한 스텝을 여섯 패스로

워크그룹 하나가 시작점 하나다 (64 스레드). 패스마다 전체 시작점을 한 디스패치로.

1. `centers`: `z = z0 + N theta` (스레드가 행 하나), 핀 좌표.
2. `wire`: 넷마다 부드러운 max/min (스레드가 넷 하나, 핀은 CSR). 핀 기울기를 블록별로
   모은다 (블록별 핀 CSR 로 두 번째 루프 — 원자연산 없음). 3.1 의 `pinExt` 포함.
3. `overlap`: 블록마다 `ox, dox` (Mx), `oy, doy` (My), 그리고 `u_i = Cx ox_i`,
   `a_i = Cx dox_i`, `v_i = Cy oy_i`, `b_i = Cy doy_i` (스레드가 격자 한 칸의 내적).
4. `S`: 칸 (m, n) 마다 `invDen[m,n] * sum_i u_i[m] v_i[n] / cell`, 부분합으로 `D`.
5. `grad`: 블록마다 `gcx_i = a_i^T S v_i`, `gcy_i = u_i^T S b_i` (스레드가 m 하나,
   워크그룹 합), 면적 LSE 와 경계 벌점 (n ≤ 16 이라 스레드 하나가 한다), `gz`.
6. `adam`: `grad_theta = N^T gz` (스레드가 k 하나), Adam 갱신. `lam, mu` 는
   `t` 에서 계산한다 (`lam0 * lamGrow^floor(t/50)`) — 버퍼 왕복이 없다.

600 스텝이면 3,600 디스패치인데 전부 한 커맨드 버퍼에 담아 한 번 제출한다.
화면 갱신은 40~50 스텝 단위로 끊어 제출하고 읽어온다. Adam 의 `m, v, t` 는 GPU 에
남으므로 끊어 돌린 것과 한 번에 돌린 것이 같다 — `test/chunk.mjs` 가 재는 성질
그대로다. `calibrate` 는 첫 eval 뒤 기울기 L1 합을 워크그룹 합으로 내고 `lam, mu`
를 시작점 버퍼에 쓴다.

한 커널로 합치는 것(워크그룹 메모리에 `S` 와 벡터 네 개, 17.6 KB)은 두 번째 단계다.
보장 한도가 16 KB 라 `maxComputeWorkgroupStorageSize` 를 32 KB 로 요청해야 하고,
못 받으면 여섯 패스로 돌린다. 먼저 여섯 패스로 만들어야 패스마다 CPU 함수 하나와
대조할 수 있다 (`wirelength` <-> 2, `Density.eval` <-> 3~5, `area/boundary` <-> 5).

### 4.6 예산과 선택을 바꾼다

GPU 가 있으면 시작점을 "총 96" 이 아니라 **설정당 S 개** 로 준다. `S = 32` 면

| 예제 | 설정 | 시작점 | 스텝당 곱셈 (4.2) | 총 연산 | 내장 GPU 1 TFLOPS 기준 |
|---|---|---|---|---|---|
| five_transistor_ota | 180 | 5,760 | ~60k (n=3) | 0.4 TFLOP | ~1 s |
| high_speed_comparator 최상위 | 288 | 9,216 | ~150k (n=10) | 1.7 TFLOP | ~3 s |

지금 CPU 는 각각 33 초, 170 초를 시작점 180 / 288 개에 쓴다. 표본이 30 배 늘면서
시간이 수십 분의 일이 된다. 수치는 추정이고 첫 구현에서 잰다.

선택 쪽에서 같이 바꿀 것:
- 배정 점수는 표본 최선 하나가 아니라 **상위 k 개의 평균**(예: 4 개)으로 둔다. 표본이
  많을 때 최선만 쓰면 잡음의 꼬리를 고른다. 화면에는 중앙값도 띄운다.
- legalize 는 배정마다 상위 2 개 + 전체 상위 32 개 (LP 가 20~120 ms 라 CPU 예산).
- **방향 뒤집기** (2.3): legalize 상위 후보에 대해 침범량이 비슷한 쌍의 방향을
  하나씩 뒤집어 LP 를 다시 풀고 반둘레가 줄면 받는다. 후보당 LP 몇 번이라 CPU 로
  충분하다. ALIGN 의 "위상마다 압축" 에 가장 가까운 값싼 대체다.

### 4.7 정확성 검사

- `test/gpu-parity.mjs`: 다섯 고정값의 `theta` 에서 GPU 여섯 패스의 `W, D, B, grad`
  를 CPU 와 대조, 상대오차 1e-4 (f32). node 에서는 headless Chromium 의 소프트웨어
  어댑터(Playwright) 나 Dawn 바인딩(`webgpu` 패키지)으로 돌린다 — 어느 쪽이 CI 에서
  안정적인지는 M2 에서 정한다.
- `test/gpu-chunk.mjs`: 40 스텝씩 끊은 것과 한 번에 600 스텝이 같다.
- 끝까지: 다섯 예제를 같은 씨앗으로 CPU / GPU 돌려 **고른 배정이 같은지** 본다.
  f32 라 좌표까지 같을 수는 없고, 배정 순위와 면적·HPWL 비가 1% 안이면 통과.
- 결정론: 원자연산을 안 쓰고 워크그룹 합의 차례를 고정하므로 같은 장치에서는
  비트까지 재현된다. 장치가 다르면 허용오차다.

### 4.8 브라우저 통합

- 워커 안에서 `navigator.gpu` 를 쓴다 (Chrome/Edge, Firefox, Safari 26 이 전용
  워커에서도 WebGPU 를 준다). 워커에 없으면 GPU 는 메인 스레드에서 돌리고 CPU
  후처리(legalize)만 워커에 남긴다. 어댑터가 아예 없으면 CPU runner 로 조용히
  떨어지고 화면에 "CPU" 라고 적는다 (`{type:"baseline"}` 메시지에 `runner`).
- 파일: `src/gpu/runner.mjs` (버퍼·파이프라인·제출), `src/gpu/kernels.mjs`
  (WGSL 문자열 여섯 개), `src/gpu/pack.mjs` (설정표 채우기). `solver.mjs` 는
  `runner` 인자를 받는 것 외에 안 바뀐다.
- 진행 표시는 지금의 `onProgress` 를 라운드·조각 단위로 부른다.

### 4.9 단계

| 단계 | 일 | 검사 |
|---|---|---|
| M0 | 3 절 저울 (핀 반폭, log 점수) | variants / place 의 ALIGN 배정 순위 |
| M1 | 4.2 랭크 N 밀도항을 CPU 에 | parity, chunk, place 결과 동일 |
| M2 | runner 경계, GPU 여섯 패스, parity | gpu-parity, gpu-chunk |
| M3 | 설정당 S 시작점, 상위 k 평균, 페이지 통합 | 다섯 예제 CPU 대 GPU, 시간 |
| M4 | 방향 뒤집기, 한 커널로 합치기 | 면적비, 시간 |

## 5. 이 문서를 쓰며 만든 것 — `symplace/scripts/place/`

```bash
node symplace/scripts/place/hpwl_extend.mjs five_transistor_ota   # 2.1 의 표 (배치 한 판을 돈다, 30 s)
node symplace/scripts/place/rescore.mjs five_transistor_ota       # 2.1 의 순위표 (전수, 40 s)
node symplace/scripts/place/prof.mjs                              # 4.1 의 표
```

- `hpwl_extend.mjs`: 한 예제의 ALIGN 배치와 우리 배치에 핀 중심 HPWL 과
  HPWL_extend 를 같이 댄다.
- `rescore.mjs`: 배정 전수 -> legalize -> 세 저울로 줄 세우기. 둘째 인자로
  시작점 수 (기본 96).
- `prof.mjs`: Adam 한 시작점의 항별 시간.

3 절을 구현할 때 `rescore` 의 HPWL_extend 열은 `test/variants.mjs` 에 합치고,
이 스크립트들은 걷어내도 된다.
