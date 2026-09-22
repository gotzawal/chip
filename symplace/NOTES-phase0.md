# Phase 0 — 타당성 스파이크 결과 (2026-09-21)

| 스파이크 | 결과 | 요지 |
|---|---|---|
| S1 Pyodide 휠 | **통과(조건부)** | 필수 5개 전부 설치·import. z3 는 불가 |
| S2 PnRDB → wasm | **통과** | 7/7 컴파일, 오브젝트 3.2 MB |
| S3 lp_solve → wasm | **통과** | 27/27 컴파일 |
| S4 메모리 천장 | **실패** | route peak RSS 최대 8,396 MB > wasm32 4 GB |
| S5 인터페이스 | **결정** | pybind11 아님. C ABI `route(json)→json` |

## S1 — Pyodide 0.28.3 (부팅 1.2s, 전체 5.3s)
내장: numpy 2.2.5 / networkx 3.4.2 / pandas 2.3.1
micropip 설치+import 성공:
  pydantic==1.10.13 (0.2s), flatdict, colorlog, more-itertools, python-gdsii
micropip 실패 (C 확장, wasm 휠 없음): z3-solver, gdspy, highspy
  - gdspy  : gds2lefjson 전용 = 경로 밖. 무해
  - highspy: TS 쪽에서 highs-js(JS/WASM 빌드)를 쓰면 됨. 무해
  - z3     : **하드 블로커**
      align/schema/checker.py 첫 줄 `import z3`
      hacks.py, subcircuit.py 가 checker 를 import
      constraint.py:1519 ConstraintDB.append() 가 제약마다 verify() 호출 (끌 플래그 없음)
      => z3 없이는 `import align.schema` 자체가 실패

## S2 — emcc 6.0.9, PnRDB 7/7
첫 시도 3개 실패는 내가 고른 spdlog v1.14.1 탓(fmt formatter static_assert).
ALIGN 고정 버전(spdlog v1.9.2, nlohmann/json v3.7.3)으로 바꾸니 전부 통과.
=> 툴체인 문제 아님. 의존 버전만 맞추면 됨.

## S3 — lp_solve 5.5.2.11, 27/27
첫 시도 2개 실패는 include 경로 누락(bfp/bfp_LUSOL, .../LUSOL).
추가하니 전부 통과. 순수 C 라 이식성 문제 없음.

## S4 — 실패. 이게 계획을 막는다.
peak RSS (두 방법 일치: /usr/bin/time -v, /proc VmHWM)
  telescopic_ota              2,711 MB   12.0s
  high_speed_comparator       4,688 MB   20.0s
  cascode_current_mirror_ota  8,396 MB   25.0s   (bbox 6720x11760, 인스턴스 11)
wasm32 주소공간 한계 4 GB → 3개 중 2개가 초과.

원인 미확인. 내 최초 가설(라우팅 격자 폭발)은 **틀렸다**:
Grid.cpp:1068 이 수직 레이어의 교차축 간격을 이웃 피치의 gcd 로 잡아
일부 층이 8~47배 조밀해지는 건 사실이나(M11 32배, M13 47배),
cascode 규모 총 정점은 227,521개로 GB 급이 아니다.
=> 다음 할 일: heaptrack/massif 로 route 단계 실측 프로파일.

## S5 — C ABI 로 결정
Pyodide 0.28 lock: platform `emscripten_4_0_9`, abi `2025_0`, python 3.13.2
설치한 emcc 는 6.0.9. pybind11 확장을 Pyodide 에 붙이려면 emscripten 을
4.0.9 로 정확히 맞춰야 하고, Pyodide 가 올라갈 때마다 다시 깨진다.
독립 wasm 모듈 + `route(json)→json` 은 ABI 무관.
PnRDB 에 WriteJSON.cpp / ReadConstraint.cpp 가 이미 있어 직렬화 기반도 있다.

## 계획에 주는 영향
- Phase 1 (배치기 → 웹): 영향 없음. 진행 가능
- Phase 3 (Python → Pyodide): z3 빼고 통과. z3 결정 필요
- Phase 2 (배선기 → wasm): **S4 해결 전까지 일정 못 잡음**

---

## S4 후속 — 원인 지목됨 (2026-09-21, 추가 측정)

### RSS 시간축 (cascode_current_mirror_ota)
```
초   6:117MB   7:785   8:1808   9:2973  10:3836  11:4085  12:5215
    13:5627  14:6753  15:7919  16:8388  17~21:8392~8398(평평)  22:종료
```
단조증가 후 완전히 평평. 톱니(할당/해제)가 아니라 **누적**이고 끝까지 해제 안 됨.

### 지목
```
GcellDetailRouter.cpp:428   Grid grid = Generate_Grid_Net(i);   // 넷마다 격자
GcellDetailRouter.cpp:1015  chip_LL = LL;  chip_UR = UR;        // 범위 = 라우팅 영역 전체
```
**모든 넷이 칩 전체 크기의 정점 그래프를 따로 만든다.** 짧은 넷도 6720x11760
전체를 깐다. Grid 는 값이라 스코프 끝에 소멸하므로 그 자체는 누수가 아니고,
누적되는 것은 넷별 결과/부가 상태 쪽. 정확한 지목은 heaptrack 필요.

### 배치기로는 우회되지 않는다
s4-mem.sh 는 처음부터 $ALIGN_WORK/<예제>_ours 에서 돌았다.
즉 8,396 MB 는 **우리 배치(면적 0.78x)로 만든 레이아웃에서 나온 값**이다.
면적을 줄여도 그대로였다. 메모리가 레이아웃 품질이 아니라 넷 수에 붙어 있다.

### 고칠 방향 (라우터 내부, 배치와 무관)
넷별 격자 범위를 넷 bbox + 여유로 제한. 네이티브에서 바로 측정 가능하고
wasm 없이 검증된다. 메모리와 시간을 동시에 친다.

---

## S4 수정 — 완료 (1차)

### 최종 진단 (계측 빌드로 확정)
cascode_current_mirror_ota 8.4 GB 의 내역:
```
파이썬 기동 + 흐름                                    141 MB
router_driver 전처리 (verilog 변환)                 +1,228 MB
DB 구축 (PDK JSON, LEF, verilog, semantic)             +2 MB
hierarchical_place                                 +6,937 MB
  ├ PlacerIfc (외부 배치 경로, ext=True)                 +1 MB
  ├ update_grid_constraints x2                     +3,219 MB
  └ process_placements                             +3,718 MB   <- 반환값을 버림
실제 C++ 배선 (전역+상세+전원, 계층 2노드)               +72 MB
```
**C++ 라우터는 72 MB 다.** 나머지는 배선 단계가 배치 기계를 다시 돌리는 비용.

기각한 가설 4개: 라우팅 격자 폭발 / glibc 아레나 / 넷x면적 비례 / 수열쌍 열거기.

### 수정 (실질 4줄)
router.py 는 hierarchical_place(...) 의 반환값을 받지 않는다 (placer.py:397 만 쓴다).
배선 경로에서 process_placements 를 건너뛰게 파라미터를 추가.
```
placer.py  hierarchical_place(..., emit_placements=True)
           if not emit_placements: return None, None, None, None
router.py  hierarchical_place(..., emit_placements=False)
```

### 결과
```
예제                          전        후      감소   시간      GDS    DRC
telescopic_ota            2,709 →  2,310 MB   -15%  12->10s   80K=80K   0=0
high_speed_comparator     4,689 →  2,753 MB   -41%  19->16s  172K=172K  0=0
cascode_current_mirror    8,396 →  4,671 MB   -44%  23->17s  200K=200K  1=1
```
출력 검증 (cascode, 바이트 비교): 202,944 바이트 중 96 바이트만 다르고
전부 BGNLIB 타임스탬프(2) + STRNAME(15) + SNAME(19) 의 자동생성 이름 카운터다
(..._38 -> ..._40, ..._390 -> ..._408). **기하 레코드는 하나도 다르지 않다.**

### wasm32(4 GB) 기준
telescopic 2,310 OK / high_speed_comparator 2,753 OK / cascode 4,671 **아직 초과**

### 다음 표적
update_grid_constraints (+3,219 MB). process_placements 보다 위험하다 —
결과가 place_on_grid_constraints_json 으로 C++ ReadPrimitiveOffsetPitch 에 들어간다.

---

## S4 수정 2 — update_grid_constraints

### 무엇을 하는 함수인가
대칭이 아니라 **격자 정렬(PlaceOnGrid)** 제약이다. (대칭은 1_topology 에서 나온다.)
계층 노드마다:
  subset_verilog_d -> gen_placement_verilog(hN) -> scale_placement_verilog
  -> 리프에 primitive 제약 붙이기 -> gen_constraints() -> PlaceOnGrid 만 추출
process_placements 와 같은 패턴 — 거대한 중간물을 만들어 몇 바이트만 건진다.
정작 gen_constraints 자체는 grid_constraints.py 130줄로 가볍다.

### 이 예제들이 실제로 쓰는 양
정적 스캔: 2_primitives/*.json 의 metadata.constraints -> 세 예제 모두 0개
런타임 확인 ([POG] 계측): 모든 계층 노드에서 PlaceOnGrid 총 **0개**
저장소 전체: examples/ 와 pdks/ 에 PlaceOnGrid 문자열 **0건**
=> 실제 파운드리 PDK 용 기능이고, 여기서는 3.2 GB 를 써서 빈 목록을 만든다.

### 가드 (증명 가능한 전제조건)
gen_constraints_for_module 은 PlaceOnGrid 를 leaves[ctn] / modules[ctn] 에서만
가져오고, leaf 쪽은 primitives 의 metadata.constraints 에서 붙으며 module 쪽은
하위에서 전파된 것뿐이다. 따라서 primitives 에도 verilog_d 에도 PlaceOnGrid 가
없으면 결과는 공집합이다. C++ ReadPrimitiveOffsetPitch 는 빈 배열을 0회 순회하므로
[] 를 넘기는 것과 [{name, []}] 를 넘기는 것이 같다.

    if not _has_place_on_grid(verilog_d, primitives):
        return

### 누적 결과 (수정 1 + 수정 2)
```
예제                          원래        후       감소   시간       GDS    DRC
telescopic_ota            2,712 ->   776 MB   -71%  49->9s    80K=80K   0=0
high_speed_comparator     4,689 ->   833 MB   -82%  33->14s  172K=172K  0=0
cascode_current_mirror    8,396 -> 1,454 MB   -83%  22->13s  200K=200K  1=1
```

### 출력 동일성 검증 (cascode, 바이트)
202,944 바이트 중 70 바이트만 다르고 전부 BGNLIB 타임스탬프(2) +
STRNAME(15) + SNAME(19) 의 자동생성 카운터다 (20->36, 24->40).
구조 검사: 양쪽 다 구조 14개 / 참조 15개 / 미해결 참조 0개,
참조 그래프 동형, XY(기하) 바이트 123,624 로 동일.
=> 레이아웃은 같다.

### wasm32(4 GB) 기준
세 예제 전부 통과 (776 / 833 / 1,454 MB). **S4 해제.**

---

## S6 — 배선기(router 23.2k줄) 를 emscripten 으로  **통과**

계획에서 가장 비싼 실패 가능성이라 먼저 걷어냈다. 세 단계로 확인했다.

### (a) 컴파일 — 12/12, 첫 시도에 에러 0
```
A_star 448K  DetailRouter 500K  GcellDetailRouter 688K  GcellGlobalRouter 616K
GlobalGraph 420K  GlobalGrid 444K  GlobalRouter 504K  Graph 440K  Grid 548K
PowerRouter 532K  RawRouter 40K  Router 396K          합계 5.4 MB (오브젝트)
```
emcc 6.0.9, `-std=c++14 -O2`, 헤더는 spdlog v1.9.2 + nlohmann/json v3.7.3 + lp_solve 5.5.2.11.

### (b) 링크 — 1.3 MB wasm, 미정의 심볼 0
첫 시도에 17K 가 나왔는데 **-O2 가 안 쓰이는 코드를 전부 걷어낸 것**이었다.
타입만 확인한 셈이라 약한 검사다. volatile 전역으로 분기를 만들어
실제 진입점(RouteWork 모드 4/5/2/3, ReadLEFFromString, WriteJSON,
WriteGcellGlobalRoute)을 붙잡고 다시 링크했다.

```
router.js    69 K
router.wasm  1.3 MB        <- 계획서의 2~4 MB 추정보다 작다
```
router + PnRDB + lp_solve 를 한 덩어리로 묶어도 미정의 심볼이 없다.

### (c) 진짜 입력 — PDK 파싱 성공
layers.json 을 MEMFS 에 넣고 `PnRdatabase::ReadPDKJSON` 을 실제로 불렀다.

```
금속 레이어 수: 15   (네이티브와 일치)
grid_unit_x   : M1 160, M2 -1, M3 160, M4 -1
```
-1 은 가로 레이어의 정상 센티널이고(ReadDesignRuleJson.cpp:114),
160 = times * lpitch / ScaleFactor 다(:109). **값이 정확하다.**

### 증명된 것 / 안 된 것
- 증명됨: 컴파일, 링크, wasm 인스턴스화, 실제 PDK JSON 파싱, MEMFS 파일 I/O
- **안 됨: 실제로 배선을 돌려보지 않았다** (gate=0). 그러려면 C ABI 를 설계하고
  hierNode 입력을 넣어야 한다. 그게 Phase 2 의 본 작업이다.

### 계획에 주는 영향
S5 에서 정한 C ABI 경로가 열렸다. 메모리도 문제없다 — 네이티브에서 C++ 배선기
자체는 72 MB 였고, 파이썬이 빠지면 8GB 이야기는 애초에 없다.

## z3 — 결정됨 (사용자 제약을 받기로 함)
브라우저 도구가 사용자가 직접 쓴 제약을 받는다면, 모순 검출이 필요하므로
z3 검증은 no-op 이 아니라 **진짜 의존성**이다. "verify 를 끄고 간다" 선택지는
빠진다. 남은 것은 (a) z3 를 emscripten 4.0.9 로 Pyodide 용 빌드,
(b) 앞단을 Rust 로 옮기며 제약 검사를 직접 설계.

---

## S7 — z3 를 Pyodide 에 올리기  **통과**

브라우저 도구가 사용자가 직접 쓴 제약을 받기로 했으므로 모순 검출이 필요하고,
z3 는 no-op 이 아니라 진짜 의존성이다. Rust 대신 Pyodide 로 가기로 결정됨.

### 먼저 확인한 것 — ctypes 가 되는가
z3 의 파이썬 바인딩은 **C 확장이 아니라 순수 파이썬 + ctypes** 다
(`z3core.py` 가 `ctypes.CDLL`). 그래서 필요한 것은 libz3 를 **side module** 로
빌드하는 것뿐이고, 파이썬 쪽은 컴파일할 게 없다.

Pyodide 0.28.3 에서 직접 확인:
```
CDLL(None): ok                    프로세스 심볼 접근 가능
strlen('hello') = 5 ok            진짜 함수 호출이 된다
CFUNCTYPE 콜백 생성: ok            z3 의 error handler 에 필요
Module.loadDynamicLibrary / LDSO / _dlopen 모두 있음
ABI: emscripten-4.0.9-wasm32, Python 3.13.2
```

### 네 번 헛짚었다 — 각각이 다른 함정이었다
1. **emscripten CMake 는 shared 를 안 만든다.** `Z3_BUILD_LIBZ3_SHARED=ON` 을 줘도
   `libz3.a`(정적, 65MB)가 나온다. 아카이브 자체는 멀쩡하다(오브젝트 824개, Z3_ 심볼 784개).
2. **`-Wl,--whole-archive` 가 안 먹는다.** 그 .a 를 넘기면 3.8K 짜리 빈 모듈이 나온다.
   오브젝트를 직접 넘겨야 한다.
3. **`SIDE_MODULE=2` 는 전부 걷어낸다.** EXPORTED_FUNCTIONS 에 적은 것만 내보내므로
   아무것도 안 적으면 링커가 다 지운다. `SIDE_MODULE=1` 이어야 한다.
4. **예외 ABI 가 어긋났다.** `-fexceptions`(JS 기반)로 빌드하니 적재 시
   `cannot resolve symbol invoke_vi`. Pyodide 본체를 조사해보니:
   ```
   Module 의 invoke_* : 0 개
   pyodide.asm.wasm 이 import 하는 tag: env.__c_longjmp, env.__cpp_exception
   -> Pyodide 는 -fwasm-exceptions 로 빌드됨
   ```
   `-fwasm-exceptions -sSUPPORT_LONGJMP=wasm` 으로 맞추니 해결. 크기도 22MB -> 17MB.

그리고 **버전을 맞춰야 한다**. z3core.py 는 심볼 서명을 import 시점에 전부 잡으므로
pip 의 z3-solver 와 같은 버전(5.1.0)을 빌드해야 그 파이썬 파일을 그대로 쓸 수 있다.
처음에 4.13.4 를 빌드했다가 갈아엎었다.

### 또 하나 — 메인 스레드에서는 안 된다
```
RangeError: WebAssembly.Compile is disallowed on the main thread,
            if the buffer size is larger than 8MB
```
17MB side module 은 **Web Worker 에서만** 적재된다. Phase 4 에서 어차피 워커를
쓰기로 했으니 방향은 같지만, 선택이 아니라 필수라는 점이 달라졌다.

### 결과 (Pyodide 0.28.3 워커, 실측)
```
libz3.so         16.6 MB   (emscripten 4.0.9, wasm EH, 단일 스레드)
Z3_* 심볼        807
Pyodide 부팅     1.9 s
libz3 적재       0.2 s
전체 (검사 포함)  2.8 s
```
ALIGN 의 checker 가 쓰는 연산 전부 동작:
```
기본 풀이        x+y=10, x-y=4 -> sat  x=7 y=3
And/Or/Not/Implies -> sat
If (절댓값)      -> sat  a=-5
ToReal           -> sat
push/pop         모순일 때 unsat, 되돌린 뒤 sat
unsat_core       unsat, 원인=['큰값','작은값']   <- 사용자 제약 검증의 핵심
```

재현 스크립트: `scripts/build-z3-pyodide.sh` (꾸러미에 포함)

---

## S8 — 1_topology 를 브라우저에서  **통과 (출력 바이트 동일)**

SPICE 넷리스트 -> 계층 verilog + 제약 추론을 Pyodide 워커에서 돌렸다.

```
[1] Pyodide 부팅         2.2s
[2] networkx             4.0s
[3] micropip 휠 2개       4.7s   pydantic==1.10.13, python-gdsii
[4] libz3 16.6MB 적재     4.9s
[5] align+PDK+예제 1.8MB  5.0s
[6] import align         7.9s
[7] 1_topology 실행       9.1s
```

### 출력 대조 (telescopic_ota)
```
파일                                 크기     네이티브 md5   브라우저 md5
TELESCOPIC_OTA.verilog.json        5435 B   a92c6acc16ed   a92c6acc16ed
__primitives_library__.json        8706 B   fb28b24b88be   fb28b24b88be
telescopic_ota.const.json          2736 B   00a1944cdfbe   00a1944cdfbe
```
**바이트까지 같다.** 추론된 제약도 동일:
`{PowerPorts:1, GroundPorts:1, SymmetricBlocks:1, SymmetricNets:4}`
(find_constraint.py 의 FindSymmetry 가 브라우저에서 그대로 돈다)

### 의존 라이브러리를 8 -> 3 으로 줄였다
앞단만 놓고 다시 세어보니(scan-front.py) 서드파티는 8 종뿐이었고, 그중 여럿이 불필요했다.

| 뺀 것 | 이유 |
|---|---|
| numpy, pandas | align/gui 에만 쓰인다 |
| colorlog | 저장소 어디에도 import 가 없다 (아래 함정 참고) |
| flatdict | 직접 구현 — 진짜 라이브러리와 68 건 대조 |
| more_itertools | `import more_itertools as itertools` 로 별칭을 걸고 combinations/product/pairwise 만 쓴다. 셋 다 표준 itertools 에 있다 |
| plotly, dash x2, gdspy, mip | 배선/GUI/black_box 경로 전용 -> 스텁 |

**남은 것: networkx(내장), pydantic 1.10.13, python-gdsii.**
networkx 는 GraphMatcher(부분그래프 동형)를 쓰므로 직접 만들 것이 아니다.
python-gdsii 는 나중에 GDS 쓰기에 필요하고 형식이 단순해 자체 구현 후보다.

### flatdict 를 직접 만들 때 주의한 것
`FlatDict(d)` 의 키 형식이 **생성되는 서브회로 이름의 해시에 들어간다**
(`sha256('_'.join(k+':'+str(v)))  % 10**8`). 대충 만들면 이름이 달라져
네이티브와 대조가 깨진다. align 이 실제로 부르는 계산까지 똑같이 재현해
진짜 flatdict 와 68 건(실제 데이터 모양 + 무작위 중첩) 비교했다 — 전부 일치.

### 함정 다섯 개
1. **`align/__init__` 이 배선까지 끌어온다.** `from .pnr import generate_pnr` ->
   `from .. import PnR`. PnR.py 스텁을 둬야 import align 이 된다.
   (나중에 배선기 wasm 이 붙을 자리이기도 하다)
2. **AST 스캔이 colorlog 를 놓쳤다.** import 문이 아니라 `logging.ini` 에
   `class=colorlog.ColoredFormatter` 문자열로 있다. 실행해봐야 드러난다.
3. **logging.ini 의 파일 핸들러는 건드리면 안 된다.** 스트림으로 바꿨더니
   logmanager 가 `args.split("'")[1]` 로 경로를 파싱하다 깨졌고,
   reconfigure_loglevels 는 RotatingFileHandler 를 isinstance 로 찾는다.
4. **스텁 finder 를 meta_path 뒤에 붙이면 무력하다.** 기본 finder 가 디스크의
   진짜 `align/gui/mockup.py` 를 먼저 찾는다. 앞에 꽂고, align/gui 는 아예 뺐다.
5. **스텁이 너무 엄격해도 안 된다.** 처음엔 호출 시 raise 하게 했는데
   plotly 는 import 시점에 모듈 수준에서 함수를 부른다
   (`['Blugrn'] + px.colors.named_colorscales()`). 라이브러리를 흉내내는 대신
   **기능의 경계**(align.gui)에서 잘랐다.

### 남은 것
- 2_primitives 를 같은 방식으로 (cell_fabric 이 기하를 만든다)
- 배선기 C ABI -> PnR.py 를 스텁에서 진짜 다리로
- 워커 껍데기 + OPFS 캐시

---

## S9 — 2_primitives 까지 브라우저에서  **통과 (36개 파일 전부 바이트 동일)**

앞단 두 단계를 Pyodide 워커에서 돌리고 네이티브 출력과 md5 로 전부 대조했다.

```
1_topology    3 개   TELESCOPIC_OTA.verilog.json / __primitives_library__.json
                     / telescopic_ota.const.json
2_primitives 33 개   leaf 셀 8 종 x (gds.json, json, lef, placement_lef)
                     + __primitives__.json          합계 1,384,363 B
```
**36 개 전부 네이티브와 md5 일치.** cell_fabric 이 만드는 기하까지 그대로다.

같은 세션에서 두 번 돌려 결정성도 확인했다 — 33 개 중 0 개 차이.

### 시간 (첫 방문)
```
Pyodide 부팅          2.1s
networkx              +1.7s
micropip 휠 2개        +0.7s   pydantic==1.10.13, python-gdsii
libz3 16.6MB 적재      +0.3s
align+PDK+예제 1.8MB   +0.1s
import align          +2.6s
앞단 2단계 x 2회       +5.0s
```

### 중간에 헛돈 것 하나
2_primitives 의 md5 가 네이티브와 다르게 나와 한참 쫓았다. 파일 수와 크기는
정확히 같은데 내용만 달라서 타임스탬프나 부동소수점 표기를 의심했고,
파일을 base64 로 꺼내 바이트 비교까지 했다. 그런데 그 때 꺼낸 것은
**네이티브와 일치**했다 — 즉 실행마다 달랐다.

front.py 를 고쳐가며 돌리던 중의 산물이었고, 정리한 뒤 다시 재니 전부 일치했다.
교훈: 중간 상태로 측정하지 말 것. 결정성 검사(같은 세션 2회)를 붙여 두었다.

### 의존 라이브러리 최종
```
Pyodide 내장 : networkx            (GraphMatcher 부분그래프 동형)
micropip     : pydantic==1.10.13, python-gdsii
직접 구현    : flatdict, more_itertools
직접 빌드    : libz3 (side module)
스텁         : gdspy, mip, plotly, dash x2, align.gui
제거         : numpy, pandas, colorlog, align/gui
```

---

## S10/S11 — 배선기 경로 재결정: **C ABI 대신 pybind11**

### S5 의 결정을 뒤집는다
S5 에서 "pybind11 은 Pyodide 가 emscripten 을 고정해서 어렵다 -> C ABI" 로 정했다.
그 근거가 지금은 약하다. z3 때문에 emscripten 을 맞춰 깔아봤고, 예외 ABI 를
알아내는 방법도 생겼다. pybind11 이 되면 **align/pnr/router.py 450 줄의
오케스트레이션을 한 줄도 안 건드린다.** C ABI 는 그걸 전부 다시 써야 한다.

### 관문: 호스트 파이썬 버전
pyodide-build 의 교차 빌드는 **호스트 파이썬이 대상과 같은 마이너 버전**이어야 한다.
```
Pyodide 0.28.x  Python 3.13.2  emscripten 4.0.9   <- 호스트 3.12 로는 불가
Pyodide 0.27.x  Python 3.12.7  emscripten 3.1.58  <- 가능
```
우리 호스트는 3.12.3 이다. 그래서 **0.27.8 로 내려간다.**

### 내려가도 되는지 확인한 것
```
router 12/12, PnRDB 7/7  emscripten 3.1.58 로 컴파일 통과
Pyodide 0.27.8 의 예외 ABI: -fexceptions (JS)   <- 0.28 과 반대다
   (invoke_* import 38 개, tag 0 개. 0.28 은 정반대였다)
networkx 3.4.2 / pydantic==1.10.13 / python-gdsii  전부 됨
```

### pybind11 확장 교차 빌드 — 최소 예제로 먼저 확인
```
pyodide xbuildenv install 0.27.8
pyodide build           -> pbtest.cpython-312-wasm32-emscripten.so (46KB 휠)
```
브라우저에서:
```
addup(2,3) = 5                          함수 호출
Box.total() = 16, hi = 9                C++ 클래스 + STL vector + 속성
예외 전달: RuntimeError: 음수는 안 된다   C++ 예외 -> 파이썬  <- PnR 에 필요
```

**함정 하나.** pyodide-build 0.39 는 새 표기 `pyemscripten_2024_0_wasm32` 로
포장하는데 Pyodide 0.27.8 의 micropip 은 옛 표기 `emscripten_3_1_58_wasm32` 만 받는다
(도구가 런타임보다 신버전이라 생긴 표기 불일치). 안의 .so 는 0.27.8 xbuildenv 로
빌드한 것이라 ABI 는 맞으므로 태그만 고친다 -> `retag-wheel.py`.
ABI 가 실제로 달랐다면 import 에서 걸리므로 눈속임은 아니다.

### 이 결정의 대가
- libz3 를 emscripten 3.1.58 + `-fexceptions` 로 **다시 빌드**해야 한다
  (지금 것은 4.0.9 + wasm EH 로 0.28 용이다)
- 앞단(S8/S9)을 0.27 에서 다시 검증해야 한다 — 패키지는 이미 확인됐다

### 유용한 부산물
xbuildenv 가 **CMake 툴체인 파일**을 준다:
`pyodide_build/tools/cmake/Modules/Platform/Emscripten.cmake`
PnR 이 CMake 프로젝트라 이게 있으면 빌드가 훨씬 수월하다.

---

## S12 — ALIGN 배선기를 Pyodide 확장으로  **통과**

축소 PnR 모듈(router + PnRDB + lp_solve)을 Pyodide 0.27.8 용 휠로 빌드해
브라우저에서 import 하고 진짜 PDK 를 읽혔다.

```
휠: pnr-0.9.8-cp312-cp312-emscripten_3_1_58_wasm32.whl   672 KB

import PnR ok
point/bbox: (3,4)  bbox center (5,10)
ReadPDKJSON: 금속 레이어 15 종               <- 네이티브와 같은 값
  M1 grid_unit_x=160  M2 grid_unit_x=-1     <- 가로층 -1 은 정상 센티널
Router 생성 ok
빠뜨리기로 한 것 중 남은 것: 없음
필요한 것 중 빠진 것: 없음
```

### 왜 '축소' 인가 — ilpif 가 막았다
ALIGN 의 CMake 는 json / spdlog / superlu / boost / lpsolve / **ilpif** / pybind11 을
끌어온다. 그중 **ilpif 는 미리 빌드된 x86-64 솔버 바이너리를 `find_library` 로
찾는다** — wasm 판이 존재하지 않는다. 그걸 링크하는 것이 `placer` 다.
(MNA 는 superlu 를 쓴다. 둘 다 배선과 무관하다.)

그래서 ALIGN 의 CMake 를 쓰지 않고, 필요한 소스만 setuptools Extension 으로
직접 나열했다.
```
PnRDB 7 개 + router 12 개 + 축소 바인딩 1 개   (C++)
lp_solve 27 개                                  (C, 따로 빌드해 extra_objects 로)
```
바인딩에서 뺀 것: Placer_Router_Cap_Ifc, PlacerHyperparameters, PlacerIfc,
GuardRingIfc, MNASimulationIfc, HananRouter  (592 -> 556 줄)

### 함정
`setuptools` 는 `extra_compile_args` 를 언어와 무관하게 전부 붙인다.
lp_solve 의 .c 파일에 `-std=c++14` 가 가서 거부당했다:
```
error: invalid argument '-std=c++14' not allowed with 'C'
```
lp_solve 를 xbuildenv 의 emcc 로 따로 빌드해 `extra_objects` 로 넘겨 해결.

### 그래서 남은 문제 하나
PlacerIfc 를 뺐는데, `router.py` 가 `hierarchical_place` -> `place()` ->
`PnR.PlacerIfc(...)` 를 부른다. 배치를 하려는 게 아니라 **우리가 준 배치를
DB 의 hierTree 에 채워 넣으려고** 부르는 것이다
(`use_external_placement_info=True` -> `setPlacementInfoFromJson`).

즉 알고리즘이 아니라 **자료 복사**다. 파이썬에서 CheckoutHierNode ->
블록 좌표 써넣기 -> CheckinHierNode 로 직접 하면 된다. 그러면 ALIGN 배치기를
통째로 안 싣고도 배선이 돈다. (덤으로 6.9GB 문제의 근원도 사라진다)

### 남은 일
1. 위의 DB 채우기를 파이썬으로 (PlacerIfc 대체)
2. libz3 를 emscripten 3.1.58 + `-fexceptions` 로 재빌드 (지금 것은 0.28 용)
3. 앞단(S8/S9)을 0.27 에서 재검증
4. 워커 하나로 묶기

### S12 후속 — placer 를 되살렸다 (파이썬 재구현 대신)

S12 에서 "PlacerIfc 를 빼고 DB 채우기를 파이썬으로 다시 쓰자" 고 적었는데,
`setPlacementInfoFromJson` 을 읽어보니 단순 좌표 복사가 아니었다 — 변이 선택,
H/V flip, LL/UR, 면적, HPWL, HPWL_extend 까지 채운다. 200 줄을 재현하는 것은
위험하고, 틀려도 티가 안 난다.

대신 **placer 를 그대로 싣고 ILP 솔버만 스텁으로** 때웠다.
`ILPSolverIf` 는 `ILP_Place.cpp:313` 과 `ILP_solver.cpp:1780` 두 곳에서만 쓰이고
둘 다 탐색 경로다. 우리 경로(use_external_placement_info=True)는 안 지난다.
메서드 6 개짜리 인터페이스라 스텁이 짧고, 실제로 풀려 들면 예외를 던진다.

```
휠: pnr-0.9.8-cp312-cp312-emscripten_3_1_58_wasm32.whl   812 KB
  PnRDB 7 + router 12 + placer 6 + 축소 바인딩 1 + ILP 스텁 1   (C++)
  lp_solve 27                                                    (C)
바인딩에서 뺀 것: Placer_Router_Cap_Ifc, GuardRingIfc,
                  MNASimulationIfc, HananRouter   (592 -> 579 줄)
```
boost 는 헤더 2 개(graph)만 쓰므로 네이티브 빌드가 받아둔 것을 재사용했다.

브라우저 확인:
```
PlacerHyperparameters: use_external=True, SA_MAX_ITER=10000
빠뜨리기로 한 것 중 남은 것: 없음
필요한 것 중 빠진 것: 없음
```
=> `align/pnr/router.py` 를 한 줄도 안 고치고 쓸 수 있다.

**함정.** ALIGN 은 모듈마다 별도 라이브러리로 빌드해서 `get_true_word` 가
`PnRDB/readfile.cpp` 와 `placer/Preadfile.cpp` 에 중복 정의돼 있어도 안 부딪힌다.
하나로 합치니 링크에서 duplicate symbol 이 났다. Preadfile.h 는 자기 자신만
include 하는 죽은 코드라 빼서 해결.

### 입력과 중간 수정은 되는가 (질문 답)
된다. 단계 경계가 전부 JSON 이고 브라우저에 가상 FS 가 있어서,
넷리스트/제약을 직접 넣고 어느 지점에서든 끼어들 수 있다.
배치가 DB 로 들어가는 경로를 우리가 쥐므로 "블록 옮기고 배선만 다시" 도 직접적이다.

**다만 구멍 하나**: 우리 배치기는 SymmetricBlocks 와 Align 만 구현했다.
사용자가 Order/Spread/AspectRatio/Boundary 를 쓰면 topology 는 만들고 z3 는
검증하지만 배치기가 무시한다. 메워야 한다.

---

## S13 — Pyodide 0.27 워커 하나에 전부  **통과**

```
[1] Pyodide 0.27.8  emscripten-3.1.58-wasm32        1.1s
[2] networkx, pydantic 1.10.13, python-gdsii        2.2s
[3] libz3 21.4 MB (직접 빌드, 3.1.58 + -fexceptions) 2.5s
[4] PnR 812 KB (router+PnRDB+placer+lp_solve)       2.6s
[5] align 앞단 + PDK + 예제 1.8 MB                   2.6s
[6] import align 0.9.8 / z3 5.1.0 / PnR             3.8s
[7] 앞단 2 단계 x 2 회                                5.2s
```

### 0.27 로 내려오며 걸린 것 둘
1. **동적 적재 API 가 다르다.**
   0.27: `pyodide._api.loadDynlib(path, global)`
   0.28: `Module.loadDynamicLibrary(path, {global, nodelete})`
   0.27 에서 Module 쪽을 부르면 `Didn't expect to load any more file_packager
   files!` 로 막힌다. 두 경로를 다 두었다.
2. **`-sWASM_BIGINT` 가 빠져 있었다.**
   ```
   Import "env" "_ZNSt3__26chrono12steady_clock3nowEv":
   imported function does not match the expected type
   ```
   Pyodide 본체가 WASM_BIGINT 로 빌드돼 있어서(xbuildenv 의 ldflags 에 있다),
   없으면 i64 가 i32 둘로 쪼개져 시그니처가 어긋난다. 링크에 추가해 해결.

## S13b — **앞선 판단을 정정한다: ALIGN 은 비결정적이다**

S9 에서 2_primitives 의 md5 가 네이티브와 달랐다가 다시 같아지는 것을 보고
"front.py 를 고쳐가며 돌리던 중간 상태의 산물" 이라고 적었다. **틀렸다.**

0.27 에서 다시 어긋나기에 줄 단위로 파보니, 143 줄 중 **2 줄**만 다르고
그 둘은 **같은 사각형 쌍이 자리를 맞바꾼 것**이었다:
```
네이티브 87: RECT 284 2924 516 2956      브라우저 87: RECT 204 1412 596 1444
네이티브 89: RECT 204 1412 596 1444      브라우저 89: RECT 284 2924 516 2956
```
네이티브를 세 번 돌려보니:
```
1회차 63aa3818811b
2회차 63aa3818811b
3회차 108e7505a75f      <- 브라우저가 내는 바로 그 값
PYTHONHASHSEED=0 고정 시  두 번 다 63aa3818811b
```
**ALIGN 의 2_primitives 는 파이썬 해시 랜덤화 때문에 네이티브에서도 실행마다
바이트가 달라진다.** 브라우저 출력은 ALIGN 이 내는 값 중 하나다.

Pyodide 에서는 `loadPyodide({env:{PYTHONHASHSEED:"0"}})` 로 못 고친다 —
해시 시드는 인터프리터가 시작할 때 정해지고 그 env 는 나중에 들어간다.

### 그래서 검사 방법을 바꿨다
md5 대조는 이 단계에 맞지 않는다. **순서 무관 지문**으로 본다:
- `.lef` : 줄의 다중집합
- `.json`: 키 정렬 + 리스트 정렬한 정규형

결과: **36 개 파일(1_topology 3 + 2_primitives 33) 전부 지문 일치.**
기하는 같고, 같은 레코드 두 개의 출력 순서만 다르다.

교훈: 상류가 결정적이라고 가정하지 말 것. 그리고 설명이 안 되는 차이를
"중간 상태 탓" 으로 넘기지 말 것 — 두 번째로 나타났을 때에야 제대로 팠다.

### 남은 것
- 브라우저에서 배치까지 가려면 **변이 선택**이 필요하다. ALIGN 배치기가
  X1_Y2 / X2_Y1 중 무엇을 쓸지 고르는데, 그 배치기는 ILP 솔버가 필요해
  브라우저에 못 싣는다. 우리 배치기는 변이를 **주어진 것으로** 받는다.
  지금은 고정값(fixtures)으로 우회하고 있다. 규칙이 필요하다.
  **-> S14 에서 닫았다.**
- 배선을 실제로 한 번 돌려 GDS 까지
- 앞단·배치·배선을 한 워커에서 이어 붙이기

---

## S14 — 변이 선택: ALIGN 배치기 없이 배치하기  **통과**

S13b 끝에 "남은 것" 첫 줄로 적었던 것을 닫는다.

> 브라우저에서 배치까지 가려면 **변이 선택**이 필요하다. ALIGN 배치기가
> X1_Y2 / X2_Y1 중 무엇을 쓸지 고르는데, 그 배치기는 ILP 솔버가 필요해
> 브라우저에 못 싣는다. 우리 배치기는 변이를 **주어진 것으로** 받는다.

### 문제의 진짜 크기

변이만의 문제가 아니었다. 우리 배치기는 블록 크기·핀·영역을 전부 ALIGN 의
place 출력(`3_pnr/Results/*.scaled_placement_verilog.json`)에서 읽고 있었다.
그 파일에는 ALIGN 이 이미 고른 답이 **세 가지** 박혀 있다.

| 무엇 | 예전 | 지금 |
|---|---|---|
| 변이 (어느 종횡비 소자) | ALIGN 이 고른 것을 받음 | `2_primitives` 에서 후보를 읽고 **우리가 고름** |
| 거울 반전 (sX, sY) | ALIGN 의 transformation 을 받음 | 좌표 고정 후 **좌표하강으로 고름** |
| 영역 (region) | ALIGN 이 배치한 뒤의 bbox | **제약에서 유도** (AspectRatio + 대칭 구조 + 면적) |

### 먼저 확인한 것 — 단위가 같은가

2_primitives 의 좌표와 place 단계 leaf 좌표가 같은 단위인지부터 재야 했다.
어긋나면 배선 격자(M1 80, M2 84)와 안 맞아 DRC 가 난다.

```
concrete                       place bbox           2_primitives bbox     배율
SCM_NMOS_57015810_X2_Y1        [0,0,1120,2352]      [0,0,1120,2352]       1.0, 1.0
CMC_PMOS_51983143_X2_Y1        [0,0,1120,2352]      [0,0,1120,2352]       1.0, 1.0
DP_NMOS_B_44742353_X3_Y1       [0,0,1440,2352]      [0,0,1440,2352]       1.0, 1.0
핀 중심도 전부 차이 0.0
```

같았다. 파일 이름의 "scaled" 는 상위 모듈 좌표계 얘기지 템플릿 좌표가 아니다.
핀은 `terminals` 중 `netType=="pin"` 인 것들을 넷별로 합집합한 사각형의 중심인데,
place 단계 leaf 의 `terminals[].rect` 중심과 정확히 일치했다.

### 조합 수 — 전수로 돌 만하다

```
예제                          인스턴스   변이 조합
current_mirror_ota                5         2
five_transistor_ota               3        60
telescopic_ota                    5         8
high_speed_comparator            10         4
cascode_current_mirror_ota       11         8
```

블록이 11 개여도 조합은 8 개다. 대부분의 인스턴스는 변이가 하나뿐이다.

### 구조 — 이미 있던 다중 시작에 얹었다

설정 = (변이 배정) x (영역 후보). 설정마다 `A z = b` 와 영공간을 새로 만든다
(대칭 계가 블록 크기에 의존하므로 재사용 불가). 대칭 쌍은 같은 변이를 써야
하므로 배정 단위는 블록이 아니라 **그룹**이다.

### 대조 검사 — 같은 변이를 주면 같은 문제가 나오는가

`test/design.mjs`. ALIGN 이 고른 concrete 를 그대로 배정하고 고정값과 맞댔다.
블록 순서·핀 순서는 자료구조 순회 순서라 이름으로 맞춘 다중집합 비교.

```
telescopic_ota       크기 최대차 0   핀 14/14   넷 7/7
five_transistor_ota  크기 최대차 0   핀  6/6    넷 3/3
```

### 틀렸던 것 일곱 개

**(1) 영역을 "면적 x slack" 으로만 잡았다.** telescopic_ota 는 대칭이 블록을 한
세로축에 묶어 세로로 쌓게 만드는데, 면적만 맞추고 종횡비를 [0.5, 1, 2] 로 넣으니
legalize 가 후보 96 개 중 **66 개에서 INFEASIBLE** 이었다. 실패가 정사각·가로형에
전부 몰려 있었다.

```
ar 0.10~0.31 (구조 힌트)   성공 3/3,  연속단계 겹침 0.12~0.25
ar 0.40~2.00               성공 0/3,  겹침 0.49~0.84
```

**(2) 구조 힌트가 거울 쌍까지 쌓았다.** 자기대칭 블록은 축 위에 있어 정말로
쌓이지만, 거울 쌍은 축 좌우로 벌어져 나란히 설 수 있다. current_mirror_ota 는
ALIGN 이 **8800 x 2352 한 줄**로 놓는데 하한식이 6080 x 4704 (ar 1.29) 를 내고
있었다. 쌍을 폭에만 반영하도록 고치니 6080 x 2352 (ar 2.59) 가 나왔고, 면적비가
**2.345x -> 1.000x** 가 됐다 (bbox 까지 ALIGN 과 정확히 같아졌다).

**(3) `AspectRatio` 제약을 안 읽고 있었다.** cascode 가
`ratio_low 0.5 / ratio_high 2` 를 건다. ALIGN 은 이걸 `PlacementCoreAspectRatio_ILP`
라는 전용 ILP 로 푼다. 추측할 이유가 없는 정보였다. 읽어서 영역 후보를 그 범위로
자르니 면적비가 크게 좋아졌다.

**(4) 연속단계 점수로 후보를 골랐다.** 연속단계 점수는 겹침을 3 배 벌점으로
근사할 뿐이고, 실제 면적은 legalize 로 겹침을 털어내야 정해진다. 1 위 후보가
legalize 뒤 면적 **1.42x** 였는데, 상위 16 개를 legalize 해서 다시 고르니
**1.00x** 가 됐다. legalize 는 후보당 0.00~0.12 초라 Adam 에 비하면 공짜다.

**(5) top 모듈을 "마지막 모듈"로 잡았다.** high_speed_comparator 는 계층 설계고
`modules[]` 마지막이 하위 모듈이다. **블록 10 개짜리 설계가 2 개짜리로 줄어든 채
"성공"** 했다. 아무도 인스턴스로 쓰지 않는 모듈이 top 이다. 같은 실수를 기준선
쪽에서도 해서 cascode 면적비가 13.6x 로 나왔었다.
인스턴스가 통째로 빠지면 이제 `missing` 으로 실패시킨다.

**(6) 구조 하한이 `Align` 을 안 봤다.** `Align h_*` 은 블록을 **가로줄**로 묶는다
— 같은 y 선을 공유하면 옆으로 늘어설 수밖에 없다. 그런데 하한식은
`SymmetricBlocks` 만 보고 블록을 하나씩 쌓았다. high_speed_comparator 에서
2560 x 25872 (ar 0.099) 가 나왔는데 ALIGN 은 6080 x 10584 (ar 0.574) 다.
사다리(x1, x2, x4 = 0.099~0.396)가 정답에 **닿지도 못했다.**

줄을 하나의 **단위**로 보고 단위를 쌓게 고쳤다:

```
가로줄 X_MP9 X_MP7 XDP X_MP8 X_MP10  ->  6080 x 3528
가로줄 XINV_N XCCP XINV_P            ->  4800 x 2352
단독   XCCN                              3520 x 2352
단독   X_MN0                             1760 x 2352
    폭 max(...) = 6080,  높이 합 = 10584      <- ALIGN 의 bbox 와 정확히 일치
```

`Align` 이 없는 설계에서는 단위가 블록 하나씩이라 예전 값과 같다.

**(7) 기준선이 ALIGN 이 아니었다.** `fixtures/*.json` 의 `cx_align` 은
`export-fixtures.py` 가 `<예제>_ours` 를 **먼저** 찾기 때문에 우리 파이썬
배치기의 좌표일 수 있다. high_speed_comparator 는 고정값 region 이 4320x18816,
ALIGN 의 bbox 는 6080x10584 로 아예 다른 레이아웃이었다.
기준선을 `__align_place__.json` 에서 직접 재도록 JS 로 다시 썼다 (`test/_load.mjs`).

### 점수 정규화 — 두 번 틀렸다

점수가 `면적/refArea + HPWL/refHpwl + 3 x 겹침` 인데 ref 기본값이 1 이었다.
단위가 섞여 (면적 ~1e7, HPWL ~1e4) 면적 항이 통째로 잡아먹는다. ALIGN 의 답을
기준으로 쓰면 되지만 **새 넷리스트에는 그 답이 없다.** 그래서 설계 자신에서
뽑도록 했는데, **배정마다 그 배정의 블록 합계 면적으로 나눴다. 이게 틀렸다.**

그러면 면적비가 "채움률"이 되어 배정 간 비교가 통째로 사라진다:

```
NMOS_4T_85599263   X1_Y16    640 x 19992 = 12.79M
                   X8_Y2    1760 x  3528 =  6.21M     <- 절반
```

같은 소자인데 변이에 따라 블록 면적이 **2 배** 차이난다. 둘 다 빈틈없이 놓으면
채움률 1.0 이라 점수가 같다 — **실리콘을 두 배 쓴다는 걸 점수가 못 본다.**

telescopic_ota 에서 안 드러난 이유: 그쪽 변이는 면적 차이가 7% 다
(800x3528 = 2.82M vs 1120x2352 = 2.63M). high_speed_comparator 는 2 배라
그대로 터졌다.

고친 것: 기준을 **모든 배정에 걸쳐 하나로** 고정한다 (가장 작은 블록 합계 면적).

```
refArea = min over 배정 (블록 합계 면적)
refHpwl = sqrt(refArea) x 넷 수
```

**후보 집합의 최소값으로 정규화하는 것도 해봤는데 졌다.** `면적/min(면적) +
HPWL/min(HPWL)` 은 두 항이 1 에서 시작해 대등해 보이지만, 최소값이 후보 집합에
상대적이라 같은 맹점이 돌아온다:

```
예제                   상수 기준        최소값 정규화
five_transistor_ota    0.862 / 1.404    1.077 / 0.803
high_speed_comparator  1.140 / 1.459    1.520 / 2.119   <- 크게 진다
```

hsc 가 아픈 이유는 계층이다. 하위 모듈에서 맹점이 살아나면 나쁜 하위 모듈이
위층 입력이 되어 손해가 곱해진다.

면적 대 배선의 무게는 `hpwlWeight` 로 뺐다 (기본 1). 기본값에서 배선 항이
0.5 쯤에서 놀아 면적이 조금 앞선다 — 아날로그에서 면적이 1차 비용이라
그쪽이 맞다고 보고 두었다.

### 계층 설계

hsc 와 cascode 는 최상위가 하위 모듈을 인스턴스로 쓴다. 아래에서 위로 배치한다 —
하위를 먼저 배치해 크기와 포트 위치를 굳히고(포트 = 그 넷에 붙은 자식 핀들의
무게중심), 상위는 그걸 블록 하나로 본다. 굳힌 결과를
`2_primitives/<concrete>.json` 과 **같은 모양**으로 내보내서 상위 모듈은 leaf 인지
하위 모듈인지 구분하지 않는다. ALIGN 도 같은 순서다.

### 변이 선택이 정말 결과를 가르는가 — 전수로 재봤다

five_transistor_ota 의 60 개 배정을 전부 legalize 까지 돌려 줄 세웠다.

```
 순위  배정       변이          면적비  HPWL비  점수
   1   [2,4,3]    Y1 Y1 Y1      1.077   0.803   1.4742   <- 우리
   6   [2,3,2]    Y1 Y2 Y2      1.000   1.216   1.6979   <- ALIGN
  60   [0,0,3]    Y4 Y16 Y1     2.708   5.527   4.2414
```

**최악의 배정은 면적 2.7 배, 배선 5.5 배다.** 같은 트랜지스터·같은 파라미터·
같은 배치기인데 소자 모양만 바꿔서 그렇다. telescopic_ota(8 조합)와
current_mirror_ota(2 조합)에서는 ALIGN 이 고른 것이 **1 위**였고 우리도 그걸 골랐다.

### 결과 (시작점 96 x 600, 단일 스레드 node)

| 예제 | 블록 | 변이조합 | 면적 | HPWL | 겹침 | 대칭잔차 | 시간 |
|---|---|---|---|---|---|---|---|
| telescopic_ota | 5 | 8 | **1.000x** | 0.987x | 0 | 1.1e-13 | 8s |
| current_mirror_ota | 5 | 2 | **1.000x** | **1.000x** | 1e-16 | 0 | 9s |
| five_transistor_ota | 3 | 60 | **0.862x** | 1.404x | 0 | 0 | 22s |
| high_speed_comparator | 10 | 108 | 1.053x | 1.333x | 2e-16 | 9.1e-13 | 92s |
| cascode_current_mirror_ota | 11 | 16 | 1.111x | 1.304x | 7e-17 | 0 | 36s |

**아직 ALIGN 에 못 미친다.** 앞의 둘은 bbox 까지 같고, five_transistor 는 면적을
얻고 배선을 내준 맞바꿈이며, 뒤의 둘은 양쪽 다 진다. 그리고 **DRC 는 한 번도
못 봤다** — 격자 스냅과 handoff 가 없어 배선기로 못 넘긴다.

telescopic_ota 와 current_mirror_ota 는 **bbox 까지 ALIGN 과 정확히 같다**
(1440x11760, 8800x2352). 변이도 반전도 독립적으로 같은 답에 도달했다.

반전 고르기의 효과는 작지 않다 — HPWL 이 **0.38 ~ 0.90 배**로 줄었다.

### high_speed_comparator 를 파본 기록 — 짚었던 것이 둘 다 아니었다

처음엔 `Order` 제약을 무시해서라고 적었다. **확인 안 한 추측이었고 틀렸다.**

1. `Align` 을 구조 힌트에 반영 -> 하한이 ALIGN bbox 와 정확히 일치 (6080x10584).
2. 그런데 그 종횡비를 **직접 먹였더니 legalize 가 전부 실패**했다. 영역만의
   문제가 아니다.
3. legalize 실패 73/96 을 뜯어보니 방향이 아예 없는 쌍(`NODIRECTION`)은 **0 건**.
   각 쌍은 갈 곳이 있는데 **조합**이 안 맞는다 — MILP 를 LP 로 줄인 대가다.
4. 우리가 배치한 **하위 모듈**이 전부 폭 1280 으로 홀쭉했다. 그게 위층 입력이다.

```
                   우리          ALIGN         면적비
PRIMITIVE_38447703  1280x19992   3520x3528     2.06x
PRIMITIVE_98739713  1280x10584   3520x2352     1.64x
PRIMITIVE_8946161   1280x 5880   2240x2352     1.43x
```

5. 그 모듈을 뜯어보니 **배치는 완벽했다** — 블록 2 개가 빈틈없이 나란히,
   채움률 1.00. 틀린 건 **변이 선택**이었고 원인은 위의 점수 정규화 버그였다.

고치고 나서 1.316x / 1.826x -> **1.140x / 1.459x**. 아직 제일 나쁘고, 남은 것은
(3) 이다 — legalize 가 실패한 후보를 그냥 버리는데 방향 몇 개를 뒤집어
재시도하면 살릴 수 있다. `Order` 도 그때 같이 넣으면 된다 (부등식이라
이미 있는 LP 에 줄 몇 개다).

### 그 다음: 병목을 짚기 전에 재라 (세 번 틀렸다)

hsc 를 더 파면서 원인을 세 번 짚었는데 **셋 다 사실이지만 병목이 아니었다.**

1. `Order` 무시 -> 구현해보니 **위반 0 건, 숫자 그대로**. 연속해가 이미
   순서를 지키고 있었다. (그래도 이제 보장된다는 게 남는다.)
2. legalize 실패 -> 후보 96 개를 **전부** 풀어 절대 최선을 골라도
   **1.140x / 1.459x, 상위 16 개만 본 것과 똑같았다.** hsc 의 병목이 아니다.
   (cascode 는 반대다 — 성공 11/68 이고 전수로 보면 합 2.360 -> 2.327.
   같은 처방이 아니다.)
3. 영역 종횡비 -> 정확한 값(0.574)을 직접 먹였더니 legalize 가 전부 실패했다.

진짜 병목은 **후보 생성**이었고 뿌리는 하위 모듈이었다. 면적은 ALIGN 급인데
(0.95~1.07x) 모양이 홀쭉했다:

```
모듈                  우리          ALIGN         면적비  종횡비
PRIMITIVE_38447703    2240x5880     3520x3528     1.06x   0.38 vs 1.00
PRIMITIVE_98739713    2240x3528     3520x2352     0.95x   0.63 vs 1.50
PRIMITIVE_8946161     1600x3528     2240x2352     1.07x   0.45 vs 0.95
```

하위 모듈 점수에 **종횡비가 없다** — 면적과 배선만 본다. 그런데 하위에서는
모양이 곧 상위의 입력이다. 그게 최상위 구조 하한을 4800x15288 (ar 0.31) 로
만들고 (ALIGN 6080x10584, ar 0.57), 영역 후보가 전부 그 주변에서만 나온다.

고친 방법은 점수에 종횡비 벌점을 넣는 게 아니라 **고르지 않는 것**이다.
하위 모듈의 점수는 자기 면적과 내부 배선만 본다 — 상위가 어떻게 쓸지는
**그 자리에서 판단할 수 없다.** 판단할 수 있는 건 상위다. 그러니 고르지 말고
넘긴다. 종횡비별로 몇 개 내어 상위의 **변이**로 등록하면 이미 있는 변이 선택
기계가 그대로 고른다. ALIGN 도 같은 구조다
(`PRIMITIVE_38447703_PG0_0` ~ `_PG0_3`).

### 넘길 때 "좋은 것"이 아니라 "서로 다른 것"을 골라야 한다 (두 번 더 틀렸다)

**(8) `alternatives` 를 점수 순으로 잘랐다.** 종횡비가 한쪽으로 쏠린다.
`PRIMITIVE_98739713` 의 점수 상위 3 개가 0.63 / 0.27 / 0.37 로 전부 홀쭉했고
ALIGN 이 쓰는 1.50 은 4 위였다 — **상위가 평가할 기회조차 없었다.**
`spreadShapes` 로 종횡비 범위를 고르게 덮게 고쳤다 (양 끝 + 점수 최선 보장).

**(9) legalize 를 연속단계 점수 상위 N 개에만 돌렸다.** 예산이 늘면 후보 풀은
커지는데 N 은 고정이라 잘 수렴한 것들끼리 몰려 **모양 자체가 줄어든다**:

```
고치기 전   batch  96  모양 후보 6 개  종횡비 0.27~1.50
           batch 288  모양 후보 4 개  종횡비 0.37~1.50   <- 줄어든다
고친 뒤     batch  96  모양 후보 7 개  종횡비 0.12~1.50
           batch 288  모양 후보 7 개  종횡비 0.14~1.50   <- 유지
```

legalize 예산을 **반은 깊이(점수 상위), 반은 너비(설정마다 하나씩)** 로 나누게
고쳤다. 모양은 영역 후보가 정하므로 설정을 고루 훑으면 퍼진다.

너비만 쓰면 반대로 손해다 — 전부 설정 순회로 바꿨더니 평면 설계인
telescopic_ota 의 HPWL 이 0.987 -> 1.079 로 밀렸다. 거기엔 모양 다양성이
필요 없고 점수 상위가 밀려나는 손해만 남는다.

### "많이 샘플링하면 찾아지지 않나" — 고치기 전에는 아니었다

```
hsc   batch  96   1.053 / 1.333   오라클 합 2.386
      batch 288   1.000 / 1.000   오라클 합 2.000
      batch 864   1.140 / 1.393   오라클 합 2.533   <- 다시 나빠진다
```

**오라클(생성된 후보 중 절대 최선)까지 나빠졌다.** 샘플을 늘렸는데 오라클이
나빠지려면 후보 집합 자체가 달라진 것뿐이다 — 위 (9) 가 원인이었다.
고친 뒤에는 단조롭다:

```
hsc       batch  96  1.053 / 1.333     batch 288  0.965 / 1.192
cascode   batch  96  1.111 / 1.304     batch 288  1.099 / 1.264
```

batch 288 의 hsc 면적 0.965 는 **ALIGN 보다 좋다.**

```
hsc     시작                  1.316x / 1.826x
        정규화 버그 수정        1.140x / 1.459x
        하위 모듈 여러 모양     1.053x / 1.333x
```

모양을 몇 개나 올릴지(`subVariants`)는 3 이 맞다. 5 로 늘려도 같고,
**2 는 오히려 나빴다**:

```
hsc   subVariants 1   1.140 / 1.459   조합   4
                  2   1.228 / 1.502   조합  32   <- 나빠진다
                  3   1.053 / 1.333   조합 108
                  5   1.053 / 1.341   조합 400
```

단조롭지 않은 이유는 `per = floor(batch/configs)` 다. 설정이 batch 보다 많아지면
전부 시작점 1 개가 되어 탐색이 얕아지고 결과가 시끄러워진다. 깊이를 고정할
방법이 필요하다 — 남은 일에 적어둔다.

cascode 는 하위 모듈이 모양을 2 개만 내서 2/3/5 가 전부 같다
(1.111 / 1.304). 면적을 얻고 배선을 내주는 근소한 맞바꿈이다.

### 제약을 더 넣어야 하나 — 두 종류로 갈린다

| 제약 | 종류 | 들어갈 자리 |
|---|---|---|
| `SymmetricBlocks`, `Align`, `Boundary` | 등식 | 영공간 `z = z0 + N theta` (이미 있음) |
| `Order`, `Spread` | **부등식** | legalize 의 LP (이미 있음) |

`AspectRatio` 는 영역 종횡비 범위로 쓰고 있다. 새 솔버가 필요한 것은 없다.

### 꾸러미 크기

`fixtures/design/` 이 15 MB 였다. `2_primitives/*.gds.json` 이 대부분이었는데
배치기는 안 읽는다 (`bbox` 와 `netType=="pin"` 인 terminals 만 본다).
빼니 **460 KB**.

### 예산을 올릴 때의 권장

기본 batch 96 은 5 예제를 8~95 초에 끝낸다. 계층 설계(hsc, cascode)는 288 로
올리면 눈에 띄게 좋아진다 (hsc 면적 1.053 -> 0.965, 시간 90s -> 228s).
평면 설계는 96 에서 이미 수렴해 있어 올려도 별로 안 변한다.

---

## S15 — 격자 스냅 -> handoff -> 배선 -> GDS -> DRC  **5/5 통과**

S14 의 "남은 것" 첫 줄이 블로커였다. 닫았다.

### 격자 스냅 — LP 에 정수를 얹었다

ALIGN 배선기는 블록 원점 oX 가 금속 pitch 의 배수여야 받는다 (M1 80, M2 84).
아니면 `Wire to color is offgrid` 로 거부한다.

    X_i - ax_i = qx * kx_i,   kx_i 정수      (ax = sX * (tx0+tx1)/2)

풀고 나서 반올림하면 안 된다 — 대칭이 깨지고 없앴던 겹침이 되살아난다.
파이썬은 MILP 안에 정수 변수로 넣었는데 우리 JS 는 LP 라 **다이빙 분기한정**을
붙였다: LP 완화해의 k 중 가장 분수적인 것을 반올림해 고정하고 다시 푼다.
막히면 반대쪽, 그것도 막히면 한 단계 되짚는다. 블록 11 개면 정수 22 개라
몇 번이면 끝난다.

**앵커 부호 문제**는 실측으로 풀렸다. ax 는 sX 를 타는데 반전은 legalize 뒤에
정해진다. 그런데 예제 PDK 의 템플릿 **59 개 전부** w/2 와 h/2 가 pitch 의
배수라 부호를 곱해도 격자 조건이 같다. sX=+1 로 잡고 결과를 `gridOffgrid` 로
검증한다.

실측 — 공짜다:

```
예제                          격자밖        면적          HPWL
telescopic_ota              5 -> 0     1.000 그대로   0.987 그대로
current_mirror_ota          5 -> 0     1.000 그대로   1.000 그대로
five_transistor_ota         3 -> 0     0.862 그대로   1.404 그대로
high_speed_comparator      10 -> 0     1.053 그대로   1.330 그대로
cascode_current_mirror_ota 11 -> 0     1.111 그대로   1.304 -> 1.306
```

### handoff — 덤프에 심는다

ALIGN 의 인수인계는 `3_pnr/__placer_dump__.json` 이다.
`gpuplace/handoff.py` 와 다른 점: **우리는 ALIGN 과 다른 변이를 고를 수 있다.**
그러면 좌표만 바꿔선 안 되고 `concrete_template_name` 도 바꿔야 하는데, 그
템플릿의 정의가 그 대안의 `leaves` 에 없을 수 있다.

실측으로 `leaves` 항목은 `2_primitives/<concrete>.json` 에서 그대로 만들 수 있다:

```
leaves[i]    = {abstract_name, concrete_name, bbox, terminals:[{name, rect}]}
2_primitives = {bbox, terminals:[{netName, netType, layer, rect}, ...]}
             -> netType == "pin" 인 것만 골라 netName -> name
```

그래서 leaves 를 통째로 다시 짠다. 어떤 변이를 골라도 된다.

**함정 하나.** `--flow_stop 3_pnr:place` 로 끊으면 `gui` 단계가 쓰는
`__placements_to_run__.json` 이 없어 route 가 `FileNotFoundError` 로 죽는다.
주입기가 같이 써준다.

### DRC — 기준선과 나란히

```
예제                          GDS    DRC (우리)   DRC (ALIGN 자신)
telescopic_ota                80K        0              0
current_mirror_ota            80K        4              4     <- 같다
five_transistor_ota           96K        0              0
high_speed_comparator        172K        0              0
cascode_current_mirror_ota   204K        4              6     <- 우리가 적다
```

current_mirror_ota 의 4 건은 `DIFFERENT WIDTH` 인데 **ALIGN 자신의 배치에서도
똑같이 4 건** 나온다. 우리 탓이 아니다. SHORT·OPEN 은 양쪽 다 0.

기준선을 같이 재지 않으면 "에러 4건"이 우리 탓인지 알 수 없다. 한 번
오독해서 시간을 버린 적이 있어 이번엔 `route-align.sh` 로 같은 조건에서
ALIGN 자신도 돌렸다.

### 계층에서 걸린 것 셋

계층 설계(hsc, cascode)는 최상위만 심어선 안 된다. 세 번 걸렸다.

**(1) 하위 모듈의 module 항목.** 최상위 대안은 자기가 쓰는 하위 모듈의
module 항목(bbox + 인스턴스)까지 품는다. 거기도 우리 배치로 바꿔야 한다.
우리 이름(`<모듈>__v0`)을 덤프 이름(`<모듈>_PG0_2`)으로 짝지어 쓴다.

**(2) 하위 모듈의 *자기* 대안.** 배선기는 하위 모듈을 그 모듈의 대안 항목에서
**따로** 읽는다. 최상위 안의 사본만 고치면
`setPlacementInfoFromJson ERROR : concrete_template_name: NMOS_4T_85599263_X8_Y2
not found.` 로 죽는다 — 우리가 고른 leaf 변이가 그쪽 leaves 에 없기 때문이다.
거기 module 항목과 leaves 를 같이 고쳐야 한다.
그리고 참조되지 않게 된 낡은 module 항목은 걷어내야 한다.

**(3) `__v{k}` 는 `alternatives[k]` 가 아니다.** `placeHierarchy` 는
`spreadShapes(alternatives, subVariants)` 로 **종횡비를 퍼뜨려** 고른 목록에
번호를 매긴다. 내보내기가 `alternatives[k]` 를 집으면 상위가 가정한 크기와
어긋나 하위 모듈 **내용이 상위에서 겹친다**:
`AssertionError: Leaves ... intersect`.
cascode 가 통과하고 hsc 만 죽은 이유가 이것이다 — `spreadShapes` 는 점수
최선(`alternatives[0]`)을 항상 포함하므로 `__v0` 은 우연히 맞았고,
hsc 가 쓰는 `__v1` 에서 어긋났다.

### 남은 것
- 브라우저에서 배선 — PnR wasm 은 빌드·import 되지만 실행한 적이 없다.
  메모리는 계측상 문제없어 보인다 (C++ 배선기 본체 72 MB; 8.4 GB 는 배선
  단계가 배치를 다시 돌리던 비용이고 우리 경로엔 그게 없다)
- `Spread` / `Boundary` 제약, `Order` 의 `abut`
- 설정당 시작점이 1 개로 줄어드는 구간에서 깊이 고정
- legalize 방향 조합 실패 (cascode 11/68) 재시도 — 단, hsc 에서는 병목이
  아니었다. 예제마다 병목이 다르다
- 앞단·배치·배선을 한 워커에서 이어 붙이기
