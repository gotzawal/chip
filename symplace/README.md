# symplace — 배치기·배선기의 소스와 검사

[ALIGN](https://github.com/ALIGN-analoglayout/ALIGN-public) 의 배치 단계를 **연속 최적화**로 대체한
배치기와, ALIGN 의 배선 단계를 그대로 옮긴 배선기(Rust -> wasm)의 소스·검사·도구가 여기 있다.
사이트(페이지)는 저장소 루트에 있고 (`/index.html`, `/src/*.mjs`, `/data`, `/routed`, `/netlists`,
`/py`), 이 폴더는 그 코드를 검사하고 예제와 비교 기준선을 만드는 쪽이다. 올리는 법과 쓰는 법,
측정치는 루트의 [README.md](../README.md), 앞으로의 재구성·예제 추가 계획은 [PLAN.md](../PLAN.md).

## 이 저장소에서의 자리

- 배치기 본체는 저장소 루트의 `/src/*.mjs` **하나뿐**이다 (사이트가 읽는 바로 그 파일). 여기 사본을
  두지 않는다 — 두면 갈라진다. `web/placer/test/*` 와 `web/placer/pack-example.mjs` 가 루트 쪽을 임포트한다.
- 검사가 읽는 예제도 사이트가 읽는 `/data/<예제>.json` 그대로다. 예제를 더 넣으면 검사가 그것을 그대로 본다.
- 배선기의 Rust 소스는 `alignroute/`, 빌드 결과는 루트의 `/src/route/alignroute.wasm` 이다.

```bash
node symplace/web/placer/test/place.mjs      # 저장소 루트에서 돌린다
```

## 핵심 한 문단

ALIGN 의 배치기는 수열쌍(sequence pair)을 담금질로 훑는다. 후보가 (n!)² 이라
블록이 늘면 감당이 안 되고, 실행 시간의 **78%** 를 여기서 쓴다.

대신 대칭·정렬 같은 등식 제약을 벌점이 아니라 **좌표계**로 흡수한다.
제약을 `A z = b` 로 모으고 영공간 매개화 `z = z₀ + Nθ` 를 만들면, **어떤 θ 를
넣어도 제약이 정의상 정확히 만족된다.** 자유도도 줄어든다 (telescopic_ota: 11 → 7).

그 θ 공간 위에서 미분 가능한 에너지를 내린다.

```
E = W + λ·D + μ·B
    W  넷을 따라 당기는 스프링      (매끄럽게 편 HPWL, 핀은 점이 아니라 경계 사각형)
    D  같은 부호 전하들의 반발      (젤리움 = 전하 + 균일 중화 배경, DCT 로 푸는 포아송 — 랭크 N 항등식으로 줄였다)
    B  영역 밖으로 나간 만큼의 벌점
```

λ 를 50 스텝마다 키운다. 처음에는 블록이 서로 뚫고 지나가는 무른 유체로 두었다가
서서히 굳혀 겹침을 없앤다 — 담금질에서 온도를 내리는 일과 같다.

연속 완화는 겹침을 *거의* 없앨 뿐 정확히 0 으로 만들지 못한다. 마무리는 이산으로
하되, **여전히 θ 공간에서** 한다. x 공간에서 블록을 밀면 대칭이 깨지지만
θ 공간에서는 어떻게 움직여도 `z = z₀ + Nθ` 가 제약을 지킨다.

소자 변이(같은 소자의 다른 종횡비)·거울 반전·영역 종횡비는 연속 최적화로 못 정하는
이산 선택이라 다중 시작의 한 축으로 넣어 고른다. 어떻게 고르는지, 어디서 틀렸었는지는
[web/placer/README.md](web/placer/README.md).

---

## 구성

```
alignroute/              Rust 배선기 — ALIGN 배선기(RouteWork 4·5·2·3)를 그대로 옮긴 것.
                         build.sh 가 wasm32-wasip1 로 빌드해 /src/route/alignroute.wasm 에 둔다.
                         lp_solve 5.5 의 C 소스는 fetch-lpsolve.sh 가 받아 build.rs 가 같이 빌드한다 (저장소에 없다).
                         crate 의존은 serde·serde_json 뿐이다
web/placer/
  test/                  검사 (아래). 루트의 src/ 와 data/ 를 읽는다
  fixtures/              고정값 — 배치 문제의 정답(4 예제), 검사기 사례 106, 격자 문구 150, GDS 2
  pack-example.mjs       ALIGN 작업 디렉터리(또는 앞단 출력 폴더) -> data/<예제>.json, data/<예제>.leaves.json,
                         routed/<예제>.align.json, 두 index.json
  README.md              배치기 설계 노트 — 변이·반전·영역·계층을 어떻게 고르는지, legalize, 검증
scripts/
  align-baseline.sh      네이티브 ALIGN 으로 예제 하나를 끝까지 돌려 비교 기준선(배치·배선·DRC)을 저장소에 담는다
  measure-memory.sh      ALIGN 메모리 패치의 효과를 직접 재본다
  build-z3-pyodide.sh    앞단이 쓰는 libz3 (/py/z3, Pyodide side module) 를 빌드한 방법
  route/node/place.mjs   페이지와 같은 배치를 node 에서 돌려 배선기에 넘기는 모양으로 저장
  route/node/newroute.mjs  페이지와 같은 길로 node 에서 배선 (`all` 이면 예제 전부)
  place/                 변이 선택 분석 스크립트 — PLAN-place-variants-gpu.md 의 표를 낸다
setup.sh, env.sh         네이티브 ALIGN 설치·환경 — 기준선을 만들 때만 필요하다
patches/                 ALIGN 배선 단계 메모리 8.4GB -> 1.45GB 패치 (setup.sh 가 적용한다)
PLAN-route-align.md      배선기를 ALIGN 알고리즘 그대로 옮긴 계획과 결과 (대조 방법·수치)
PLAN-place-variants-gpu.md  변이 선택이 ALIGN 과 갈리던 이유(실측)와 WebGPU 계획·결과
```

## 검사

전부 node 22 로, 저장소 루트에서 돈다. 빠른 것들은 합쳐서 1 분 안쪽이고, 배치 검사(place.mjs)는
5 예제에 1~2 분이다.

```bash
# 배치기
node symplace/web/placer/test/lp.mjs         # 심플렉스 — 답을 아는 문제 6 + 무작위 60 건을 꼭짓점 전수 열거와 대조
node symplace/web/placer/test/parity.mjs     # 에너지·기울기·영공간 — 고정값(fixtures/<예제>.json)과 기계 정밀도로 대조
node symplace/web/placer/test/design.mjs     # 앞단 출력에서 만든 문제 == 고정값의 문제 (같은 변이를 주면)
node symplace/web/placer/test/chunk.mjs      # 끊어 돌린 Adam == 한 번에 돌린 Adam
node symplace/web/placer/test/legalize.mjs   # 겹침 0 / 대칭 잔차 / 면적·배선 (고정값 위에서)
node symplace/web/placer/test/place.mjs [예제]   # 앞단 출력만으로 배치 — 본 경로. ALIGN 과 변이·반전·면적·HPWL 대조
node symplace/web/placer/test/variants.mjs   # 변이 배정 전수 — 배정이 결과를 가르는가, ALIGN 배정의 순위
node symplace/web/placer/test/bench.mjs [예제] [batch] [iters]   # 처리량
# 배선
node symplace/web/placer/test/leaves.mjs     # data/<예제>.leaves.json 이 예제와 맞는가
node symplace/web/placer/test/check.mjs      # JS DRC/LVS 검사기 == ALIGN 파이썬 검사기 (106 사례)
node symplace/web/placer/test/compose.mjs    # 격자 검사 문구 == gen_viewer_json (150)
node symplace/web/placer/test/gds.mjs        # GDS 바이트 == ALIGN 파이썬 (2)
node symplace/scripts/route/node/newroute.mjs all   # 예제 전부를 페이지와 같은 길로 배선해 DRC/LVS 를 찍는다
# 브라우저 — Playwright 전역 설치가 필요하다 (npm i -g playwright && npx playwright install chromium)
node symplace/web/placer/test/gpu.mjs        # GPU runner == CPU (headless Chromium, WebGPU)
node symplace/web/placer/test/page.mjs high_speed_comparator gpu 96 32   # 페이지 통째로 (워커 + WebGPU)
```

`fixtures/<예제>.json` 은 배치 문제의 **정답 고정값**이다 — 이 배치기의 첫 구현(파이썬/numpy)이 뽑아 둔
z0/N/λ/μ 와 E·grad·면적. JS 이식이 그 값과 기계 정밀도(~1e-16)로 같음을 `parity.mjs` 가 본다. 파이썬 구현은
JS 가 그것을 넘어선 뒤 걷어냈다 (마지막으로 들어 있던 커밋 `0e04d6a`, `symplace/gpuplace/`). 고정값은
그대로 두고 새 예제에는 뽑지 않는다 — 새 예제는 `design.mjs` 와 `place.mjs` 가 앞단 출력만으로 본다.

## 네이티브 ALIGN — 기준선을 만들 때만

페이지는 ALIGN 없이 돈다. 네이티브 ALIGN 은 **예제의 비교 기준선**(ALIGN 자신의 배치·배선·DRC)을
만들 때만 쓴다. 기준선이 없어도 예제는 돌아간다 — 페이지의 왼쪽 패널만 빈다.

필요한 것: Ubuntu 24.04 (WSL2 포함), Python 3.10+, git, node.
`python3-dev` 가 없으면 gdspy 휠 빌드가 `Python.h: No such file` 로 깨진다.

```bash
sudo apt install -y python3-dev python3-venv build-essential git
./symplace/setup.sh                 # venv, align-analoglayout 0.9.8, ALIGN-public @ 8d3cc2e, 메모리 패치
source symplace/env.sh
./symplace/scripts/align-baseline.sh telescopic_ota --label "Telescopic OTA"
```

`align-baseline.sh` 가 하는 일: `schematic2layout.py` 로 앞단 → 배치 → 배선까지 돌리고 (예제 하나에
2~5 분), `pack-example.mjs` 로 `data/<예제>.json`·`data/<예제>.leaves.json`·`routed/<예제>.align.json`
과 두 index 를 쓰고, 넷리스트를 `netlists/` 에 복사한다. 끝나면 이렇게 확인한다.

```bash
node symplace/web/placer/test/leaves.mjs
node symplace/web/placer/test/place.mjs <예제>
node symplace/scripts/route/node/newroute.mjs <예제>
```

ALIGN 의 배치 담금질 반복(`SA`, 기본 10000)을 줄이면 빨라지지만 다른 변이를 골라 **기준선이 나빠진다.**
telescopic_ota 를 SA=10 으로 돌리면 HPWL 이 0.61x 로 좋아 보이지만 기준선 쪽이 나빠진 것이고 DRC 도
2 건 난다. 기본값을 써라.

### ALIGN 메모리 패치

ALIGN 배선 단계의 peak RSS 가 인스턴스 11 개짜리 회로에서 **8,396 MB** 였다. 계측해보니 **C++ 라우터
자체는 72 MB** 고, 나머지는 배선 단계가 배치 기계를 다시 돌리는 비용이었다. 그중 두 덩어리
(`process_placements` 3.7 GB, `update_grid_constraints` 3.2 GB)는 만들자마자 버려진다.

```
telescopic_ota            2,712 →   776 MB   (-71%)
high_speed_comparator     4,689 →   833 MB   (-82%)
cascode_current_mirror    8,396 → 1,454 MB   (-83%)
```

GDS 를 바이트로 비교해 레이아웃이 같음을 확인했다. 근거와 손으로 적용하는 법은 `patches/README.md`,
직접 재보려면 `./scripts/measure-memory.sh` (먼저 `align-baseline.sh` 로 그 예제의 ALIGN 출력이 있어야 한다).

---

## 안 된 것 / 주의

- **제약.** 배치기는 `SymmetricBlocks`, `Align`, `Order`(`abut` 제외), `AspectRatio`(영역 종횡비 범위로),
  `GroupBlocks`(앞단이 하위 모듈로 만들어 준다)를 처리한다. `Spread` / `Boundary` / `SameTemplate` /
  `CompactPlacement` 는 배치기에 없다 — 배선 입력에는 그대로 넘긴다 (`src/route/align/prep.mjs`).
- **계층 설계의 결과는 아직 흔들린다** — high_speed_comparator 가 면적 1.111x 다. 하위 모듈이 올리는
  모양(기본 3 개)이 원인이고, 루트 README 의 "남은 것" 절에 실측이 있다.
- **WebGPU 는 SwiftShader 로만 쟀다.** 실제 GPU 에서의 시간은 아직 재지 못했다.
- **ALIGN 자신이 죽는 입력이 있다** (PLAN-route-align.md 부록 C). 거기서는 견줄 기준이 없다.

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
