# symplace — 대칭을 좌표계로 흡수한 아날로그 배치기

[ALIGN](https://github.com/ALIGN-analoglayout/ALIGN-public) 의 배치 단계를
**연속 최적화**로 대체한다. 파이썬 구현과, 같은 알고리즘을 의존성 없이 옮긴
브라우저 구현이 들어 있다. 회로(.sp)를 올리면 앞단 · 배치 · 배선 · GDS · DRC
까지 탭 안에서 돈다. ALIGN 의 배선 단계 메모리를 83% 줄이는 패치도 함께.

## 이 저장소에서의 자리

여기는 **정적 사이트 저장소 안**이다. 사이트는 저장소 루트에 있고
(`/index.html`, `/src/*.mjs`, `/data`, `/netlists`, `/routed`, `/py`),
이 `symplace/` 는 그 배치기의 소스다. 원본 저장소와 두 군데가 다르다.

- `web/placer/src/` **없다.** 배치기 본체는 저장소 루트의 `/src/*.mjs`
  하나뿐이다 (사이트가 읽는 바로 그 파일). 여기 사본을 두면 갈라지므로,
  `web/placer/test/*` 와 `emit.mjs` 가 루트 쪽을 임포트한다.
- `web/placer/site/` **없다.** 그게 저장소 루트다. 올리는 법은 루트의
  `README.md` 에 있다.

```bash
node symplace/web/placer/test/place.mjs      # 저장소 루트에서 돌린다
```

`web/placer/index.html` (옛 데모)도 루트의 `src/` 를 읽으므로 저장소 루트에서
HTTP 로 띄워야 한다: `http://127.0.0.1:8791/symplace/web/placer/index.html`.

## 핵심 한 문단

ALIGN 의 배치기는 수열쌍(sequence pair)을 담금질로 훑는다. 후보가 (n!)² 이라
블록이 늘면 감당이 안 되고, 실행 시간의 **78%** 를 여기서 쓴다.

대신 대칭·정렬 같은 등식 제약을 벌점이 아니라 **좌표계**로 흡수한다.
제약을 `A z = b` 로 모으고 영공간 매개화 `z = z₀ + Nθ` 를 만들면, **어떤 θ 를
넣어도 제약이 정의상 정확히 만족된다.** 자유도도 줄어든다 (telescopic_ota: 11 → 7).

그 θ 공간 위에서 미분 가능한 에너지를 내린다.

```
E = W + λ·D + μ·B
    W  넷을 따라 당기는 스프링      (매끄럽게 편 HPWL)
    D  같은 부호 전하들의 반발      (젤리움 = 전하 + 균일 중화 배경, DCT 로 푸는 포아송)
    B  영역 밖으로 나간 만큼의 벌점
```

λ 를 50 스텝마다 키운다. 처음에는 블록이 서로 뚫고 지나가는 무른 유체로 두었다가
서서히 굳혀 겹침을 없앤다 — 담금질에서 온도를 내리는 일과 같다.

연속 완화는 겹침을 *거의* 없앨 뿐 정확히 0 으로 만들지 못한다. 마무리는 이산으로
하되, **여전히 θ 공간에서** 한다. x 공간에서 블록을 밀면 대칭이 깨지지만
θ 공간에서는 어떻게 움직여도 `z = z₀ + Nθ` 가 제약을 지킨다.

---

## 빠른 시작

필요한 것: Ubuntu 24.04 (WSL2 포함), Python 3.10+, git.
브라우저 구현을 돌리려면 node 도 (파이썬 쪽은 무관).

```bash
sudo apt install -y python3-dev python3-venv build-essential git
```

`python3-dev` 가 없으면 gdspy 휠 빌드가 `Python.h: No such file` 로 깨진다.

```bash
./setup.sh          # venv, align-analoglayout 0.9.8, ALIGN-public, 메모리 패치
source env.sh
./scripts/verify.sh telescopic_ota
```

`verify.sh` 가 하는 일: ALIGN 앞단 → 우리 배치기 → ALIGN 배선 → GDS/DRC 확인.
예제 하나에 2~5 분쯤 걸린다. 끝나면 이런 줄이 나와야 한다.

```
  최선 (OPTIMAL): 면적 1.00x, HPWL 0.99x, 겹침 1.32e-08, 대칭 잔차 3.18e-12
  배선용 출력: 이동 7.73e-12, 겹침 0, bbox [0, 0, 1440, 11760]
  배선 OK   GDS 80K   DRC/LVS 에러 0
```

---

## 구성

```
setup.sh                 ALIGN 받아 설치하고 패치 적용
env.sh                   source 해서 쓰는 환경 설정 (경로는 위치에서 유도)
scripts/
  verify.sh              끝에서 끝까지: 배치 -> 배선 -> GDS/DRC
  measure-memory.sh      메모리 패치 효과를 직접 재본다
patches/
  align-memory.patch     ALIGN 배선 단계 메모리 8.4GB -> 1.45GB
  README.md              왜/무엇을/측정치/손으로 적용하는 법
gpuplace/                파이썬 배치기
  subspace.py            제약 -> A z = b, 영공간 z = z0 + N theta
  energy.py              에너지와 해석적 기울기 (+ 유한차분 검증)
  batch.py               시작점 수천 개를 numpy 축으로 한꺼번에
  legalize.py            theta 공간 MILP 로 겹침 제거
  netlist.py             배치 JSON 에서 핀/넷 추출 (계층 포함)
  placement.py           ALIGN 배치 JSON 입출력
  handoff.py             PDK 격자에 맞춰 ALIGN 배선기로 넘기기
  m0/m1/m2.py            단계별 구동 스크립트 (m2 가 최종)
web/placer/              JS 배치기 — **ALIGN place 단계 없이 도는 쪽**
  src/*.mjs              의존성 없는 ES 모듈 (node 와 브라우저 공용)
  src/design.mjs           앞단 출력 -> 배치 문제. 변이/영역/반전의 자유도
  src/place.mjs            입구 하나. 계층까지 엮는다
  test/*.mjs             파이썬 대조, 심플렉스 검증, legalize 성질 검사
  test/place.mjs           앞단 출력만으로 배치 (본 경로)
  fixtures/*.json        파이썬이 뽑아둔 정답 고정값 (parity 검사용)
  fixtures/design/       예제 5 개의 앞단 출력 (1_topology + 2_primitives)
                         *.gds.json 은 뺐다 — 배치기가 안 읽고 15MB 였다
  index.html             브라우저 데모 (아직 고정값을 읽는다)
  README.md              JS 쪽 상세
NOTES-phase0.md          "전부 웹으로" 타당성 조사 결과 (Pyodide/emscripten/메모리)
```

---

## 파이썬 배치기

```bash
source env.sh
python -m gpuplace.m2 telescopic_ota --batch 1024 --iters 1200 --n-legal 16 --emit
```

`--emit` 을 주면 결과를 `$ALIGN_WORK/<예제>_ours` 에 ALIGN 배선기가 읽는
형식으로 쓴다. PDK 금속 피치(M1 세로 80, M2 가로 84)에 맞춰 격자 정렬까지 한다.

**격자 정렬을 MILP 안에 제약으로 넣은 이유**: 풀고 나서 반올림하면 대칭이 깨지고,
없앴던 겹침이 되살아난다. 두 번 데어서 안다.

### 측정 결과 (ALIGN 대비, 예제 5 개)

| 지표 | 결과 |
|---|---|
| 면적 | 4 개에서 **1.00×**, cascode_current_mirror_ota 에서 **0.78×** |
| HPWL | 0.99 ~ 1.02× |
| 겹침 | **0** (정확히) |
| 대칭 잔차 \|Az−b\| | ~1e-12 |
| 배선 | 5/5 GDS 생성 |
| DRC | ALIGN 과 같거나 더 적음 |

cascode 는 ALIGN 의 배치기가 500 초 안에 못 끝낸 예제다.

**DRC 를 읽을 때 주의.** `DIFFERENT WIDTH` 4 건이 current_mirror_ota 에서 나오는데,
ALIGN 자신의 출력에도 똑같이 4 건이 있다. 우리 탓이 아니다. 비교하려면
기준선도 같이 재라 — 한 번 오독해서 시간을 버렸다.

---

## 브라우저 배치기

같은 알고리즘을 의존성 없는 ES 모듈로 옮긴 것. 빌드 단계가 없어서
node 와 브라우저에서 같은 파일이 그대로 돈다.

```bash
cd web/placer
node test/place.mjs      # 앞단 출력만으로 배치 (ALIGN 배치기 없이) — 이게 본 경로다
node test/design.mjs     # 같은 변이를 주면 ALIGN 과 같은 문제가 나오는가
node test/lp.mjs         # 심플렉스 검증
node test/parity.mjs     # 파이썬과 값 대조
node test/chunk.mjs      # 끊어 돌린 Adam == 한 번에 돌린 Adam
node test/legalize.mjs   # 겹침 0 / 대칭 잔차 / 면적·배선
node test/bench.mjs telescopic_ota 32 600
```

### 변이 선택 — JS 쪽이 파이썬과 갈라지는 지점

`2_primitives` 는 같은 소자를 여러 종횡비로 만들어 둔다 (`X1_Y2` 는 800x3528,
`X2_Y1` 은 1120x2352 — 트랜지스터도 파라미터도 같고 **모양만** 다르다).
어느 쪽을 쓰느냐는 연속 최적화로는 못 정하는 **이산 선택**이고 배치를 크게 바꾼다.
ALIGN 은 수열쌍 담금질 안에서 좌표와 같이 골랐다.

JS 배치기는 이걸 **다중 시작의 한 축**으로 넣어 직접 고른다. 조합이 작아서 된다 —
블록 11 개짜리도 조합은 8 개다 (대부분의 인스턴스는 변이가 하나뿐). 거울 반전과
영역 종횡비도 같은 식으로 고른다. 그래서 ALIGN 의 place 단계가 필요 없다.

```js
import { placeHierarchy } from "./src/place.mjs";
const r = placeHierarchy({ topology, primitives, templates });
r.top.concrete   // 우리가 고른 변이
r.top.sx, r.top.sy  // 우리가 고른 거울 반전
```

| 예제 | 면적 | HPWL | 겹침 |
|---|---|---|---|
| telescopic_ota | **1.00×** | 0.99× | 0 |
| current_mirror_ota | **1.00×** | **1.00×** | 0 |
| five_transistor_ota | **0.86×** | 1.40× | 0 |
| high_speed_comparator | 1.05× | 1.33× | 0 |
| cascode_current_mirror_ota | 1.11× | 1.30× | 0 |

**아직 ALIGN 에 못 미친다.** 앞의 둘은 bbox 까지 같지만 뒤의 둘은 양쪽 다 진다.
그리고 **DRC 는 한 번도 못 봤다** — 격자 스냅과 handoff 가 없어 배선기로 못 넘긴다.

앞의 둘은 bbox 까지 ALIGN 과 정확히 같다 (1440×11760, 8800×2352).

**고를 값어치가 있는 선택인가?** five_transistor_ota 의 60 개 배정을 전부
legalize 까지 돌려 재봤다. 최악의 배정은 **면적 2.7배, 배선 5.5배**다 —
같은 트랜지스터·같은 파라미터·같은 배치기인데 소자 모양만 다르다.
telescopic_ota 와 current_mirror_ota 에서는 ALIGN 이 고른 것이 **1 위**였고
우리도 그걸 골랐다 (`node test/variants.mjs`).

계층 설계(hsc, cascode)는 `batch` 를 288 로 올리면 눈에 띄게 좋아진다
(hsc 면적 1.05x -> 0.97x, 시간 90s -> 228s). 평면 설계는 기본값에서 이미 수렴해 있다.

자세한 것은 `web/placer/README.md`.

데모를 열려면 HTTP 로 띄워야 한다 (ES 모듈과 fetch 는 `file://` 에서 안 된다):

```bash
cd web/placer && python3 -m http.server 8766
# http://127.0.0.1:8766/index.html
```

### 무엇을 어떻게 검증했나

**값 대조** — 파이썬의 `z0`/`N`/`λ`/`μ` 를 그대로 넘겨 같은 매개화 위에서 비교한다.
예제 4 개 × 각 3 케이스, 전 항목 **기계 정밀도(~1e-16)**: 중심, 배선 W, 밀도 D,
경계 B, 에너지 E, 기울기, 면적, box, overflow.

**성질 검사** — 영공간 기저는 유일하지 않다 (같은 부분공간의 아무 정규직교 기저나
된다). 그래서 JS 가 스스로 만든 `N` 은 값이 아니라 성질로 본다:
`A(z₀+Nθ)=b` (임의 θ), `NᵀN=I`, `dim = n−rank`. `A`, `b` 자체는 생성 알고리즘이
같으므로 원소까지 대조한다.

**legalization 은 LP 로 줄였다.** 파이썬은 쌍마다 "왼/오/아래/위" 를 고르는
이진변수를 두어 MILP 로 푼다 (11 블록이면 220 개). 연속해가 이미 방향을
정해놓았으므로 그것을 고정하면 이진변수가 사라지고 LP 만 남는다.
심플렉스 하나(`src/lp.mjs`, 170 줄)면 되고, 브라우저에 solver wasm 을 싣지 않아도 된다.

그 심플렉스는 따로 검증했다: 답을 아는 문제 6 개(최대화/1단계/실행불가능/무한/
퇴화/자유변수 분할) + 무작위 LP 60 건을 꼭짓점 전수 열거와 대조해 최대 상대차 **6e-16**.

**함정 하나.** 방향을 "침범량이 가장 작은 쪽" 으로 고르면 12 건 중 7 건이
INFEASIBLE 이 됐다. slack 을 1.6 → 4.0 으로 늘려도 똑같이 7 건 — 공간 문제가
아니었다. 대칭 쌍은 축에 대한 거울이라 세로 대칭이면 `cy` 가 **항상 정확히 같다**.
그런 쌍에 "위/아래" 분리를 걸면 어떤 θ 로도 만족할 수 없다. 계수행
`N[2i]−N[2j]` 가 0 이면 그 차이가 상수라는 점을 써서 실현 불가능한 방향을
미리 빼니 12/12 가 풀렸다.

### 브라우저 측정치 (legalize 후)

| 예제 | 겹침 | 대칭 잔차 | 면적 | HPWL |
|---|---|---|---|---|
| telescopic_ota | 0 | 3.4e-12 | 1.00× | 1.00× |
| five_transistor_ota | 0 | 1.4e-12 | 1.00× | 0.99× |
| high_speed_comparator | 0 | 7.3e-12 | 1.00× | 1.00× |
| cascode_current_mirror_ota | 0 | 4.1e-12 | 0.95× | 1.02× |

처리량 2.4 ~ 9.7k 평가/초 (단일 스레드). 24 시작점 × 600 반복이 2~8 초.

### 고정값 다시 뽑기

`fixtures/*.json` 은 파이썬 구현에서 뽑은 정답이다. 다른 예제를 넣거나
파이썬 쪽을 고쳤으면 다시 뽑는다.

```bash
source env.sh
./scripts/verify.sh <예제>          # 먼저 <예제>_ours 가 있어야 한다
python web/placer/export-fixtures.py <예제>
```

---

## ALIGN 메모리 패치

배선 단계의 peak RSS 가 인스턴스 11 개짜리 회로에서 **8,396 MB** 였다.
계측해보니 **C++ 라우터 자체는 72 MB** 고, 나머지는 배선 단계가 배치 기계를
다시 돌리는 비용이었다. 그중 두 덩어리(`process_placements` 3.7 GB,
`update_grid_constraints` 3.2 GB)는 만들자마자 버려진다.

```
telescopic_ota            2,712 →   776 MB   (-71%)
high_speed_comparator     4,689 →   833 MB   (-82%)
cascode_current_mirror    8,396 → 1,454 MB   (-83%)
```

GDS 를 바이트로 비교해 레이아웃이 같음을 확인했다 (다른 70 바이트는 전부
타임스탬프와 자동생성 셀 이름 카운터, 기하 레코드는 완전 동일).

자세한 근거와 손으로 적용하는 법은 `patches/README.md`.
직접 재보려면 `./scripts/measure-memory.sh`.

---

## 안 된 것 / 주의

- **넷리스트에서 시작하는 것은 `web/placer` (JS) 쪽만 된다.**
  JS 배치기는 `1_topology` + `2_primitives` 만 읽고 변이·반전·영역을 직접 고른다
  (`src/design.mjs`, `src/place.mjs`). ALIGN 의 place 단계가 필요 없다.

  **`gpuplace` (파이썬) 는 아직 아니다.** 여전히 ALIGN 의 place 출력
  (`3_pnr/Results/*.scaled_placement_verilog.json`)을 읽어 **좌표만** 덮어쓴다.
  그래서 `verify.sh` 는 place 단계를 건너뛰지 않는다.

  파이썬 경로에서 탐색이 필요 없다고 `--placer_sa_iterations` 를 낮추면 안 된다.
  그 단계가 고르는 것이 좌표만이 아니라 **primitive 변이**이기도 하다.
  SA=10 으로 재보니 크기가 다른 변이(폭 420 vs 588)를 골라 `DIFFERENT WIDTH`
  DRC 가 2 건 났다.

  | SA | 면적 | HPWL | bbox | DRC |
  |---|---|---|---|---|
  | 10000 (기본) | 1.00× | 0.99× | 1440×11760 | **0** |
  | 10 | 1.00× | 0.61× | 1840×11760 | **2** |

  SA=10 의 HPWL 0.61× 는 우리가 잘해서가 아니라 **기준선이 나빠진** 것이다.
  ALIGN 단독은 SA=10 에서도 DRC 0 이라, 우리 배치와 겹쳐야 드러난다.
  `verify.sh` 는 기본값을 쓴다. 이 함정은 실제로 한 번 밟았다.
- **`Order` / `Spread` / `Boundary` 제약이 코드에 없다.**
  `SymmetricBlocks` 와 `Align` 만 처리한다. `AspectRatio` 는 JS 쪽에서 영역
  종횡비 범위로만 쓴다 (블록 배치 제약으로는 안 쓴다). 나머지는 수식은
  정리해뒀지만 미구현.
- **배선·GDS·DRC 를 네이티브 ALIGN 으로 닫았다 (5/5).**
  격자 스냅(legalize 안의 정수 제약) → handoff(`__placer_dump__.json` 에 심기)
  → 배선 → GDS → DRC 까지 간다.

  | 예제 | GDS | DRC 우리 | DRC ALIGN 자신 |
  |---|---|---|---|
  | telescopic_ota | 80K | **0** | 0 |
  | current_mirror_ota | 80K | 4 | **4 (동일)** |
  | five_transistor_ota | 96K | **0** | 0 |
  | high_speed_comparator | 172K | **0** | 0 |
  | cascode_current_mirror_ota | 204K | **4** | 6 (우리가 적다) |

  `current_mirror_ota` 의 4 건은 `DIFFERENT WIDTH` 인데 ALIGN 자신의 배치에서도
  똑같이 4 건 나온다. SHORT·OPEN 은 양쪽 다 0.

  ```bash
  cd web/placer && node emit.mjs telescopic_ota          # 배치 -> place.json
  bash web/spikes/route-js.sh telescopic_ota             # 심고 배선 -> GDS -> DRC
  bash web/spikes/drc-sum.sh                             # 기준선과 나란히
  ```

- **브라우저에서도 배선이 돈다 — 평면 설계 3/5.**
  회로(`.sp`)를 올리면 앞단 · 배치 · 배선 · GDS · DRC 가 전부 탭 안에서 돈다.
  네이티브 ALIGN 도, 서버도 필요 없다.

  | 예제 | 앞단 | 배치 | 배선 | GDS | DRC 브라우저 | DRC 네이티브 |
  |---|---|---|---|---|---|---|
  | telescopic_ota | 0.7 s | 9.4 s | 1.7 s | 78K | **0** | 0 |
  | current_mirror_ota | ~1 s | 8.4 s | 1.7 s | 79K | 4 | 4 |
  | five_transistor_ota | ~1 s | 23.0 s | 1.9 s | 92K | **0** | 0 |
  | high_speed_comparator | ~9 s | 107 s | 멈춤 | — | — | 0 |
  | cascode_current_mirror_ota | ~3 s | 39.6 s | 멈춤 | — | — | 4 |

  DRC 건수가 네이티브와 같다 — 같은 배선기, 같은 배치, 같은 결과다.

  브라우저 배선을 여는 데 걸린 것 두 가지가 기록해둘 만하다.

  1. `memory access out of bounds`. 덤프의 최상위 `parameters` 에 전원/접지
     포트를 남겨뒀더니 C++ 배치기가 넷 없는 단자로 읽고
     (`terminal 8 is dangling`) `SeqPair` 색인을 벗어났다. 네이티브에서는
     조용히 넘어가지만 wasm 은 즉사한다. 덤프를 `1_topology` 가 아니라
     **`3_pnr/inputs/<TOP>.verilog.json`** 에서 만들어 고쳤다 — prep 이
     `manipulate_hierarchy` 로 전원핀을 걷어내 써둔, 배선 단계가 기대하는 그것.
  2. 두 번째 배선에서 `null function`. 앞 회차가 남긴 `3_pnr` 위에 또
     돌렸기 때문이다. 이제 매번 prep 부터 다시 돌린다 (1 초 미만).

- **계층 설계 배선은 브라우저에서 아직 못 닫았다.**
  인수인계는 계층까지 맞춰 만들어 두었고 **첫 하위 모듈은 성공한다**.
  두 번째 하위 모듈의 상세 배선에서 빈 함수 포인터를 부른다
  (`null function`). 축소 wasm 빌드(`scripts/wasm/build-pnr-wasm.sh`)가
  빠뜨린 간접 호출 대상으로 보인다 — `-sASSERTIONS=2` 디버그 빌드로 어느
  슬롯인지 짚는 것이 다음 순서다. 그때까지 이 두 예제는 네이티브 경로로 낸
  GDS·DRC 를 내려받게 둔다.
- **정적 사이트**: `web/placer/site/` 를 GitHub Pages 등에 그대로 올리면
  브라우저에서 앞단·배치·배선이 돌고, 배선도·레이어 토글·산출물 다운로드·
  회로 업로드가 된다. `site/README.md` 에 올리는 법이 있다.
- **GPU 를 안 쓴다.** batch 축이 컴퓨트 셰이더에 그대로 맞는 자리지만 안 했다.
  torch 설치가 이 환경에서 두 번 잘려서 numpy 해석적 미분으로 갔다.

### WSL 을 쓴다면

- `.wslconfig` 로 메모리를 제한해라. 안 하면 WSL2 가 호스트 RAM 의 50% 까지
  늘어나고, 호스트가 빠듯할 때 **VM 이 통째로 재시작한다**. 배치가 멈춘 줄 알고
  한참 헤맸다.
  ```ini
  [wsl2]
  memory=12GB
  swap=16GB
  processors=4
  ```
- 작업 디렉터리를 `/mnt/c` 아래에 두지 마라. drvfs I/O 가 느리고 무거운 예제에서
  불안정하다. `env.sh` 는 기본을 `~/align-work` 로 잡는다.
