# 배치·배선 비주얼 편집과 토폴로지 유지 최적화 — 계획 (2026-09-24)

페이지의 Placement·Routing 보기는 지금 **보기만** 한다. 배치기가 놓은 블록과 배선기가 이은 금속을 그리고,
확대·이동이 된다. 이 문서는 거기에 **손으로 고치는 길**을 내는 계획이다. 블록을 끌어 옮기고 뒤집고 변이를
바꾸며, 배선 조각을 옆 트랙으로 옮기고 넷을 고정한 채 나머지를 다시 배선한다. 고친 뒤에는 **사용자가 정한
위상(topology)을 그대로 둔 채** 나머지를 최적화한다. 배치는 겹침을 없애고 격자에 앉히며 압축하고, 배선은
조각을 미끄러뜨려 길이를 줄인다.

원칙 셋.

1. **편집은 제약을 따라 움직인다.** 거울 쌍의 한쪽을 끌면 짝이 거울로 따라오고, 축 위 블록은 축을 따라서만
   미끄러진다. 편집하는 동안에도 대칭 잔차는 0 이다. 배치기가 쓰는 영공간 매개화 `z = z0 + N theta` 위에서
   끌기 때문이다 (`src/subspace.mjs`).
2. **최적화는 사용자가 정한 위상 안에서만 한다.** 배치의 위상은 쌍마다의 상대 위치(왼/오/아래/위), 배선의 위상은
   넷의 조각 그래프(층, 조각의 차례, 비아, 핀 접속)다. 최적화기는 그것을 바꾸지 않는다. 바꾸는 것은 좌표뿐이다.
3. **새 솔버도, 새 의존도, wasm 재빌드도 없다.** 배치 쪽은 `src/legalize.mjs` 의 LP(theta 공간, 격자 정수 분기)가
   그대로 최적화기다. 배선 쪽은 같은 심플렉스(`src/lp.mjs`)로 1 차원 압축을 풀고, 검사는 `check.mjs`, GDS 는
   `gds.mjs` 가 그대로 한다. 고정 넷은 배선기 입력에 장애물로 심는다.

실측(3.5 절, 4.7 절, 스크립트는 `symplace/scripts/edit/`)으로 확인한 것.

- 편집 뒤 토폴로지 유지 legalize: 예제 넷(블록 3~11)에서 편집 6 종이 겹침 0, 대칭 잔차 1e-12 아래, 격자 밖 0,
  편집 좌표의 쌍 관계 보존 100 %, 1~80 ms. 못 푼 것은 `Order` 를 어긴 자리 바꾸기 하나뿐이고, 그건 뜻대로 실패한 것이다.
- 계층 설계에서 페이지가 워커의 결과와 편집 키트(hsc 1.8 KB)만으로 최상위 문제(크기·핀·영공간)를 **정확히** 다시 짓는다.
- 토폴로지를 유지한 채 변이만 다시 고르면 high_speed_comparator 가 6080x11760 에서 **6080x10584** 로 (면적x배선
  0.862 배). 이건 ALIGN 이 낸 bbox 다 (`web/placer/README.md` 의 구조 힌트 절).
- 배선 조각을 옮기고 배선기 없이 다시 검사·GDS: 4~44 ms + 3~30 ms. 넷 하나를 고정하고 나머지를 다시 배선: 배선기
  28~190 ms, DRC/LVS 가 기준으로 돌아온다.

---

## 1. 지금 페이지에 있는 것과 없는 것

| | 있다 | 없다 |
|---|---|---|
| 배치 | `ours` = {rects[{name, concrete, x, y, w, h, sx, sy}], bbox, axes, subModules, 지표}. `view.mjs` 의 `drawPanel` 이 그린다 | 배치 **문제** (z0, N, 배정, 영역, 분리 방향) — 워커 안에서 끝나고 사라진다. 캔버스 hit-test. 되돌리기 |
| 배선 | `routed` = geo.terminals (층·넷·사각형의 평면 목록), `drawRouted` 가 층 묶음으로 그린다 | 넷 단위 모델 (path_metal, path_via, 핀). 워커 세션 (다시 검사하려면 hierNode 와 하위 모듈 도형이 있어야 한다) |
| 워커 | `worker.mjs` 는 `runJob` 한 종류, `routeworker.mjs` 는 route 한 종류 | 편집을 받는 메시지 |
| 조작 | 휠 확대, 끌어 이동, 더블클릭 초기화, 회로도의 hover | 고르기, 끌어 옮기기, 인스펙터 |

두 보기의 좌표 변환(`fitOf`, `mapper`)과 패널 자리(`layout()`)는 그대로 쓴다. 회로도의 `hitSchematic` 이 hover 를
어떻게 하는지가 본이다 — 마지막으로 그린 변환(`lastMap`)을 쥐고 화면 좌표를 되돌린다.

## 2. 위상이란

**배치.** 배치기는 이미 위상을 다룬다. `chooseDirections` 가 연속해에서 쌍마다 분리 방향(왼/오/아래/위) 하나를 읽어
박고, `legalize` 가 그 방향을 지키며 LP 를 푼다. 등식 제약(대칭, Align)은 영공간 `N` 안에 있어 어떤 theta 에서도 지켜지고,
부등식(`Order`)은 `forced` 로 방향에 박힌다. 그러므로 **"편집한 배치의 위상" = 편집 좌표에서 읽은 쌍 관계**이고,
**"위상 유지 최적화" = 그 관계를 박은 legalize** 다. 연속해 대신 편집 좌표를 참조로 줄 뿐, 배치기의 마지막 단계와
같은 코드다. 겹치게 놓은 쌍은 관계가 없다 — 가장 적게 미는 쪽으로 판정된다.

**배선.** ALIGN 상세 배선의 결과는 넷마다 `path_metal`(층마다 곧은 토막, 층의 선호 방향으로만)과 `path_via`(층을 바꾸는 자리)다.
같은 층·같은 트랙에서 닿는 토막을 하나로 이으면 넷은 **조각 그래프**가 된다 — 꼭짓점은 비아와 핀 접속, 변은 조각.
위상은 이 그래프다: 조각의 수와 층, 조각끼리의 차례, 비아의 수, 어느 핀에 어느 조각이 닿는가. 조각의 트랙 좌표는
위상이 아니다. **"위상 유지 압축" = 그래프를 두고 트랙 좌표만 다시 고르는 것**이다.

---

## 3. 배치 편집

### 3.1 편집 키트 — 페이지가 문제를 다시 짓는다

워커의 `done` 메시지에는 좌표만 있다. 편집기는 `z0`, `N`(끌기와 정리 둘 다 theta 공간에서 한다)과 변이 후보,
반전 자유도가 필요하다. 워커에서 통째로 보내지 않고 **페이지가 다시 짓는다** — 앞단 출력(`blob`)과 `done` 의
`rects` 만으로 대부분 되고, 계층 설계에서 모자라는 것은 하위 모듈 변이의 합성 템플릿뿐이다.

```
워커 done 에 더하는 것 (편집 키트)
  edit: { top: 최상위 모듈 이름, grid: [80, 84],
          subPrimitives: { "<모듈>__v<k>": {abstract_template_name, concrete_template_name, x_cells:1, y_cells:1} },
          subTemplates:  { "<모듈>__v<k>": synthesizeTemplate(...) = {bbox, terminals} } }

페이지 (src/edit/place.mjs 의 rebuild)
  design = readDesign({ topology, primitives: {...blob.primitives, ...subPrimitives},
                        templates: {...blob.templates, ...subTemplates}, top })
  groups = variantGroups(design)
  assignment[g] = groups[g].choices.indexOf(rects[groups[g].members[0]].concrete)
  P = buildProblem(design, groups, assignment)                 // 이름·크기·핀·넷
  { sysm } = build(P.constraints, P.names, sizes) -> A, b -> N = nullspace(A), z0 = particular(A, b)
  theta = N^T (z - z0)      z = [cx, cy, ..., 축 좌표(axes 의 at)]   (N 이 정규직교라 최소제곱 사영)
```

실측: hsc(모듈 5, 최상위 블록 10)에서 키트 템플릿 4 개 1,793 바이트, 다시 지은 문제가 배치기 안의 문제와 이름·크기·
핀 오프셋이 전부 같고(차 0), theta 를 되찾아 좌표를 다시 내면 오차 0~1e-12. 평면 설계는 키트가 빈다.

`job.mjs` 가 `subModules` 를 만들 때 이미 같은 규칙(`spreadShapes(alternatives, SUB_VARIANTS)`)으로 하위 모듈 변이를
되짚으므로, 그 자리에서 `synthesizeTemplate` 을 한 번 더 불러 키트를 채운다. 코드 한 곳(`SUB_VARIANTS`)에 기대는 것도 같다.

### 3.2 끌기 — 제약을 따라

끌기는 x 공간이 아니라 theta 공간에서 한다. 끌 블록의 두 좌표(cx, cy)를 목표로 두고, 고정할 좌표(대칭축, 잠근 블록)는
그대로 둔 채 **theta 의 변화가 가장 작은** 해를 고른다. `N` 이 정규직교라 theta 의 변화 노름 = 좌표 이동의 제곱합이다.

```
고정 행 R (축 2n+k, 잠근 블록의 2i, 2i+1),  끌기 행 D (끌 블록의 2i -> x*, 2i+1 -> y*)
1) N 의 고정 행들을 정규직교화 -> Q  ("고정 좌표를 바꾸는 방향")
2) 끌기 행마다 n_d 에서 Q 성분을 뺀다 -> n_d'.  |n_d'| = 0 이면 그 좌표는 잠겨 있다 (못 움직인다)
3) 남은 방향으로 목표에 맞춘다: theta += n_d' (target - 현재) / (n_d · n_d')   (행끼리 Gram-Schmidt 로 차례로)
```

크기가 작다. `N` 은 (2n + 축 수) x P, P 는 자유도(telescopic 7, cascode 18). 포인터 이벤트마다 부를 수 있다.

이 규칙 하나에서 나오는 행동 (실측, `scripts/edit/place.mjs` 의 편집 1~4).

| 무엇을 끌면 | 어떻게 되나 | 왜 |
|---|---|---|
| 대칭 밖(자유) 블록 | 포인터를 그대로 따라온다 | 그 행은 다른 행과 직교한다 |
| 거울 쌍의 한쪽 (hsc `X_MP7`) | 자신 (+320, +2822), 짝 `X_MP8` (-320, +2822), 축 0 | 축이 고정이라 x 는 거울, y 는 같이 |
| 축 위(자기대칭) 블록을 비스듬히 | x 는 0, y 만 움직인다 — 축을 따라 미끄러진다 | cx 행이 곧 축 행이라 Q 에 흡수된다 |
| 대칭축 (핸들) | 축과 그 그룹 전체가 같이 (hsc 10/10 블록) | 축 행의 방향 = 묶인 좌표 전부 |
| `Align h_*` 줄의 블록을 y 로 | 줄 전체가 같이 | 등식이 N 에 있다 |
| Alt 끌기 (그룹째) | 축 행을 고정하지 않고 그룹 구성원 전부에 같은 목표를 준다 | 거울 쌍을 통째로 옮기는 뜻 |

`Order` 는 부등식이라 여기 없다. 끄는 동안 `orderViolations` 로 검사해 어긴 블록을 빨갛게 칠하고 정리 때 알린다
(3.4 의 NODIRECTION). 겹침도 편집 중에는 허용하고 빨갛게만 칠한다 — 정리가 없앤다. 격자에는 안 맞춘다 — 그것도 정리 몫이다.

### 3.3 그 밖의 편집

| 편집 | 단위 | 하는 일 |
|---|---|---|
| 반전 (x, y) | `flipPlan` 의 그룹 — 거울 쌍은 `sX_B = -sX_A`, `sY` 같이; 자기대칭은 거울축 방향이 잠긴다 | 좌표는 안 바뀐다. 핀만 움직이므로 HPWL 만 다시 잰다 |
| 변이 바꾸기 | `variantGroups` 의 그룹 — 거울 쌍은 같은 변이 | 크기가 바뀐다. `buildProblem` 을 다시 짓고(z0 가 바뀐다, N 은 같다) 중심을 유지한 채 다시 사영. 겹치면 빨갛게 |
| 자리 바꾸기 | 두 블록의 중심 좌표를 서로의 목표로 | 같은 대칭 역할끼리만 (축 위 둘, 자유 둘). 거울 쌍끼리는 쌍째로 |
| 잠그기 | 블록의 두 행을 고정 행에 | 정리 때도 `cxRef` 가 아니라 등식으로 박는다 |
| 축 옮기기 | 축 핸들 끌기 | 3.2 |
| 되돌리기/다시 실행 | `rects` + 축 + 반전 스냅샷 | 편집마다 하나. 정리도 한 단계다 |
| 원래 배치로 | 워커가 낸 `done` 으로 | 배선 결과도 그 배치의 것이면 살린다 |

### 3.4 정리 — 토폴로지 유지 최적화

편집이 끝나면 좌표는 겹치고 격자 밖이다. "정리" 가 그것을 **위상은 그대로 두고** 고친다. 배치기의 legalize 그대로다.

```
settle(kit, rects, opts)
  cxE, cyE = 편집 좌표 (사영된 것)                       region = 편집 좌표의 bbox (slack 1.6, 실패하면 3)
  dirs    = chooseDirections(cxE, cyE, w, h, z0, N, forced)   // 편집 좌표에서 읽은 쌍 관계 = 위상
            opts.both 면 x·y 로 다 떨어진 쌍에 두 관계를 다 박는다 (더 엄격, 덜 움직인다)
  anchors = 반전에 맞는 격자 앵커 (sX * w/2, sY * h/2)     grid = [80, 84],  gap = blockSpacing(제약)
  r = legalize({ z0, N, n, w, h, cxRef: cxE, cyRef: cyE, region, dirs, forced, gap, grid, anchors,
                 bboxWeight: opts.compact })                  // 0 = 최소 이동만, 0.5 = 배치기 기본, 클수록 압축
  -> 겹침 0, 대칭 잔차 0 (theta 공간), 격자 위, Order 지킴, 편집 좌표에서 L1 최소 이동 + 반둘레
  지표: exactArea, hpwl(핀 경계), exactOverlap, symmetryResidual, gridOffgrid, orderViolations
```

LP 의 목적함수가 `이동거리 + bboxWeight·n·반둘레` 라 압축의 세기는 슬라이더 하나다 (`compact`, 0 ~ 2). 0 이면
"손댄 것만 고치고 나머지는 그 자리에", 배치기 기본 0.5 면 배치기가 냈을 배치로 되돌아간다 (편집 없이 정리하면 항등 —
실측 이동 0).

실패는 두 가지고 뜻이 다르다. `NODIRECTION` 은 `Order` 를 어긴 편집이다 — 어느 쌍인지 알린다 (hsc 에서 `XDP` 와 `XCCN`
을 바꾸면 그렇다: `Order(X_MN0, XDP, XCCN, XCCP)`). `INFEASIBLE` 은 관계 조합이 안 맞는 것이라 여유 영역을 넓혀
다시 풀고(1.6 -> 3, 배치기와 같다), 그래도 안 되면 `both` 를 끄고 다시 푼다.

정리 뒤에 이어지는 최적화 둘, 둘 다 위상을 안 바꾼다.

- **반전 다시 고르기** — `refineFlips` (좌표 고정, 그룹마다 2 비트 좌표하강). 사용자가 반전을 손댔으면 안 부른다.
- **변이 다시 고르기** — 배정을 전수로(128 개까지, 넘으면 추첨) 돌리며 **같은 dirs** 로 legalize 하고 점수
  `log(면적) + w·log(HPWL)` 로 줄 세운다. 방향 표는 쌍 번호로 매겨져 있어 크기가 바뀌어도 그대로 쓸 수 있고, 크기가
  바뀌어 실현 불가능해진 방향은 `chooseDirections` 의 상수차 규칙이 걸러 준다. ALIGN 이 "수열쌍마다 ILP 로 압축" 하는
  것의 우리 판이다 — 배치기는 위상을 탐색 표본에서 얻지만, 여기서는 위상이 주어져 있어 배정마다 LP 한 번이면 된다.

### 3.5 실측

`node symplace/scripts/edit/place.mjs <예제> 48` — 배치(CPU, 시작점 48, 격자) 뒤 편집 6 종을 흉내 내고 정리한다.
정리는 세 가지로 (관계 하나 = 기본, 둘 다, 관계 하나 + 압축 0). 전부 OPTIMAL, 겹침 0, 잔차 1e-12 아래, 격자 밖 0,
편집 좌표에서 성립하던 관계 보존 100 % (hsc 42~45 쌍, cascode 53~55 쌍). 시간은 telescopic 1~9 ms, hsc 12~70 ms,
cascode 17~80 ms. 아래는 압축이 달라지는 자리만.

| 예제 · 편집 | 정리 | 이동 합 | 면적 | HPWL |
|---|---|---|---|---|
| telescopic · 자유 블록을 오른쪽 위로 끌기 (+672, +941) | 하나 | 2259 | 1.422x | 0.918x |
| | 압축 0 | 865 | 1.638x | 0.997x |
| telescopic · 축 위 블록 둘 자리 바꾸기 | 하나 | 0 | 1.000x | 1.369x |
| five_transistor · 축 위 블록을 두 블록 위로 (순서 바꿈) | 하나 | 6520 | 1.015x | 1.381x |
| | 둘 다 | 3528 | 1.600x | 2.046x |
| cascode · 자유 블록 끌기 (+1536, +1478) | 하나 | 2006 | 1.000x | 1.022x |
| | 둘 다 | 726 | 1.200x | 1.059x |
| hsc · 거울 쌍 한쪽 끌기 (짝이 따라옴) | 하나 | 14752 | 1.000x | 1.000x |
| hsc · `XDP` <-> `XCCN` 자리 바꾸기 | 하나/둘 다 | — | `Order` 위반 (INFEASIBLE) | |
| 전부 · 편집 없음 | 하나 | 0 | 1.000x | 1.000x |

읽을 것 셋. (1) "관계 둘 다" 는 덜 움직이지만 압축을 막는다 — 기본은 "하나" 고, 둘 다는 "그대로 두기" 옵션이다.
(2) 자유 블록을 새 자리로 끌면 면적이 늘고 배선이 준다 (telescopic 1.42x / 0.92x). 그게 사용자가 고른 절충이고
최적화기는 그 안에서만 좋게 만든다. (3) 다른 블록 **위에** 던진 편집은 뜻이 흐릿하다 — 관계가 없는 쌍은 가장 적게 미는
쪽으로 판정되어 telescopic 에서는 원래 자리로 돌아갔다. 편집기는 끄는 동안 겹침을 빨갛게 칠하고, 순서를 바꾸려면
빈 자리에 놓거나 "자리 바꾸기" 를 쓰게 한다.

`node symplace/scripts/edit/variants.mjs <예제> 48` — 위상을 유지한 변이 재선택.

| 예제 | 배정 | 배정당 | 결과 |
|---|---|---|---|
| telescopic_ota | 8 | 2 ms | 지금 배정이 1 위 |
| five_transistor_ota | 60 | 1 ms | 지금 배정이 1 위 |
| cascode_current_mirror_ota | 8 | 26 ms | 지금 배정이 1 위 |
| high_speed_comparator | 4 (하위 모듈 변이) | 14 ms | **2 위** — 1 위는 6080x10584, HPWL 27168 (점수 -0.148, 면적x배선 0.862 배) |

평면 설계는 배치기가 이미 위상 안의 최선 배정을 골랐다. hsc 는 아니다 — 하위 모듈이 올린 모양 셋 중 상위가 고른
것이 그 위상에서는 최선이 아니었고, 위상을 고정하고 다시 고르니 ALIGN 의 bbox 가 나온다. 편집기 없이도 배치기의
마지막 단계로 넣을 만한 결과다 (6 절 P4).

### 3.6 배선과의 관계

배치를 손대면 그 배치의 배선은 더 이상 이 배치의 것이 아니다 (`run()` 이 `routed = null` 하는 것과 같다). 편집기는
`routed` 를 지우고 "Routing 다시 실행" 을 띄운다. 배선기는 처음부터 다시 돈다 (0.1~0.6 s). 옮기지 않은 블록끼리의
넷을 고정하고 나머지만 다시 배선하는 것은 4.5 의 장치로 나중에 할 수 있다 — 첫 판에는 넣지 않는다.

---

## 4. 배선 편집

### 4.1 배선 모델과 세션

배선 워커가 `geo` 와 함께 **넷 모델**을 보낸다. 최상위 모듈의 hierNode 에서 뽑고 단위는 PnRDB(nm 의 2 배) 그대로 둔다 —
배선기가 낸 좌표는 홀수일 수 있어 반으로 줄이면 못 되살린다 (`compose.mjs` 의 `offGrid` 설명). 그리기만 2 로 나눈다.

```
wires: { module: 이름, bbox: [LL.x, LL.y, UR.x, UR.y],
         nets: [{ name, port: bool,
                  pins:  [{ block, pin, layer, rect }],                   // 고른 인스턴스의 pinContacts (placed)
                  metals: [{ layer, rect, line: [[x,y],[x,y]], width }], // path_metal
                  vias:   [{ model, pos, upper, lower, via }] }],         // path_via 의 세 사각형
         power: [{ name, metals, vias }],  grid: { vdd: {metals, vias}, gnd: {...} },   // 전원 — 보기만, 장애물
         obstacles: { M1: [rect...], ... } }                              // 블록 핀·내부 금속 (층마다) — 옮길 범위 계산용
```

크기는 작다 — telescopic 넷 13 개(금속 3 개 이하), hsc 넷 10 개(최대 금속 11, 비아 30), cascode 넷 16 개.

워커는 한 판의 결과를 **세션**으로 쥔다: `routeBottomUp` 의 `res`(모듈마다 hierNode), 하위 모듈의 검사 도형 `outs`,
`prep.pnrConst`. 다시 검사할 때 배선기를 안 거치려면 이것이 있어야 한다 (`checkModule(node, {leaves, pnrConst, outs})`).
워커가 안 서서 메인 스레드로 돌린 경우에도 같은 모듈이 세션을 쥔다 (`routeOnMain` 과 같은 갈래).

### 4.2 고르기와 보기

배선 보기에서 클릭한 도형의 넷을 고른다 (`geo.terminals` 를 넷별로 한 번 묶어 둔다). 고른 넷은 층 색 그대로, 나머지는
흐리게. 한 번 더 클릭하면 조각 하나. 인스펙터에 넷 이름, 핀 수, 조각 수, 비아 수, 길이(층별), 고정 여부, DRC/LVS 에서
이 넷의 오류. 전원 넷과 전원 격자는 고를 수 있지만 옮기지 못한다 (RouteWork 2·3 의 몫이다).

### 4.3 조각 옮기기

옮기기 전에 넷을 그래프로 만든다 (`src/edit/wires.mjs`).

1. **잇기**: 같은 층·같은 트랙에서 닿거나 겹치는 `path_metal` 토막을 한 조각으로. ALIGN 은 연결마다 토막을 내고 비아를
   두 번씩 덧붙이므로(`PLAN-route-align.md` 부록 B), 같은 자리의 비아도 하나로 센다. 길이 0 토막(비아 둘러싸기)은 비아에
   붙인다.
2. **꼭짓점**: 비아(두 층의 조각을 잇는다), 핀 접속(조각이 핀 사각형과 같은 층에서 겹치거나 비아가 핀 위에 앉는다),
   조각 끝.
3. **옮길 수 있는 범위**: 조각을 층의 수직 방향으로 미는 것만 허용한다 (세로 층은 x, 가로 층은 y). 범위는 다음의 교집합.
   - 핀 접속: 같은 층 핀 위에 놓인 조각은 못 움직인다 (핀 막대가 그 방향으로 폭 40 이다). 핀 위의 비아로 닿는 조각은
     비아가 핀 사각형 안에 남는 구간.
   - 이웃 조각의 최소 길이: 옮기면 이 조각의 비아에 닿은 직교 조각이 늘거나 준다. 줄어서 `MinL` 아래로 가면 안 된다.
     (0 으로 겹쳐 비아만 쌓는 것은 첫 판에서는 막는다.)
   - 같은 층의 다른 도형: 블록 핀·내부 금속(`obstacles`), 다른 넷의 조각, 고정 넷, 전원. 폭/2 + `dist_ss`(피치 - 폭) 만큼 띄운
     구간을 뺀다. 스팬은 지금 것에 피치 하나를 더한 보수적 값으로 본다.
   - 모듈 안: `LL`, `UR`.
4. **옮기기**: 조각의 트랙 좌표를 바꾸고, 그 조각의 비아 전부를 같이 옮기고, 그 비아에 닿은 직교 조각의 끝을 새 자리로
   늘이거나 줄인다. 이은 조각을 다시 `path_metal`(조각마다 토막 하나, `LinePoint` 두 점, `MetalRect`)과 `path_via`(비아마다
   `Via_model` 로 세 사각형 — `pnrdb.mjs` 의 `placeViaModel` 과 같다)로 편다.

끄는 동안 허용 구간을 띠로 그리고 트랙(`metalGrids`: 층마다 offset + k·pitch)에 스냅한다. 화살표 키는 한 트랙씩.

### 4.4 검사와 GDS 다시 — 배선기 없이

조각을 옮긴 뒤에는 배선기를 부르지 않는다. 워커의 세션에서 최상위 hierNode 의 그 넷 `path_metal`·`path_via` 만 바꾸고
`checkModule` 을 다시 돌린다 — 도형 합성(`composeModule`), DRC/LVS(`check`), 그리고 `topGds`. 페이지는 같은 `route`
모양의 메시지를 받으므로 그림·DRC 표·내려받기가 그대로 갱신된다. 검사기가 최종 심판이다: 옮긴 뒤 오류 목록이 늘면
빨갛게 표시하고, 원하면 되돌린다.

### 4.5 넷 고정과 재배선

배선기(Rust)는 모듈 하나를 처음부터 배선한다. 넷 하나를 손댄 채 나머지를 다시 배선하려면 그 넷을 **고정**해야 하는데,
wasm 을 안 바꾸고 된다 (실측 4.7 B).

```
고정 넷 f 마다 (JS, routeBottomUp 의 routeModule 앞에서 최상위 일감을 손본다)
  job.node.DoNotRoute += f                                  // 상세 배선이 이 넷을 건너뛴다 (dr/mod.rs)
  블록 하나의 instance[selected].interMetals += f 의 path_metal 사각형, path_via 의 위·아래 사각형
  interVias += f 의 path_via                                // 블록 내부 금속·비아는 모드 4 의 용량과 모드 5 의 장애물이다
배선 뒤 (applyRecord 다음)
  node.Nets[f].path_metal / path_via = 고정한 경로            // 배선기는 이 넷을 비워서 돌려준다
  -> 도형 합성이 그 경로를 "path_metal" 로 그리고, LVS 가 OPEN/SHORT 를 본다
```

전역 배선(모드 4)은 DoNotRoute 넷에도 후보를 만들고 ILP 에 넣는다 — 용량을 조금 더 쓰는 것뿐이고 결과에 해가 없다.
장애물이 `interMetals` 를 거쳐 들어가는 것은 편법이다. 배선기가 실제로 읽는 자리라 결과는 맞지만, 다음에 wasm 을
다시 빌드할 때 `Job` 에 `obstacles: [Contact]` 를 더해 `getData` 가 가짜 블록으로 접게 한다 (Rust 는 서너 줄, JS 는 `jobNode`
한 줄). 빌드에는 lp_solve C 소스 내려받기가 든다 (`alignroute/fetch-lpsolve.sh`) — 그래서 먼저 JS 로 간다.

쓰임 셋. (a) **손댄 넷 고정, 나머지 재배선** — 조각을 옮긴 넷은 자동으로 고정된다. (b) **이 넷만 다시 배선** — 나머지 전부를
고정하고 이 넷만 배선기에 맡긴다 (rip-up). (c) 나중에, 배치 편집 뒤 안 움직인 블록끼리의 넷 고정.

고정 넷이 있으면 다른 넷의 결과가 달라질 수 있다 — 장애물이 처음부터 있고, 배선 차례가 달라서다 (hsc 에서 `VIN_D` 를
고정하니 다른 넷 2/9 가 바뀌었다). 편집은 ALIGN 동일성을 내려놓는 모드다. 편집이 없는 길(페이지의 "Routing 실행",
`test/*`)은 그대로다.

### 4.6 정돈 — 토폴로지 유지 압축

넷 하나(또는 최상위 전부)의 조각 그래프를 두고 트랙 좌표만 다시 고른다. LP 하나다 (`src/edit/compact.mjs`, `lp.mjs` 로).

```
변수   조각 s 의 트랙 좌표 t_s  (세로 층 x, 가로 층 y),   t_s = offset_L + pitch_L · k_s,  k_s 정수
       비아에는 변수가 없다 — 만나는 두 조각의 (t_a, t_b) 가 자리다
목적   sum |끝 - 끝|  (조각 길이 합; 끝은 이웃 조각의 t 거나 핀 좌표)  +  w · sum |t_s - t_s^0|  (지금 자리에서 덜)
제약   핀 접속       같은 층 핀 위의 조각은 t_s 고정, 핀 위 비아는 핀 사각형 안
       최소 길이     끝 - 끝 >= MinL_L   (부호는 지금 그대로 = 위상)
       같은 층 나란한 조각 (스팬이 겹치는 것)   t_j - t_i >= (w_i + w_j)/2 + dist_ss_L   (i 가 지금 왼/아래인 쪽)
       고정 도형     블록 핀·내부 금속, 다른 넷, 고정 넷, 전원 — 같은 층에서 지금과 같은 쪽에 같은 간격으로
       모듈 안       LL + w/2 <= t <= UR - w/2
```

L1 항은 legalize 처럼 보조 변수로, 정수 `k` 는 legalize 의 다이빙 분기 그대로다. 크기는 hsc 최상위 신호 금속 46 토막을
이으면 조각 30 개 안팎 — 배치 LP 보다 작다. 대칭 넷(`SymmetricNets`)은 두 넷의 그래프가 거울상일 때만 `t_a + t_b = 2·축`
등식으로 묶는 스위치를 둔다 (ALIGN 배선기는 약하게 당길 뿐이라 거울상이 아닐 수 있다).

풀고 나서 4.4 로 다시 검사한다. **오류 목록이 기준보다 늘지 않을 때만 받는다** — 배치기의 `refineDirections` 가 점수가
좋아질 때만 받는 것과 같은 규칙이다. 스팬을 보수적으로 잡아도 끝단 간격·비아 둘러싸기까지 LP 에 다 넣지는 않으므로,
검사기가 마지막이다.

### 4.7 실측

`node symplace/scripts/edit/route.mjs <예제>` — 배치(캐시)와 배선을 한 판 돌린 뒤 A, B 를 한다.

**A. 조각 하나를 한 트랙 옮기고 배선기 없이 재검사.** 스크립트는 4.3 의 그래프 없이 "닿은 비아와 그 비아의 직교 토막" 만
같이 옮기는 거친 판이다 — 그래서 무엇이 필요한지가 오류로 드러난다.

| 예제 | 기준 (배선 전체 / 최상위 검사) | 옮긴 뒤 검사 | GDS | 결과 |
|---|---|---|---|---|
| telescopic_ota | 92~125 ms / 19 ms | 4~22 ms | 3~30 ms, 74K | 6 건 중 5 건 오류 0. 1 건(NET06, 옆 넷에 붙음) MinSpace 1 — 검사기가 잡는다 |
| high_speed_comparator | 395 ms / 44 ms | 11~34 ms | 8~21 ms, 196K | 6 건 중 2 건 오류 0. 나머지는 같은 트랙의 이어진 토막을 안 옮겨 SHORT/OPEN, 직교 토막이 짧아져 MinLength |
| cascode_current_mirror_ota | 234 ms / 24 ms | 9~15 ms | 5~16 ms, 168K | 6 건 중 4 건 기준(DIFFERENT WIDTH 3, 리프 안 Rvt)과 같음. 1 건 MinLength, 1 건 SHORT/OPEN |

실패한 것은 전부 4.3 의 잇기(같은 트랙의 토막을 한 조각으로)와 최소 길이 범위가 없어서다. 재검사·GDS 는 편집마다 부를 만큼 싸다.

**B. 넷 하나를 고정하고 나머지를 다시 배선, 경로를 되붙인 뒤 검사.**

| 예제 | 고정한 넷 | 배선기 | 고정 넷의 배선기 출력 | 되붙인 뒤 DRC/LVS (기준) | 다른 넷이 바뀐 수 |
|---|---|---|---|---|---|
| telescopic_ota | NET10, NET012, NET06 | 28~38 ms | 비어 있음 | 0 (0) | 0/12 |
| high_speed_comparator | VIN_D | 190 ms | 비어 있음 | 0 (0) | 2/9 |
| | VCOM, VIP_D | 184~187 ms | 비어 있음 | 0 (0) | 0/9 |
| cascode_current_mirror_ota | VBIASND, VOUTP, VBIASN | 143~156 ms | 비어 있음 | 3 (3) | 0/15 |

---

## 5. 페이지

### 5.1 조작

캔버스 제목 줄에 **보기 / 편집** 토글 (`.seg`, Placement·Routing 보기에서만). 편집 모드에서 커서가 바뀌고 빈 자리를 끌면
이동, 휠은 확대 그대로. 더블클릭 초기화는 빈 자리에서만.

| | Placement 편집 | Routing 편집 |
|---|---|---|
| 클릭 | 블록·축 핸들 고르기 (Shift 로 여럿) | 넷 고르기, 다시 클릭하면 조각 |
| 끌기 | 3.2 의 사영 (축 고정; Alt 는 그룹째) | 조각을 층 수직 방향으로, 허용 띠 안에서 트랙에 스냅 |
| 화살표 | 한 격자(80/84)씩 | 한 트랙씩 |
| F / V | x / y 반전 (그룹 단위) | F 넷 고정/해제 |
| R | — | 이 넷만 다시 배선 |
| Enter | 정리 (3.4) | 정돈 — 이 넷 (Shift 는 전부) |
| Z / Y | 되돌리기 / 다시 실행 | 같다 |
| Esc | 고르기 해제 | 같다 |

오른쪽 열에 **편집** 카드. 고른 것의 이름과 성질(블록: abstract, 변이 드롭다운, 반전 버튼 둘, 잠금, 좌표; 넷: 핀·조각·비아·길이,
고정), 버튼(정리 / 반전 다시 / 변이 다시 / 원래대로; 다시 검사 / 이 넷 재배선 / 정돈), 압축 슬라이더, "관계 둘 다" 스위치.
"결과" 카드는 편집 중에 실시간 지표를 **기준 대비**로 보인다 — 면적, HPWL, 겹침(편집 중엔 0 이 아니다), 격자 밖, Order
위반, 그리고 정리 뒤 이동량. "Routing · GDS · DRC" 카드는 재검사 결과를 받는다.

그리기에 더하는 것 (`view.mjs` 의 `drawPanel`/`drawRouted` 에 `opt` 로): 고른 블록 테두리, 원래 자리 유령 상자, 겹침 빨강,
Order 위반 빨강, 축 핸들, 고른 블록의 넷 **플라이라인**(핀 중심을 잇는 선 — HPWL 을 눈으로 본다); 배선에서는 고른 넷
말고 흐리기, 조각 강조, 허용 띠, DRC 표식(검사기 오류의 사각형 — `check()` 의 `shorts/opens/drc` 에 좌표가 있다).

### 5.2 파일

```
src/edit/place.mjs      편집 키트 -> 문제 다시 짓기(z0, N, theta), 끌기 사영(dragTheta), 관계 읽기, 정리(settle),
                        반전 다시(refineFlips), 변이 다시(retryVariants), Order 검사, 지표
src/edit/wires.mjs      넷 모델 <-> 조각 그래프 (잇기, 꼭짓점, 옮길 범위, 옮기기, path_metal/path_via 로 펴기)
src/edit/compact.mjs    토폴로지 유지 압축 LP
src/job.mjs             done 에 편집 키트 (subPrimitives, subTemplates)
src/route/pipeline.mjs  routeDesign 이 wires 와 세션을 돌려주고, recheck(session, edits) 와 고정 넷 심기를 더한다
routeworker.mjs         kind 로 갈라 세션을 쥔다 (route | recheck | reroute)
edit.mjs                페이지 쪽 — 포인터·선택·되돌리기·인스펙터·덧칠. index.html 이 **동적 import** 한다
view.mjs                덧칠 훅 (opt 에 sel, ghost, marks, band ...) — 이름을 더할 뿐 있던 export 는 그대로
symplace/web/placer/test/edit-place.mjs, edit-wires.mjs, edit-compact.mjs, edit-page.mjs
symplace/scripts/edit/  이 문서의 실측 (place, variants, route)
```

`edit.mjs` 를 동적으로 받는 이유는 회로도 모듈과 같다 — 빌드가 없는 정적 사이트라 브라우저가 옛 모듈을 캐시에 쥔 채 새
`index.html` 만 받는 일이 있고, 그때 없는 이름을 정적 import 하면 페이지가 통째로 빈다 (`test/stale.mjs`). 편집기를 못 받아도
보기·배치·배선은 그대로 돌아야 한다.

배치 정리는 메인 스레드에서 한다 — 수십 ms 다 (3.5). 변이 다시 고르기(배정 x LP)는 128 배정이면 수 초라 배치 워커에
`{type:"retry"}` 로 준다 (`src/job.mjs` 가 `blob` 이 있으면 `runJob`, `edit` 가 있으면 `runEdit`). 배선의 재검사·재배선은
세션을 쥔 배선 워커가 한다.

### 5.3 워커 메시지

```
배치 워커
  { name, blob, batch, ... }                              -> start / progress / frame / done(+edit 키트)   (지금 그대로)
  { edit: { kit, rects, axes, flips, dirs }, retry: true } -> { type: "retry", ranking: [{assignment, score, bbox, hpwl}] }

배선 워커  (kind 가 없으면 route — 지금 페이지와 호환)
  { kind: "route", design, leaves, placement, frozen?: [{ net, metals, vias }] }
      -> { type: "route", ok, gds, geo, errors, stats, warnings, wires }              세션을 쥔다
  { kind: "recheck", edits: [{ net, metals, vias }] }
      -> { type: "route", ... }   배선기 없이 compose + check + gds (세션 없으면 error)
  { kind: "reroute", frozen: [...] }   = route 와 같되 세션의 배치·설계로
```

---

## 6. 순서와 합격선

각 단계가 커밋 하나고, 끝날 때마다 있던 검사(`symplace/README.md`)가 그대로 통과해야 한다. 편집 기능은 전부 "편집을
안 하면 지금과 같다" 를 지킨다.

| 단계 | 일 | 합격선 |
|---|---|---|
| P0 | 편집 키트와 문제 다시 짓기 (`src/edit/place.mjs` 의 rebuild) | `test/edit-place.mjs`: 예제 전부에서 다시 지은 문제가 배치기의 문제와 이름·크기·핀 오프셋이 같고, theta 를 되찾은 좌표 오차 < 1e-9 |
| P1 | 배치 보기 강화 — hit-test, 고르기, 편집 카드, 플라이라인, 되돌리기 뼈대, 편집 토글 | `test/edit-page.mjs`(Chromium): 클릭이 블록을 고르고 카드가 채워진다. 편집을 안 하면 `page.mjs` 그대로 |
| P2 | 끌기 사영, 축 핸들, 반전, 변이, 자리 바꾸기, 잠금, Order 표시 | `test/edit-place.mjs`: 3.2 표의 성질 — 거울 쌍은 거울, 축 위 블록은 축을 따라, Align 줄은 같이, 끄는 동안 잔차 < 1e-9. Order 위반이 표시된다 |
| P3 | 정리 (settle) | 예제 전부 x 편집 6 종: 겹침 0, 잔차 < 1e-9, 격자 밖 0, 편집 좌표의 관계 보존 100 %, 200 ms 안. Order 위반 편집은 NODIRECTION 과 쌍 이름 |
| P4 | 반전 다시, 변이 다시 (워커 retry) | hsc 에서 6080x10584 가 나온다. 평면 예제는 지금 배정이 1 위 (3.5 표). 배치기의 마지막 단계에도 넣을지는 이 결과로 정한다 |
| R0 | 넷 모델, 세션, recheck 메시지 | 편집 없이 recheck 한 결과(geo, errors, gds)가 route 결과와 바이트까지 같다 |
| R1 | 넷·조각 고르기, 흐리기, 카드 | `test/edit-page.mjs`: 배선 도형 클릭이 넷을 고른다 |
| R2 | 조각 그래프, 옮길 범위, 옮기기, 재검사 | `test/edit-wires.mjs`: 예제 전부, 옮길 수 있는 조각마다 ±1 트랙 — 범위 안이면 오류가 늘지 않는다, 범위 밖은 막힌다. 편집 없이 펴면 원래 path 와 같은 도형(순서는 달라도 집합이 같다) |
| R3 | 넷 고정 재배선, 이 넷만 재배선 | 고정 넷 되붙인 뒤 DRC/LVS <= 기준, 고정 넷 도형 그대로 (4.7 B 표) |
| R4 | 정돈 (compact) | `test/edit-compact.mjs`: 조각 수·층·차례·비아 수 그대로, 길이 합 <= 전, 오류 안 늘어남. 늘면 되돌린다 |
| D | README 의 "쓰는 법" 에 편집 절, 이 문서에 결과 | |

P0~P4 와 R0~R4 는 서로 독립이라 나란히 갈 수 있다. P3 이 제일 값지고 (배치의 알맹이가 이미 있어 짧다), R2 가 제일 길다
(조각 그래프와 범위). R3 은 4.5 의 실측 그대로라 짧다.

## 7. 위험과 한계

| 위험 | 대응 |
|---|---|
| 큰 설계의 LP — 쌍이 n² 이다 (powertrain_binary 63 블록, 쌍 1,953; 지금 예제는 최대 55) | 정리에는 분리 관계의 추이적 축약만 넣는다 (같은 축에서 i<j<k 면 i<k 는 생략). 그래도 느리면 워커로. 먼저 잰다 |
| 하위 모듈 안은 못 고친다 | 첫 판은 최상위만 — 하위 모듈은 블록이다. 나중에 그 모듈의 문제로 내려가 고치고 합성 템플릿을 다시 만들어 상위를 정리 (P5) |
| 전원 넷·전원 격자 편집 없음 | 보기와 장애물로만. 모드 2·3 은 최상위 배선 마지막에 돌아 신호 배선을 피한다 — 신호를 옮기면 전원 배선이 어긋날 수 있어, 재검사가 OPEN 을 알린다. 그때는 "다시 배선" (전원까지) |
| 고정 넷이 다른 넷의 결과를 바꾼다 (4.5) | 편집은 ALIGN 동일성을 내려놓는 모드라고 적는다. 편집 없는 길과 그 검사는 그대로 |
| 배치기가 모르는 제약 (`Spread`, `Boundary`, `SameTemplate`, `Order` 의 `abut`) | 편집기도 모른다 — 지금처럼 "무시한 제약" 으로 보인다 |
| 반전을 바꾸면 저항·커패시터 잎이 격자 밖으로 갈 수 있다 (`w/2` 가 피치 배수가 아니다) | 반전 뒤 격자 밖이면 정리를 다시 (앵커가 부호를 따른다). 배치기와 같다 |
| 겹치게 던진 편집의 뜻이 흐릿하다 (3.5) | 끄는 동안 겹침을 칠하고, 순서 바꾸기는 빈 자리 놓기와 자리 바꾸기로 |
| 옛 모듈 캐시 (`test/stale.mjs`) | `edit.mjs` 동적 import, `view.mjs` 는 있던 export 를 안 바꾼다 |
| Rust 의 `obstacles` 필드는 wasm 재빌드가 든다 | 먼저 `interMetals` 심기(JS)로 가고, 다음 빌드 때 옮긴다 |
| 편집 뒤 산출물 — 내려받은 배치·GDS 가 "배치기가 낸 것" 이 아니다 | 파일 이름에 `-edited` 를 붙이고 배치 JSON 에 `edited: true` 와 편집 수를 적는다. "결과는 이 자리에서 만든다" 는 그대로다 |

## 부록 — 실측 스크립트

```bash
node symplace/scripts/edit/place.mjs telescopic_ota 48        # 3.5 첫 표: 편집 6 종 x 정리 3 가지
node symplace/scripts/edit/variants.mjs high_speed_comparator 48   # 3.1 키트 검증 + 3.5 둘째 표
node symplace/scripts/edit/route.mjs high_speed_comparator    # 4.7 A, B (배치는 scripts/route/node 와 같은 캐시)
```

세 스크립트는 페이지가 쓰는 코드(`src/`)만 부른다. 편집기의 `dragTheta`·`settle` 은 `place.mjs` 의 것을 `src/edit/place.mjs`
로 옮기고, 이 스크립트는 그것을 부르게 바꾼 뒤 검사(`test/edit-*.mjs`)로 굳힌다.
