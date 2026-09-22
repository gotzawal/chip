# align-memory.patch

ALIGN 의 **배선 단계**가 쓰는 메모리를 줄인다. 배치 결과와 GDS 는 바뀌지 않는다.

대상: `align-analoglayout` 0.9.8 / ALIGN-public @ 8d3cc2e
건드리는 파일: `align/pnr/placer.py`, `align/pnr/router.py` (둘 다 순수 파이썬)

## 왜

`3_pnr:route` 단계의 peak RSS 를 재보니 cascode_current_mirror_ota 에서
**8,396 MB** 였다 (인스턴스 11 개짜리 회로다). 계측해 쪼개보니 내역이 이랬다.

```
파이썬 기동 + 흐름                              141 MB
router_driver 전처리 (verilog 변환)          +1,228 MB
DB 구축 (PDK JSON, LEF, verilog, semantic)      +2 MB
hierarchical_place                          +6,937 MB
  ├ PlacerIfc (외부 배치 경로)                    +1 MB
  ├ update_grid_constraints x2               +3,219 MB
  └ process_placements                       +3,718 MB
실제 C++ 배선 (전역+상세+전원, 계층 2 노드)       +72 MB
```

**C++ 라우터 자체는 72 MB 다.** 나머지는 배선 단계가 배치 기계를 다시 돌리는 비용이고,
그중 두 덩어리는 만들자마자 버려진다.

## 무엇을

### (1) `process_placements` 건너뛰기 — 3.7 GB

`router.py` 는 `hierarchical_place(...)` 의 **반환값을 받지 않는다**. DB 에 생기는
부작용(hierTree 채우기)만 쓴다. 그런데 `hierarchical_place` 는 마지막에
`process_placements` 로 배치 대안 전체를 pydantic 객체로 만들어 돌려준다.
배선 경로에서는 그걸 만들 이유가 없다.

`placer.py`:
```python
def hierarchical_place(*, DB, ..., black_box_flow, emit_placements=True):
    ...
    for idx in DB.TraverseHierTree():
        place(...)
        update_grid_constraints(...)

    if not emit_placements:          # <- 추가
        return None, None, None, None

    top_level, leaf_map, ... = process_placements(...)
```

`router.py` 의 호출부에 `emit_placements=False` 를 더한다.

### (2) `update_grid_constraints` 조기 반환 — 3.2 GB

이 함수는 계층 노드마다 `gen_placement_verilog` + `scale_placement_verilog` 로
거대한 중간물을 만든 뒤 거기서 **`PlaceOnGrid` 제약만** 뽑는다.

그런데 이 PDK 와 예제들에는 `PlaceOnGrid` 가 **하나도 없다**:
- `2_primitives/*.json` 의 `metadata.constraints` → 0 개 (정적 스캔)
- 런타임 계측 → 모든 계층 노드에서 0 개
- ALIGN 저장소 전체의 `examples/`, `pdks/` → 문자열 0 건

실제 파운드리 PDK 용 기능이다. 여기서는 3.2 GB 를 써서 빈 목록을 만든다.

건너뛰어도 되는 근거가 명확하다. `gen_constraints_for_module` 은 `PlaceOnGrid` 를
`leaves[ctn]` 과 `modules[ctn]` 에서만 가져오고, leaf 쪽은 `primitives` 의
`metadata.constraints` 에서 붙으며 module 쪽은 하위에서 전파된 것뿐이다.
따라서 `primitives` 에도 `verilog_d` 에도 `PlaceOnGrid` 가 없으면 결과는 공집합이다.
C++ `ReadPrimitiveOffsetPitch` 는 빈 배열을 0 회 순회하므로 `[]` 를 넘기는 것과
`[{name, []}]` 를 넘기는 것이 같다.

`placer.py` 에 판정 함수 `_has_place_on_grid(verilog_d, primitives)` 를 더하고,
`update_grid_constraints` 첫머리에서 없으면 곧장 반환한다.

## 측정 결과

```
예제                          전         후       감소    시간      GDS        DRC
telescopic_ota            2,712 →   776 MB   -71%  49->9s   80K=80K   0=0
high_speed_comparator     4,689 →   833 MB   -82%  33->14s  172K=172K 0=0
cascode_current_mirror    8,396 → 1,454 MB   -83%  22->13s  200K=200K 1=1
```

## 출력이 같은지

cascode GDS 를 바이트로 비교했다. 202,944 바이트 중 **70 바이트**만 다르고,
전부 BGNLIB 타임스탬프(2) + STRNAME(15) + SNAME(19) 의 자동생성 셀 이름
카운터다 (`..._20` → `..._36`, `..._24` → `..._40`).

구조 검사: 양쪽 다 구조 14 개 / 참조 15 개 / **미해결 참조 0 개**,
참조 그래프 동형, 기하(XY) 바이트 **123,624 로 동일**.
→ 레이아웃은 같다. 이름 카운터가 밀린 것뿐이다.

재현: `scripts/measure-memory.sh`

## 자동 적용이 실패하면

버전이 달라 `patch` 가 거부하면 위 (1)(2) 를 손으로 넣으면 된다. 실질 변경은
`placer.py` 에 함수 하나 + 조기 반환 두 개, `router.py` 에 인자 하나다.
