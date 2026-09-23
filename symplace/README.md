# symplace — 배치기·배선기의 소스와 검사

[ALIGN](https://github.com/ALIGN-analoglayout/ALIGN-public) 의 배치 단계를 **연속 최적화**로 대체한
배치기와, ALIGN 의 배선 단계를 그대로 옮긴 배선기(Rust -> wasm)의 소스·검사·도구가 여기 있다.
사이트(페이지)는 저장소 루트에 있고 (`/index.html`, `/src/*.mjs`, `/data`, `/netlists`, `/py`),
이 폴더는 그 코드를 검사하고 예제를 만드는 쪽이다. 올리는 법과 쓰는 법, 측정치는 루트의
[README.md](../README.md), 앞으로의 재구성·예제 추가 계획은 [PLAN.md](../PLAN.md).

## 이 저장소에서의 자리

- 배치기 본체는 저장소 루트의 `/src/*.mjs` **하나뿐**이다 (사이트가 읽는 바로 그 파일). 여기 사본을
  두지 않는다 — 두면 갈라진다. `web/placer/test/*` 와 `web/placer/pack-example.mjs` 가 루트 쪽을 임포트한다.
- 검사가 읽는 예제도 사이트가 읽는 `/data/<예제>.json` 그대로다. 예제를 더 넣으면 검사가 그것을 그대로 본다.
- 배선기의 Rust 소스는 `alignroute/`, 빌드 결과는 루트의 `/src/route/alignroute.wasm` 이다.
- 회로도·묶음 보기는 루트의 `/src/schematic/` 이다 — SPICE 읽기, .sp 와 앞단 출력에서 회로 만들기, 자동 배열,
  캔버스 그리기. 워커도 배치도 거치지 않고 앞단 출력(과 `/netlists/<예제>.sp`)만 읽는다.

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
  pack-example.mjs       앞단 출력 폴더 -> data/<예제>.json, data/<예제>.leaves.json, data/index.json
  README.md              배치기 설계 노트 — 변이·반전·영역·계층을 어떻게 고르는지, legalize, 검증
scripts/
  build-z3-pyodide.sh    앞단이 쓰는 libz3 (/py/z3, Pyodide side module) 를 빌드한 방법
  route/node/place.mjs   페이지와 같은 배치를 node 에서 돌려 배선기에 넘기는 모양으로 저장
  route/node/newroute.mjs  페이지와 같은 길로 node 에서 배선 (`all` 이면 예제 전부; 배치 캐시가 없으면 그 자리에서 배치)
  place/prof.mjs         한 시작점의 시간이 항별로 어디에 쓰이는지
PLAN-route-align.md      배선기를 ALIGN 알고리즘 그대로 옮긴 계획과 결과 (대조 방법·수치, 기록)
PLAN-place-variants-gpu.md  변이 선택 분석과 WebGPU 계획·결과 (기록)
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
node symplace/web/placer/test/place.mjs [예제]   # 앞단 출력만으로 배치 — 본 경로. 겹침 0·대칭 잔차·Order·격자
node symplace/web/placer/test/variants.mjs   # 변이 배정 전수 — 배정이 결과를 가르는가
node symplace/web/placer/test/bench.mjs [예제] [batch] [iters]   # 처리량
# 배선
node symplace/web/placer/test/leaves.mjs     # data/<예제>.leaves.json 이 예제와 맞는가
node symplace/web/placer/test/check.mjs      # JS DRC/LVS 검사기 == 고정 사례 (106)
node symplace/web/placer/test/compose.mjs    # 격자 검사 문구 == 고정 사례 (150)
node symplace/web/placer/test/gds.mjs        # GDS 바이트 == 고정 사례 (2)
node symplace/scripts/route/node/newroute.mjs all   # 예제 전부를 배치하고 페이지와 같은 길로 배선해 DRC/LVS 를 찍는다
# 회로도 · 묶음 보기 (src/schematic/)
node symplace/web/placer/test/schematic.mjs [예제]   # 예제 전부의 .sp 와 앞단 출력을 배열 — 소자 수, 앞단 잎 <-> .sp 소자 맞춤,
                                                   # 기호 겹침 0, 핀마다 선이 닿는가, 거울 쌍 대칭, 묶음 테두리가 소자를 담는가
# 브라우저 — Playwright 전역 설치가 필요하다 (npm i -g playwright && npx playwright install chromium)
node symplace/web/placer/test/gpu.mjs        # GPU runner == CPU (headless Chromium, WebGPU)
node symplace/web/placer/test/page.mjs high_speed_comparator gpu 96 32   # 페이지 통째로 (워커 + WebGPU)
node symplace/web/placer/test/views.mjs [예제]   # 페이지의 회로도·묶음 보기 — 예제 전부에서 두 보기와 표, hover, 앞단 출력 올리기
                                                # (SHOT=폴더 를 주면 보기마다 PNG 를 남긴다)
```

`fixtures/<예제>.json` 은 배치 문제의 **정답 고정값**이다 — 이 배치기의 첫 구현(파이썬/numpy)이 뽑아 둔
z0/N/λ/μ 와 E·grad·면적. JS 이식이 그 값과 기계 정밀도(~1e-16)로 같음을 `parity.mjs` 가 본다. 파이썬 구현은
JS 가 그것을 넘어선 뒤 걷어냈다 (마지막으로 들어 있던 커밋 `0e04d6a`, `symplace/gpuplace/`). 고정값은
그대로 두고 새 예제에는 뽑지 않는다 — 새 예제는 `design.mjs` 와 `place.mjs` 가 앞단 출력만으로 본다.

## 안 된 것 / 주의

- **제약.** 배치기는 `SymmetricBlocks`, `Align`, `Order`(`abut` 제외), `AspectRatio`(영역 종횡비 범위로),
  `HorizontalDistance` / `VerticalDistance` / `BlockDistance`, `GroupBlocks`(앞단이 하위 모듈로 만들어 준다)를
  처리한다. `Spread` / `Boundary` / `SameTemplate` / `GroupCaps` / `GuardRing` 은 배치기에 없다 — 배선 입력에는
  그대로 넘기고, 페이지가 "배치기가 무시한 제약" 으로 보여준다 (`src/design.mjs` 의 제약 등록).
- **계층 설계의 결과는 아직 흔들린다** — 하위 모듈이 올리는 모양(기본 3 개)에 따라 상위의 bbox 가
  한 줄(2352)씩 달라진다 (high_speed_comparator).
- **WebGPU 는 SwiftShader 로만 쟀다.** 실제 GPU 에서의 시간은 아직 재지 못했다.
