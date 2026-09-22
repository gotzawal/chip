# Symmetry Placer — 정적 사이트

아날로그 IC 배치를 **브라우저에서** 푼다. 서버도 빌드도 없다 — 이 폴더를
정적 호스팅에 그대로 올리면 된다. 회로 넷리스트(`.sp`)를 올리면 앞단 ·
배치 · 배선 · GDS · DRC 까지 브라우저 안에서 돌고, 산출물을 바로 받는다.

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

```bash
python3 -m http.server 8791
# http://127.0.0.1:8791
```

## 구성

```
index.html        페이지
worker.mjs        배치는 워커에서 돈다 (예제 하나가 8~107 초라 메인 스레드면 언다)
frontworker.mjs   앞단과 배선 — Pyodide 안에서 ALIGN 을 그대로 돌린다
view.mjs          캔버스 — 확대/이동, 패널, 배선 레이어
src/*.mjs         배치기 본체 (의존성 없는 ES 모듈)
data/*.json       예제 5 개의 ALIGN 앞단 출력 (미리 만들어둬 첫 화면이 빠르다)
netlists/*.sp     예제 5 개의 원본 회로 — 배선 버튼이 이걸로 앞단을 다시 돌린다
routed/*.json     네이티브 ALIGN 이 낸 배선 기하 (비교용 기준선)
downloads/        네이티브 경로 산출물 — GDS, 배치 JSON, 배선 기하, DRC 원문
py/               Pyodide 스택 (25 MB, 첫 방문에만 받는다)
```

## 쓰는 법

1. **예제를 고르거나** `.sp` 넷리스트를 올린다.
2. **배치 실행** — 변이·반전·영역·격자를 JS 배치기가 직접 고른다.
3. **배선 실행** — 브라우저가 ALIGN 배선기(wasm)를 돌려 GDS 와 DRC 를 낸다.
   결과는 `배선` 보기에 그려지고, 아래 내려받기 칸이 그 자리에서 채워진다.

배선 버튼은 그 설계의 앞단 결과가 워커 안에 있어야 돈다. 예제를 골랐다면
버튼이 알아서 `netlists/<예제>.sp` 로 앞단을 한 번 돌린 뒤 배선한다.

## 회로 올리기

`.sp` (또는 `.cir`) 파일 하나면 된다. 제약을 같이 주려면
`<이름>.const.json` 을 함께 올린다.

```
.sp 넷리스트
  -> 앞단  1_topology + 2_primitives   Pyodide 에서 0.7 ~ 9 s
  -> 배치  변이·반전·영역·격자          JS 에서 7 ~ 107 s
  -> 배선  전역·상세·전원              wasm 에서 1.5 ~ 2 s
  -> GDS + DRC/LVS
```

ALIGN 앞단 출력을 직접 올려도 된다 (그때는 배치까지만 된다).

```
1_topology/<top>.verilog.json      인스턴스 -> abstract 템플릿, fa_map, 제약
2_primitives/__primitives__.json   concrete -> abstract, x_cells, y_cells
2_primitives/<concrete>.json       bbox, terminals
```

`{topology, primitives, templates}` 로 묶은 JSON 한 파일도 받는다
(`data/*.json` 이 그 형식이다).

## 브라우저 배선 — 실측

배치는 5/5 다 돈다. 배선은 **평면 설계 3/5** 가 브라우저에서 끝까지 간다.

| 예제 | 배치 | 배선 | GDS | DRC/LVS | 네이티브 DRC |
|---|---|---|---|---|---|
| telescopic_ota | 9.4 s | 1.7 s | 78K | **0** | 0 |
| current_mirror_ota | 8.4 s | 1.7 s | 79K | 4 | 4 (ALIGN 도 4) |
| five_transistor_ota | 23.0 s | 1.9 s | 92K | **0** | 0 |
| high_speed_comparator | 107 s | — | — | — | 0 |
| cascode_current_mirror_ota | 39.6 s | — | — | — | 4 (ALIGN 은 6) |

DRC 건수가 네이티브와 같다 — 같은 배선기, 같은 배치, 같은 결과다.

### 계층 설계에서 막히는 지점

`high_speed_comparator` 와 `cascode_current_mirror_ota` 는 하위 모듈이 있다.
인수인계(`__placer_dump__.json`)는 계층까지 맞춰 만들어 두었고, 배선기도
**첫 하위 모듈은 성공한다**:

```
bottom up routing for PRIMITIVE_38447703_PG0 (1)   GcellGlobalRouter → GcellDetailRouter  OK
bottom up routing for PRIMITIVE_98739713_PG0 (2)   GcellGlobalRouter → RuntimeError: null function
```

두 번째 하위 모듈의 상세 배선에서 빈 함수 포인터를 부른다. 축소 wasm 빌드
(`web/spikes/build-pnr-wasm.sh`)가 빠뜨린 간접 호출 대상으로 보인다 —
`-sASSERTIONS=2` 디버그 빌드로 어느 슬롯인지 짚는 것이 다음 순서다.
그때까지 이 두 예제의 GDS·DRC 는 네이티브 경로로 만든 것을 내려받게 둔다.

### 여기까지 오면서 뚫은 것

1. `FileNotFoundError: __cap_map__.json` — `3_pnr:prep` 을 안 돌렸다. 붙였다.
2. `PnR.PnRdatabase 는 아직 브라우저에 없다` — 앞단용 스텁이
   `align/align/PnR.py` 에 있어 휠로 설치한 진짜 확장을 가렸다
   (`build_pnr_model.py` 가 `from .. import PnR` 로 상대 임포트한다).
   별칭으로 바꾸니 `PnR.cpython-312-wasm32-emscripten.so` 가 잡힌다.
3. `AttributeError: Placer_Router_Cap_Ifc` — 축소 바인딩에서 뺀 것이다
   (배선에 안 쓰여서). 커패시터 없는 설계는 건너뛰게 했다.
4. `memory access out of bounds` — 덤프의 최상위 `parameters` 에 전원/접지
   포트가 남아 있었다. C++ 배치기가 넷 없는 단자로 읽고
   (`terminal 8 is dangling`) `SeqPair` 색인을 벗어났다. 네이티브에서는
   조용히 넘어가지만 wasm 은 즉사한다. 이제 덤프를 `1_topology` 가 아니라
   **`3_pnr/inputs/<TOP>.verilog.json`** 에서 만든다 — prep 이
   `manipulate_hierarchy` 로 전원핀을 걷어내 써둔, 배선 단계가 기대하는 그것이다.
5. 두 번째 배선에서 `null function` — 이전 회차가 남긴 `3_pnr` 위에 또
   돌렸기 때문이다. 이제 매번 prep 부터 다시 돌린다 (1 초 미만).

메모리는 문제가 아니었다 — 계측상 C++ 배선기 본체는 72 MB 고, 8.4 GB 는
배선 단계가 배치를 다시 돌리던 비용인데 이 경로엔 그게 없다.
