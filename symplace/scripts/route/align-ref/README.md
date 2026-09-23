# align-ref — ALIGN 배선기의 기준값과 재현 도구

배선기를 ALIGN C++ 알고리즘 그대로 옮기는 일([PLAN-route-align.md](../../../PLAN-route-align.md))의
잣대다. 전부 node 하네스(`../node/`, Pyodide + 축소 PnR 휠)로 ALIGN 을 돌려 뜬 값과 대조했다.
받은 것과 덤프는 저장소 밖(`~/.cache/symplace/`)에 둔다. 페이지는 이 폴더를 안 쓴다.

| 폴더 | 무엇 | 대조 결과 (2026-09-23) |
|---|---|---|
| `tap/` | `RouteWork` 앞뒤로 hierNode·Drc_info 를 JSON 으로 뜬다 (`runall.mjs`, `tap.py`). `vary.mjs` 는 배치기 설정을 바꾼 배치로 더 모은다 (`~/.cache/symplace/tap-vary/`) | 5 예제 x (ALIGN 배치, 우리 배치) = 10 회, 106 MB |
| `db/` | ALIGN 이 배선기에 넘기는 DB 를 단계마다 뜨고(`dumphn.mjs`, `instrument.py`), 파이썬으로 다시 짓는다 (`drc_info.py`, `build_db.py`, `place_inject.py`, `checkin.py`, `wires.py`) | 5 예제 10 모듈에서 배선기 입력이 필드마다 같다. 도형 합성용 wires 도 순서까지 같다 |
| `power/` | 전원 격자(모드 2)·전원 배선(모드 3)의 파이썬 시제품 (`pg_proto.py`, `pr_proto.py`)과 대조 | 10/10 + M5/M6 도형을 끼워 넣은 3 회, 비아 중복·bbox 까지 같다 |
| `ilp/` | 전역 배선 ILP 재현(`harness.cpp`), 기준 휠의 lp_solve 로 풀기(`wasm_lp.mjs`), lp_solve 를 clang wasm32-wasi 로 빌드해 대조(`wasi/`) | 합성 ILP 410 개에서 반환값·목적값·변수 전부 비트까지 같다 |
| `wasm/` | 기준 휠 바이너리 읽기 (import/export, 함수 안의 호출) — NDEBUG, NRVO 확인에 썼다 | — |

```bash
cd symplace/scripts/route
node align-ref/tap/runall.mjs [예제]             # -> ~/.cache/symplace/tap/<예제>/{align,ours}/
python3 align-ref/power/pg_check.py              # 모드 2 시제품 vs 탭 (ALL PASS)
python3 align-ref/power/pr_check.py              # 모드 3 시제품 vs 탭 (ALL PASS)
node align-ref/db/dumphn.mjs <예제> ~/.cache/symplace/aligndb/<예제>
node -e 'import("../../../src/route/pdk.mjs").then(m=>process.stdout.write(JSON.stringify(m.MOCK_PDK)))' > /tmp/layers.json
python3 align-ref/db/build_db.py ~/.cache/symplace/aligndb/<예제> /tmp/layers.json   # ALL OK
python3 align-ref/db/wires.py <11_..._route_out_<모듈>.json> ~/.cache/symplace/check/<예제>.json
align-ref/ilp/build-native.sh                     # 합성 ILP 생성기 (lp_solve 를 같이 빌드)
DUMP=lps.jsonl ~/.cache/symplace/lpsolve-wasi/native/harness 1 12 400   # 씨앗 1..399, 넷 12 개
node align-ref/ilp/wasm_lp.mjs lps.jsonl ref.jsonl                 # 기준 휠의 lp_solve 로
align-ref/ilp/wasi/build.sh && python3 align-ref/ilp/wasi/check.py lps.jsonl ref.jsonl
```

- 네이티브 lp_solve 는 `-DREALXP=__float128` 로 빌드한다. wasm32 의 long double 은 binary128 이라,
  x86-64 의 80 비트로 두면 목적값 끝자리가 가끔 다르다 (고른 후보는 같았다).
- `db/`, `power/`, `ilp/harness.cpp`, `wasm/` 은 조사 중에 쓴 것을 그대로 옮겼다 (주석은 영어).
  이식의 명세로 쓰고, JS/Rust 로 옮기면서 이 파일들과 결과를 맞춘다.
