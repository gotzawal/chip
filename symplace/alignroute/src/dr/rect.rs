//! 사각형 -> 격자점, 장애물 끄기, 비아 둘러싸기·간격 (GcellDetailRouter.cpp:1704-2119, 3969-4037,
//! 4127-4665, RawRouter.cpp:104-180).
//!
//! 집합의 모양 (C++ 의 비교 함수 순서 그대로):
//!   접점 집합 (Set_x, Set_x_contact, ...)   C5 = (LL.x, LL.y, 층, UR.x, UR.y) — SinkDataComp 로 점 둘짜리
//!   점 집합 (CreatePlistSrc_Dest 안)        (x, y, 층)                        — SinkDataComp 로 점 하나짜리
//!   비아 집합 (Pset_via)                    (모형, x, y)                      — pointSetComp
use super::GcellDetailRouter;
use super::grid::{Grid, Sink};
use super::util::{FxSet, ceil_mul, floor_mul};
use std::collections::{BTreeMap, BTreeSet};
use std::ops::Bound::Excluded;

pub type C5 = (i32, i32, i32, i32, i32);
pub type P3 = (i32, i32, i32);

/// 층마다 점 집합 (C++ 의 `std::vector<std::set<point, pointXYComp>>`) — 들었나만 본다
pub type PlistSet = Vec<FxSet<(i32, i32)>>;

#[inline]
pub fn c5s(s: &Sink) -> C5 {
    (s.LL.x, s.LL.y, s.metalIdx, s.UR.x, s.UR.y)
}

/// std::set 을 lower_bound(low) 부터 upper_bound(up) 까지 돌 때, low > up 이고 둘 사이(끝 빼고)에 원소가
/// 있으면 upper_bound 가 lower_bound 보다 앞이라 C++ 은 end 너머까지 돈다 (정의되지 않은 동작) — Err.
/// 사이가 비었으면 두 반복자가 같아 아무것도 안 돈다.
fn reversed_ub<K: Ord>(low: &K, up: &K, mut between: impl FnMut() -> bool, what: &str) -> Result<(), String> {
    if low > up && between() {
        return Err(format!("{what}: 창이 거꾸로라 집합을 end 너머까지 돈다 (정의되지 않은 동작)"));
    }
    Ok(())
}

/// 반복이 한 번이라도 돌 때(run) 걸음이 0 이하면 C++ 은 끝나지 않는다
fn step_ok(step: i32, run: bool) -> Result<(), String> {
    if !run || step > 0 { Ok(()) } else { Err(format!("격자 간격 {step} 으로 도는 반복 (C++ 은 끝나지 않는다)")) }
}

/// `v % u` 의 u 가 0 이면 C++ (wasm) 은 멈춘다
fn rem_ok(u: i32) -> Result<(), String> {
    if u != 0 { Ok(()) } else { Err("격자 간격 0 으로 나눈다 (C++ 은 멈춘다)".into()) }
}

impl GcellDetailRouter<'_> {
    fn mi(&self, m: i32) -> Result<&crate::db::MetalInfo, String> {
        usize::try_from(m)
            .ok()
            .and_then(|u| self.drc_info.Metal_info.get(u))
            .ok_or_else(|| format!("GcellDetailRouter: 층 {m} 이 없다 (C++ 은 Metal_info[{m}] 을 읽는다)"))
    }

    fn cross_mi(&self, m: i32) -> Result<&crate::db::MetalInfo, String> {
        usize::try_from(m)
            .ok()
            .and_then(|u| self.cross_layer_drc_info.Metal_info.get(u))
            .ok_or_else(|| format!("std::out_of_range: vector (cross_layer_drc_info.Metal_info.at({m}))"))
    }

    /// GcellDetailRouter::ConvertRect2GridPoints (GcellDetailRouter.cpp:4127-4330), enclose_length = 0.
    /// 사각형을 제 층 격자와 이웃 층 격자의 교점 목록으로 (세로층은 끝단 간격만큼 y 로, 가로층은 x 로 불린다).
    /// 가로층의 되돌림 가지는 x 범위 끝을 y 값(newLLy)으로 구한다 (4277, 4310 줄의 버릇).
    pub(crate) fn ConvertRect2GridPoints(&self, plist: &mut [Vec<(i32, i32)>], mIdx: i32, LLx: i32, LLy: i32, URx: i32, URy: i32) -> Result<(), String> {
        let obs_l = 0;
        let obs_h = self.layerNo - 1;
        let mi = self.mi(mIdx)?;
        if plist.len() <= mIdx as usize {
            return Err(format!("std::out_of_range: vector (plist.at({mIdx}))"));
        }
        let mu = mIdx as usize;
        if mi.direct == 0 {
            let cu = mi.grid_unit_x;
            rem_ok(cu)?;
            let newLLx = LLx.wrapping_sub(cu).wrapping_add(mi.width / 2);
            let newURx = URx.wrapping_add(cu).wrapping_sub(mi.width / 2);
            let boundX = bound(newLLx, cu);
            step_ok(cu, boundX < newURx)?;
            let mut x = boundX;
            while x < newURx {
                for (on, nb) in [(mIdx != obs_l, mIdx - 1), (mIdx != obs_h, mIdx + 1)] {
                    if !on {
                        continue;
                    }
                    let nu = self.cross_mi(nb)?.grid_unit_y;
                    let mut newLLy = LLy.wrapping_sub(mi.dist_ee);
                    let mut newURy = URy.wrapping_add(mi.dist_ee);
                    let mut boundY = ceil_mul(newLLy, nu);
                    if boundY > newURy {
                        newLLy = floor_mul(newLLy, nu);
                        newURy = ceil_mul(newLLy, nu);
                        boundY = newLLy;
                    }
                    step_ok(nu, boundY <= newURy)?;
                    let mut y = boundY;
                    while y <= newURy {
                        if x >= newLLx && x <= newURx && y >= newLLy && y <= newURy {
                            plist[mu].push((x, y));
                        }
                        y = y.wrapping_add(nu);
                        if y < boundY {
                            break;
                        }
                    }
                }
                x = x.wrapping_add(cu);
                if x < boundX {
                    break;
                }
            }
        } else if mi.direct == 1 {
            let cu = mi.grid_unit_y;
            rem_ok(cu)?;
            let newLLy = LLy.wrapping_sub(cu).wrapping_add(mi.width / 2);
            let newURy = URy.wrapping_add(cu).wrapping_sub(mi.width / 2);
            let boundY = bound(newLLy, cu);
            step_ok(cu, boundY < newURy)?;
            let mut y = boundY;
            while y < newURy {
                for (on, nb) in [(mIdx != obs_l, mIdx - 1), (mIdx != obs_h, mIdx + 1)] {
                    if !on {
                        continue;
                    }
                    let nu = self.cross_mi(nb)?.grid_unit_x;
                    let mut newLLx = LLx.wrapping_sub(mi.dist_ee);
                    let mut newURx = URx.wrapping_add(mi.dist_ee);
                    let mut boundX = ceil_mul(newLLx, nu);
                    if boundX > newURx {
                        newLLx = floor_mul(newLLx, nu);
                        newURx = ceil_mul(newLLy, nu); // sic: newLLy
                        boundX = newLLx;
                    }
                    step_ok(nu, boundX <= newURx)?;
                    let mut x = boundX;
                    while x <= newURx {
                        if x >= newLLx && x <= newURx && y >= newLLy && y <= newURy {
                            plist[mu].push((x, y));
                        }
                        x = x.wrapping_add(nu);
                        if x < boundX {
                            break;
                        }
                    }
                }
                y = y.wrapping_add(cu);
                if y < boundY {
                    break;
                }
            }
        }
        // else: Router-Error: incorrect routing direction
        Ok(())
    }

    /// GcellDetailRouter::InactivateRect2GridPoints (GcellDetailRouter.cpp:4332-4437) — ConvertRect2GridPoints 와
    /// 같은 점들의 꼭짓점을 끈다. 세로층은 여기서 끝단 간격만큼 한 번 더 불린다 (부르는 쪽이 이미 불렸다).
    /// 가로층은 x 로 불리지 않는다 (주석 처리됨). 없는 점은 `map[p]` 가 0 을 넣어 꼭짓점 0 을 끈다.
    pub(crate) fn InactivateRect2GridPoints(&self, mIdx: i32, LLx: i32, LLy: i32, URx: i32, URy: i32, grid: &mut Grid) -> Result<(), String> {
        let obs_l = 0;
        let obs_h = self.layerNo - 1;
        let mi = self.mi(mIdx)?;
        let off = |grid: &mut Grid, x: i32, y: i32| -> Result<(), String> {
            if let Some(i) = grid.map_index(mIdx, x, y)? {
                grid.vertices_total[i].active = false;
            }
            Ok(())
        };
        if mi.direct == 0 {
            let cu = mi.grid_unit_x;
            rem_ok(cu)?;
            let newLLx = LLx.wrapping_sub(cu).wrapping_add(mi.width / 2);
            let newURx = URx.wrapping_add(cu).wrapping_sub(mi.width / 2);
            let boundX = bound(newLLx, cu);
            step_ok(cu, boundX < newURx)?;
            let mut x = boundX;
            while x < newURx {
                for (on, nb) in [(mIdx != obs_l, mIdx - 1), (mIdx != obs_h, mIdx + 1)] {
                    if !on {
                        continue;
                    }
                    let nu = self.cross_mi(nb)?.grid_unit_y;
                    let mut newLLy = LLy.wrapping_sub(mi.dist_ee);
                    let mut newURy = URy.wrapping_add(mi.dist_ee);
                    let mut boundY = ceil_mul(newLLy, nu);
                    if boundY > newURy {
                        newLLy = floor_mul(newLLy, nu);
                        newURy = ceil_mul(newLLy, nu);
                        boundY = newLLy;
                    }
                    step_ok(nu, boundY <= newURy)?;
                    let mut y = boundY;
                    while y <= newURy {
                        if x >= newLLx && x <= newURx && y >= newLLy && y <= newURy {
                            off(grid, x, y)?;
                        }
                        y = y.wrapping_add(nu);
                        if y < boundY {
                            break;
                        }
                    }
                }
                x = x.wrapping_add(cu);
                if x < boundX {
                    break;
                }
            }
        } else if mi.direct == 1 {
            let cu = mi.grid_unit_y;
            rem_ok(cu)?;
            let newLLy = LLy.wrapping_sub(cu).wrapping_add(mi.width / 2);
            let newURy = URy.wrapping_add(cu).wrapping_sub(mi.width / 2);
            let boundY = bound(newLLy, cu);
            step_ok(cu, boundY < newURy)?;
            let mut y = boundY;
            while y < newURy {
                for (on, nb) in [(mIdx != obs_l, mIdx - 1), (mIdx != obs_h, mIdx + 1)] {
                    if !on {
                        continue;
                    }
                    let nu = self.cross_mi(nb)?.grid_unit_x;
                    let mut newLLx = LLx;
                    let mut newURx = URx;
                    let mut boundX = ceil_mul(newLLx, nu);
                    if boundX > newURx {
                        newLLx = floor_mul(newLLx, nu);
                        newURx = ceil_mul(newLLy, nu); // sic: newLLy
                        boundX = newLLx;
                    }
                    step_ok(nu, boundX <= newURx)?;
                    let mut x = boundX;
                    while x <= newURx {
                        if x >= newLLx && x <= newURx && y >= newLLy && y <= newURy {
                            off(grid, x, y)?;
                        }
                        x = x.wrapping_add(nu);
                        if x < boundX {
                            break;
                        }
                    }
                }
                y = y.wrapping_add(cu);
                if y < boundY {
                    break;
                }
            }
        }
        Ok(())
    }

    /// GcellDetailRouter::InactivateRect2GridPoints_Via (GcellDetailRouter.cpp:4574-4665) — 사각형 안
    /// 격자점의 위(up) 또는 아래 비아를 막는다. 사각형을 불리지 않고, 첫 점이 격자 위면 한 칸 건너뛴다
    /// (그래서 비아 간격 막기가 한쪽으로 치우친다).
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn InactivateRect2GridPoints_Via(&self, mIdx: i32, LLx: i32, LLy: i32, URx: i32, URy: i32, up: bool, grid: &mut Grid) -> Result<(), String> {
        let obs_l = 0;
        let obs_h = self.layerNo - 1;
        let mi = self.mi(mIdx)?;
        let off = |grid: &mut Grid, x: i32, y: i32| -> Result<(), String> {
            if let Some(i) = grid.map_index(mIdx, x, y)? {
                if up {
                    grid.vertices_total[i].via_active_up = false;
                } else {
                    grid.vertices_total[i].via_active_down = false;
                }
            }
            Ok(())
        };
        let first = |v: i32, n: i32| if v.wrapping_rem(n) == 0 { v.wrapping_div(n).wrapping_add(1).wrapping_mul(n) } else { ceil_mul(v, n) };
        if mi.direct == 0 {
            let cu = mi.grid_unit_x;
            let mut x = ceil_mul(LLx, cu);
            step_ok(cu, x < URx)?;
            while x < URx {
                for (on, nb) in [(mIdx != obs_l, mIdx - 1), (mIdx != obs_h, mIdx + 1)] {
                    if !on {
                        continue;
                    }
                    let nu = self.mi(nb)?.grid_unit_y;
                    rem_ok(nu)?;
                    let mut y = first(LLy, nu);
                    step_ok(nu, y < URy)?;
                    while y < URy {
                        if x >= LLx && x <= URx && y >= LLy && y <= URy {
                            off(grid, x, y)?;
                        }
                        y = y.wrapping_add(nu);
                    }
                }
                x = x.wrapping_add(cu);
            }
        } else if mi.direct == 1 {
            let cu = mi.grid_unit_y;
            let mut y = ceil_mul(LLy, cu);
            step_ok(cu, y < URy)?;
            while y < URy {
                for (on, nb) in [(mIdx != obs_l, mIdx - 1), (mIdx != obs_h, mIdx + 1)] {
                    if !on {
                        continue;
                    }
                    let nu = self.mi(nb)?.grid_unit_x;
                    rem_ok(nu)?;
                    let mut x = first(LLx, nu);
                    step_ok(nu, x < URx)?;
                    while x < URx {
                        if x >= LLx && x <= URx && y >= LLy && y <= URy {
                            off(grid, x, y)?;
                        }
                        x = x.wrapping_add(nu);
                    }
                }
                y = y.wrapping_add(cu);
            }
        }
        Ok(())
    }

    /// GcellDetailRouter::Grid_Inactive_new (GcellDetailRouter.cpp:191-235) — 창과 상관없이 집합 전체를,
    /// 금속 방향으로 끝단 간격만큼 불려 끈다
    pub(crate) fn Grid_Inactive_new(&self, grid: &mut Grid, Set: &BTreeSet<C5>) -> Result<(), String> {
        for &(llx, lly, mIdx, urx, ury) in Set {
            let mi = self.mi(mIdx)?;
            let ee = mi.dist_ee;
            if mi.direct == 0 {
                if mIdx < self.layerNo - 1 || mIdx > 0 {
                    self.InactivateRect2GridPoints(mIdx, llx, lly.wrapping_sub(ee), urx, ury.wrapping_add(ee), grid)?;
                }
            } else if mIdx < self.layerNo - 1 || mIdx > 0 {
                self.InactivateRect2GridPoints(mIdx, llx.wrapping_sub(ee), lly, urx.wrapping_add(ee), ury, grid)?;
            }
        }
        Ok(())
    }

    /// RawRouter::FindsetPlist — 점 하나짜리 집합에서 (x, y, 층) 사전 순 [LL·lowest, UR·highest] 을 고르고,
    /// 그중 (y, x, 층) 사전 순으로도 안인 점들. 창이 거꾸로인데 사이에 점이 있으면 Err (reversed_ub).
    fn FindsetPlist(&self, Set_x: &BTreeSet<P3>, LL: (i32, i32), UR: (i32, i32)) -> Result<PlistSet, String> {
        let (lo, hi) = (self.lowest_metal, self.highest_metal);
        let (low, up) = ((LL.0, LL.1, lo), (UR.0, UR.1, hi));
        reversed_ub(&low, &up, || Set_x.range((Excluded(up), Excluded(low))).next().is_some(), "FindsetPlist")?;
        let Set_y: BTreeSet<P3> = if low <= up { Set_x.range(low..=up).map(|&(x, y, m)| (y, x, m)).collect() } else { BTreeSet::new() };
        let (low, up) = ((LL.1, LL.0, lo), (UR.1, UR.0, hi));
        reversed_ub(&low, &up, || Set_y.range((Excluded(up), Excluded(low))).next().is_some(), "FindsetPlist")?;
        let mut out: PlistSet = (0..self.layerNo as usize).map(|_| FxSet::default()).collect();
        if low <= up {
            for &(y, x, m) in Set_y.range(low..=up) {
                // plist[metalIdx] — 점은 plist 의 층 번호에서 왔다
                out[m as usize].insert((x, y));
            }
        }
        Ok(out)
    }

    /// GcellDetailRouter::CreatePlistSrc_Dest (GcellDetailRouter.cpp:3969-4037) — 출발·도착 사각형의 격자점을
    /// 두 사각형 전체를 덮는 창으로 거른다
    pub(crate) fn CreatePlistSrc_Dest(&self, temp_src: &[Sink], temp_dest: &[Sink]) -> Result<PlistSet, String> {
        let n = self.layerNo as usize;
        let mut plist: Vec<Vec<(i32, i32)>> = vec![Vec::new(); n];
        let (mut llx, mut lly, mut urx, mut ury) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
        let all: Vec<&Sink> = temp_src.iter().chain(temp_dest.iter()).collect();
        for s in &all {
            llx = llx.min(s.LL.x);
            lly = lly.min(s.LL.y);
            urx = urx.max(s.UR.x);
            ury = ury.max(s.UR.y);
        }
        for s in &all {
            self.ConvertRect2GridPoints(&mut plist, s.metalIdx, s.LL.x, s.LL.y, s.UR.x, s.UR.y)?;
        }
        // InsertPlistToSet_x: 점 하나짜리 SinkData 집합 (x, y, 층)
        let mut Set_x: BTreeSet<P3> = BTreeSet::new();
        for (m, pts) in plist.iter().enumerate() {
            for &(x, y) in pts {
                Set_x.insert((x, y, m as i32));
            }
        }
        self.FindsetPlist(&Set_x, (llx, lly), (urx, ury))
    }

    /// CombineTwoSets(set1, set2) 뒤 RawRouter::Findset (RawRouter.cpp:104-138). 첫 걸음(SinkDataComp)은
    /// 왼아래 모서리 (x, y, 층) 로 거르고, 둘째 걸음의 집합(SinkData2Comp: y, x, 층)이 모서리와 층이 같은
    /// 접점을 하나(먼저 온 것 = 오른위가 가장 작은 것)만 남긴다. 모서리가 LL 이고 층이 lowest 인 접점은
    /// C++ 이 키의 coord[1] (범위 밖) 과 견준다 — 들어가는 것으로 둔다 (pr 과 같은 선택).
    pub(crate) fn Findset(&self, set1: &BTreeSet<C5>, set2: &BTreeSet<C5>, LL: (i32, i32), UR: (i32, i32)) -> Result<Vec<C5>, String> {
        let (lo, hi) = (self.lowest_metal, self.highest_metal);
        let key = |c: &C5| (c.0, c.1, c.2);
        let (low, up) = ((LL.0, LL.1, lo), (UR.0, UR.1, hi));
        // 두 집합을 합친 SinkDataComp 순서 (같은 원소는 하나)
        reversed_ub(&low, &up, || set1.union(set2).any(|c| up < key(c) && key(c) < low), "Findset")?;
        let mut Set_y: BTreeMap<P3, C5> = BTreeMap::new();
        for c in set1.union(set2) {
            if low <= key(c) && key(c) <= up {
                Set_y.entry((c.1, c.0, c.2)).or_insert(*c);
            }
        }
        let (low, up) = ((LL.1, LL.0, lo), (UR.1, UR.0, hi));
        reversed_ub(&low, &up, || Set_y.range((Excluded(up), Excluded(low))).next().is_some(), "Findset")?;
        let mut out: Vec<C5> = Set_y.into_iter().filter(|(k, _)| low <= *k && *k <= up).map(|(_, c)| c).collect();
        out.sort_unstable();
        Ok(out)
    }

    /// RawRouter::findviaset — (모형, x, y) 사전 순으로 [(lowest, LL), (highest, UR)]
    pub(crate) fn findviaset(&self, Pset_via: &BTreeSet<P3>, LL: (i32, i32), UR: (i32, i32)) -> Result<Vec<P3>, String> {
        let lo = (self.lowest_metal, LL.0, LL.1);
        let hi = (self.highest_metal, UR.0, UR.1);
        reversed_ub(&lo, &hi, || Pset_via.range((Excluded(hi), Excluded(lo))).next().is_some(), "findviaset")?;
        if lo > hi {
            return Ok(Vec::new());
        }
        Ok(Pset_via.range(lo..=hi).copied().collect())
    }

    /// GcellDetailRouter::AddViaEnclosure (GcellDetailRouter.cpp:1704-1988), bidirection = false.
    /// 창 안 접점마다 그 층의 금속 방향으로 끝단 간격만큼 불린 상자(위·아래 비아 모형의 둘러싸기 길이도
    /// 더해서)에서 비아를 막는다. 출발·도착 사각형 안에 드는 접점(같은 층)은 건너뛴다.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn AddViaEnclosure(&self, grid: &mut Grid, Set_x_contact: &BTreeSet<C5>, Set_net_contact: &BTreeSet<C5>, LL: (i32, i32),
                                  UR: (i32, i32), temp_source: &[Sink], temp_dest: &[Sink]) -> Result<(), String> {
        let Set = self.Findset(Set_net_contact, Set_x_contact, LL, UR)?;
        let inside = |v: &[Sink], metal: i32, c: &C5| {
            v.iter().any(|s| s.metalIdx == metal && s.LL.x <= c.0 && s.LL.y <= c.1 && s.UR.x >= c.3 && s.UR.y >= c.4)
        };
        let vm = |k: i32| -> Result<&crate::db::ViaModel, String> {
            usize::try_from(k).ok().and_then(|u| self.drc_info.Via_model.get(u)).ok_or_else(|| format!("GcellDetailRouter: Via_model[{k}] 이 없다"))
        };
        let pt = |r: &[crate::db::Point], i: usize| -> Result<crate::db::Point, String> {
            r.get(i).copied().ok_or_else(|| "GcellDetailRouter: 비아 모형 사각형이 비었다 (C++ 은 범위 밖을 읽는다)".to_string())
        };
        for c in &Set {
            let mIdx = c.2;
            let mi = self.mi(mIdx)?;
            let ee = mi.dist_ee;
            let skip = inside(temp_source, mIdx, c) || inside(temp_dest, mIdx, c);
            if mi.direct == 0 {
                if mIdx < self.layerNo - 1 {
                    let v = vm(mIdx)?;
                    let (by0, by1) = (c.1.wrapping_add(pt(&v.LowerRect, 0)?.y).wrapping_sub(ee), c.4.wrapping_add(pt(&v.LowerRect, 1)?.y).wrapping_add(ee));
                    if skip {
                        continue;
                    }
                    self.InactivateRect2GridPoints_Via(v.LowerIdx, c.0, by0, c.3, by1, true, grid)?;
                    self.InactivateRect2GridPoints_Via(v.UpperIdx, c.0, by0, c.3, by1, false, grid)?;
                }
                if mIdx > 0 {
                    let v = vm(mIdx - 1)?;
                    let (by0, by1) = (c.1.wrapping_add(pt(&v.UpperRect, 0)?.y).wrapping_sub(ee), c.4.wrapping_add(pt(&v.UpperRect, 1)?.y).wrapping_add(ee));
                    if skip {
                        continue;
                    }
                    self.InactivateRect2GridPoints_Via(v.UpperIdx, c.0, by0, c.3, by1, false, grid)?;
                    self.InactivateRect2GridPoints_Via(v.LowerIdx, c.0, by0, c.3, by1, true, grid)?;
                }
            } else {
                if mIdx < self.layerNo - 1 {
                    let v = vm(mIdx)?;
                    let (bx0, bx1) = (c.0.wrapping_add(pt(&v.LowerRect, 0)?.x).wrapping_sub(ee), c.3.wrapping_add(pt(&v.LowerRect, 1)?.x).wrapping_add(ee));
                    if skip {
                        continue;
                    }
                    self.InactivateRect2GridPoints_Via(v.LowerIdx, bx0, c.1, bx1, c.4, true, grid)?;
                    self.InactivateRect2GridPoints_Via(v.UpperIdx, bx0, c.1, bx1, c.4, false, grid)?;
                }
                if mIdx > 0 {
                    let v = vm(mIdx - 1)?;
                    let (bx0, bx1) = (c.0.wrapping_add(pt(&v.UpperRect, 0)?.x).wrapping_sub(ee), c.3.wrapping_add(pt(&v.UpperRect, 1)?.x).wrapping_add(ee));
                    if skip {
                        continue;
                    }
                    self.InactivateRect2GridPoints_Via(v.UpperIdx, bx0, c.1, bx1, c.4, false, grid)?;
                    self.InactivateRect2GridPoints_Via(v.LowerIdx, bx0, c.1, bx1, c.4, true, grid)?;
                }
            }
        }
        Ok(())
    }

    /// GcellDetailRouter::AddViaSpacing (GcellDetailRouter.cpp:1990-2119) — 창 안 비아 둘레의 비아를
    /// 막고, 도착 꼭짓점 옆(한 칸 띄워) 비아 간격만큼을 막는다
    pub(crate) fn AddViaSpacing(&self, Pset_via: &BTreeSet<P3>, grid: &mut Grid, LL: (i32, i32), UR: (i32, i32)) -> Result<(), String> {
        let drc = self.drc_info;
        let via = |k: i32| -> Result<&crate::db::ViaInfo, String> {
            usize::try_from(k).ok().and_then(|u| drc.Via_info.get(u)).ok_or_else(|| format!("GcellDetailRouter: Via_info[{k}] 이 없다"))
        };
        for (vIdx, x, y) in self.findviaset(Pset_via, LL, UR)? {
            let vi = via(vIdx)?;
            let (bx0, by0) = (x.wrapping_sub(vi.dist_ss).wrapping_sub(vi.width), y.wrapping_sub(vi.dist_ss_y).wrapping_sub(vi.width_y));
            let (bx1, by1) = (x.wrapping_add(vi.dist_ss).wrapping_add(vi.width), y.wrapping_add(vi.dist_ss_y).wrapping_add(vi.width_y));
            self.InactivateRect2GridPoints_Via(vIdx, bx0, by0, bx1, by1, true, grid)?;
            self.InactivateRect2GridPoints_Via(vIdx.wrapping_add(1), bx0, by0, bx1, by1, false, grid)?;
        }
        let nM = drc.Metal_info.len() as i32;
        let dests = grid.Dest.clone();
        for dest in dests {
            let (metal, x, y) = {
                let v = &grid.vertices_total[dest as usize];
                (v.metal, v.x, v.y)
            };
            let mi = self.mi(metal)?;
            let pairs: [(i32, i32, i32); 2] = [(mi.upper_via_index, metal, metal.wrapping_add(1)), (mi.lower_via_index, metal.wrapping_sub(1), metal)];
            for (k, &(vIdx, lo_m, hi_m)) in pairs.iter().enumerate() {
                let ok = if k == 0 { vIdx != -1 && metal != nM - 1 } else { vIdx != -1 && metal != 0 };
                if !ok {
                    continue;
                }
                let vi = via(vIdx)?;
                let boxes = if mi.direct == 0 {
                    let s = vi.dist_ss.wrapping_add(vi.width);
                    [(x.wrapping_sub(s), y.wrapping_sub(1), x.wrapping_sub(1), y.wrapping_add(1)), (x.wrapping_add(1), y.wrapping_sub(1), x.wrapping_add(s), y.wrapping_add(1))]
                } else {
                    let s = vi.dist_ss_y.wrapping_add(vi.width_y);
                    [(x.wrapping_sub(1), y.wrapping_add(1), x.wrapping_add(1), y.wrapping_add(s)), (x.wrapping_sub(1), y.wrapping_sub(s), x.wrapping_add(1), y.wrapping_sub(1))]
                };
                for (bx0, by0, bx1, by1) in boxes {
                    self.InactivateRect2GridPoints_Via(lo_m, bx0, by0, bx1, by1, true, grid)?;
                    self.InactivateRect2GridPoints_Via(hi_m, bx0, by0, bx1, by1, false, grid)?;
                }
            }
        }
        Ok(())
    }
}

/// ConvertRect2GridPoints 의 첫 선: 격자 위면 한 칸 다음, 아니면 올림
#[inline]
fn bound(v: i32, u: i32) -> i32 {
    if v.wrapping_rem(u) == 0 {
        v.wrapping_add(u)
    } else if v.wrapping_div(u).wrapping_mul(u) < v {
        v.wrapping_div(u).wrapping_add(1).wrapping_mul(u)
    } else {
        v.wrapping_div(u).wrapping_mul(u)
    }
}
