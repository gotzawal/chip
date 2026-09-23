//! GcellDetailRouter·RawRouter 의 도우미 가운데 PowerRouter 가 부르는 것 (router/GcellDetailRouter.cpp,
//! RawRouter.cpp). 모드 5 는 따로 옮긴다 — 겹치는 것은 일부러 여기 따로 둔다.
//!
//! 집합의 모양:
//!   Set_x, Set_net (점)          (x, y, 층)              — SinkDataComp 로 점 하나짜리 = 이 사전 순
//!   접점 (Set_*_contact)         (LLx, LLy, 층, URx, URy) — SinkDataComp 로 점 둘짜리 = 이 사전 순
//!   비아 (Pset_via)              (모형, x, y)            — pointSetComp
use super::grid::{Grid, Sink};
use super::util::{FxSet, ceil_mul, f2i, floor_mul};
use super::{Plist, PowerRouter};
use crate::db::DrcInfo;
use crate::rdb::{ByVia, Metal, PowerGrid, Via, contact, point};
use std::collections::{BTreeMap, BTreeSet};

pub(crate) type P3 = (i32, i32, i32);
pub(crate) type C5 = (i32, i32, i32, i32, i32);

/// GcellDetailRouter::Contact2Sinkdata
#[inline]
pub(crate) fn c5(c: &contact) -> C5 {
    (c.placedLL.x, c.placedLL.y, c.metal, c.placedUR.x, c.placedUR.y)
}

/// GcellDetailRouter::ConvertRect2GridPoints (GcellDetailRouter.cpp:4127-4330), enclose_length = 0.
/// 사각형을 제 층 격자(drc)와 이웃 층 격자(cross)의 교점 목록으로 바꾼다. 가로층의 되돌림 가지는
/// x 범위 끝을 y 값(newLLy)으로 구한다 (4277, 4310 줄의 버릇).
#[allow(clippy::too_many_arguments)]
pub(crate) fn ConvertRect2GridPoints(plist: &mut Plist, drc: &DrcInfo, cross: &DrcInfo, layerNo: i32, mIdx: i32, LLx: i32, LLy: i32, URx: i32, URy: i32) {
    let obs_l = 0;
    let obs_h = layerNo - 1;
    let enclose_length = 0;
    // 층을 못 찾은 접점(-1)이면 C++ 은 Metal_info[-1] 을 읽는다 — 건너뛴다
    if mIdx < 0 || mIdx as usize >= drc.Metal_info.len() {
        return;
    }
    let mu = mIdx as usize;
    let mi = &drc.Metal_info[mu];
    let mut push = |x: i32, y: i32| plist[mu].push(point::new(x, y));
    if mi.direct == 0 {
        let curlayer_unit = mi.grid_unit_x;
        let newLLx = LLx - curlayer_unit + mi.width / 2;
        let newURx = URx + curlayer_unit - mi.width / 2;
        let boundX = if newLLx % curlayer_unit == 0 {
            newLLx + curlayer_unit
        } else if (newLLx / curlayer_unit) * curlayer_unit < newLLx {
            (newLLx / curlayer_unit + 1) * curlayer_unit
        } else {
            (newLLx / curlayer_unit) * curlayer_unit
        };
        let mut x = boundX;
        while x < newURx {
            for (on, nb) in [(mIdx != obs_l, mIdx - 1), (mIdx != obs_h, mIdx + 1)] {
                if !on {
                    continue;
                }
                let nexlayer_unit = cross.Metal_info[nb as usize].grid_unit_y;
                let mut newLLy = LLy - mi.dist_ee - enclose_length;
                let mut newURy = URy + mi.dist_ee + enclose_length;
                let mut boundY = ceil_mul(newLLy, nexlayer_unit);
                if boundY > newURy {
                    newLLy = floor_mul(newLLy, nexlayer_unit);
                    newURy = ceil_mul(newLLy, nexlayer_unit);
                    boundY = newLLy;
                }
                let mut y = boundY;
                while y <= newURy {
                    if x >= newLLx && x <= newURx && y >= newLLy && y <= newURy {
                        push(x, y);
                    }
                    y += nexlayer_unit;
                }
            }
            x += curlayer_unit;
        }
    } else if mi.direct == 1 {
        let curlayer_unit = mi.grid_unit_y;
        let newLLy = LLy - curlayer_unit + mi.width / 2;
        let newURy = URy + curlayer_unit - mi.width / 2;
        let boundY = if newLLy % curlayer_unit == 0 {
            newLLy + curlayer_unit
        } else if (newLLy / curlayer_unit) * curlayer_unit < newLLy {
            (newLLy / curlayer_unit + 1) * curlayer_unit
        } else {
            (newLLy / curlayer_unit) * curlayer_unit
        };
        let mut y = boundY;
        while y < newURy {
            for (on, nb) in [(mIdx != obs_l, mIdx - 1), (mIdx != obs_h, mIdx + 1)] {
                if !on {
                    continue;
                }
                let nexlayer_unit = cross.Metal_info[nb as usize].grid_unit_x;
                let mut newLLx = LLx - mi.dist_ee - enclose_length;
                let mut newURx = URx + mi.dist_ee + enclose_length;
                let mut boundX = ceil_mul(newLLx, nexlayer_unit);
                if boundX > newURx {
                    newLLx = floor_mul(newLLx, nexlayer_unit);
                    newURx = ceil_mul(newLLy, nexlayer_unit); // sic: newLLy
                    boundX = newLLx;
                }
                let mut x = boundX;
                while x <= newURx {
                    if x >= newLLx && x <= newURx && y >= newLLy && y <= newURy {
                        push(x, y);
                    }
                    x += nexlayer_unit;
                }
            }
            y += curlayer_unit;
        }
    }
}

/// RawRouter::InsertPlistToSet_x
pub(crate) fn InsertPlistToSet_x(Set_x: &mut FxSet<P3>, plist: &Plist) {
    for (i, pts) in plist.iter().enumerate() {
        for p in pts {
            Set_x.insert((p.x, p.y, i as i32));
        }
    }
}

/// RawRouter::FindsetPlist 의 범위: (x, y, 층) 과 (y, x, 층) 사전 순으로 [LL·lo, UR·hi] 안
#[inline]
pub(crate) fn findset_in(x: i32, y: i32, m: i32, LL: point, UR: point, lo: i32, hi: i32) -> bool {
    (LL.x, LL.y, lo) <= (x, y, m) && (x, y, m) <= (UR.x, UR.y, hi) && (LL.y, LL.x, lo) <= (y, x, m) && (y, x, m) <= (UR.y, UR.x, hi)
}

impl PowerRouter {
    /// `grid.InactivePointlist_Power(FindsetPlist(Set, LL, UR))` — 걸러진 점과 (x, y, 층) 이 같은
    /// 꼭짓점을 끈다
    pub(crate) fn InactiveFindsetPlist(&self, grid: &mut Grid, Set: &FxSet<P3>, LL: point, UR: point) {
        if Set.is_empty() {
            return;
        }
        let (lo, hi) = (self.lowest_metal, self.highest_metal);
        for v in grid.vertices_total.iter_mut() {
            if findset_in(v.x, v.y, v.metal, LL, UR, lo, hi) && Set.contains(&(v.x, v.y, v.metal)) {
                v.active = false;
            }
        }
    }

    /// CombineTwoSets(set1, set2) 뒤 RawRouter::Findset (RawRouter.cpp:104-138). 첫 걸음(SinkDataComp)은
    /// 왼아래 모서리 (x, y, 층) 로 거르고, 둘째 걸음의 집합(SinkData2Comp: y, x, 층)이 모서리와 층이 같은
    /// 접점을 하나(먼저 온 것 = 오른위가 가장 작은 것)만 남긴다. 모서리가 LL 이고 층이 lowest 인 접점은
    /// C++ 이 key 의 coord[1] (범위 밖) 과 견준다 — 들어가는 것으로 둔다.
    pub(crate) fn Findset(&self, set1: &BTreeSet<C5>, set2: &BTreeSet<C5>, LL: point, UR: point) -> Vec<C5> {
        let (lo, hi) = (self.lowest_metal, self.highest_metal);
        let mut all: BTreeSet<C5> = set1.clone();
        all.extend(set2.iter().copied());
        let mut Set_y: BTreeMap<P3, C5> = BTreeMap::new();
        for &c in &all {
            let k = (c.0, c.1, c.2);
            if (LL.x, LL.y, lo) <= k && k <= (UR.x, UR.y, hi) {
                Set_y.entry((c.1, c.0, c.2)).or_insert(c);
            }
        }
        let mut out: Vec<C5> = Set_y.into_iter().filter(|(k, _)| (LL.y, LL.x, lo) <= *k && *k <= (UR.y, UR.x, hi)).map(|(_, c)| c).collect();
        out.sort_unstable();
        out
    }

    /// RawRouter::findviaset — (모형, x, y) 사전 순으로 [(lowest, LL), (highest, UR)]
    pub(crate) fn findviaset(&self, Pset_via: &BTreeSet<P3>, LL: point, UR: point) -> Vec<P3> {
        let lo = (self.lowest_metal, LL.x, LL.y);
        let hi = (self.highest_metal, UR.x, UR.y);
        Pset_via.iter().filter(|p| lo <= **p && **p <= hi).copied().collect()
    }

    fn ConvertRect(&self, plist: &mut Plist, mIdx: i32, LL: point, UR: point) {
        ConvertRect2GridPoints(plist, &self.drc_info, &self.cross_layer_drc_info, self.layerNo, mIdx, LL.x, LL.y, UR.x, UR.y);
    }

    /// GcellDetailRouter::CreatePlistSingleContact
    pub(crate) fn CreatePlistSingleContact(&self, plist: &mut Plist, c: &contact) {
        self.ConvertRect(plist, c.metal, c.placedLL, c.placedUR);
    }

    /// GcellDetailRouter::CreatePlistBlocks — 핀 접점, 핀 비아(위, 아래), 내부 금속, 내부 비아(위, 아래)
    pub(crate) fn CreatePlistBlocks(&self, plist: &mut Plist) {
        for b in &self.Blocks {
            for p in &b.pins {
                for c in &p.pinContacts {
                    self.CreatePlistSingleContact(plist, c);
                }
                for v in &p.pinVias {
                    self.CreatePlistSingleContact(plist, &v.UpperMetalRect);
                    self.CreatePlistSingleContact(plist, &v.LowerMetalRect);
                }
            }
            for c in &b.InternalMetal {
                self.CreatePlistSingleContact(plist, c);
            }
            for v in &b.InternalVia {
                self.CreatePlistSingleContact(plist, &v.UpperMetalRect);
                self.CreatePlistSingleContact(plist, &v.LowerMetalRect);
            }
        }
    }

    /// GcellDetailRouter::CreatePlistTerminals — 층을 아는 단자 접점만
    pub(crate) fn CreatePlistTerminals(&self, plist: &mut Plist) {
        for t in &self.Terminals {
            for c in &t.termContacts {
                if c.metal >= 0 {
                    self.CreatePlistSingleContact(plist, c);
                }
            }
        }
    }

    /// PowerRouter::CreatePlistNets — 금속 사각형, 비아의 위·아래 사각형
    pub(crate) fn CreatePlistNets(&self, plist: &mut Plist) {
        for n in &self.Nets {
            self.CreatePlistPath(plist, &n.path_metal, &n.path_via);
        }
    }

    /// PowerRouter::CreatePlistPowerNets
    pub(crate) fn CreatePlistPowerNets(&self, plist: &mut Plist) {
        for n in &self.PowerNets {
            self.CreatePlistPath(plist, &n.path_metal, &n.path_via);
        }
    }

    fn CreatePlistPath(&self, plist: &mut Plist, path_metal: &[Metal], path_via: &[Via]) {
        for m in path_metal {
            self.ConvertRect(plist, m.MetalIdx, m.MetalRect.placedLL, m.MetalRect.placedUR);
        }
        for v in path_via {
            self.CreatePlistSingleContact(plist, &v.UpperMetalRect);
            self.CreatePlistSingleContact(plist, &v.LowerMetalRect);
        }
    }

    /// PowerRouter::CreatePlistPowerGrid — 비아는 위 사각형을 두 번, 아래 사각형은 안 넣는다
    /// (PowerRouter.cpp:1745-1746)
    pub(crate) fn CreatePlistPowerGrid(&self, plist: &mut Plist, g: &PowerGrid) {
        for m in &g.metals {
            self.ConvertRect(plist, m.MetalIdx, m.MetalRect.placedLL, m.MetalRect.placedUR);
        }
        for v in &g.vias {
            self.CreatePlistSingleContact(plist, &v.UpperMetalRect);
            self.CreatePlistSingleContact(plist, &v.UpperMetalRect);
        }
    }

    /// GcellDetailRouter::InactivateRect2GridPoints_Via (GcellDetailRouter.cpp:4574-4665) — 사각형 안
    /// 격자점의 위(up) 또는 아래 비아를 막는다. 없는 점은 `vertices_total_map.at(m)[p]` 가 0 을 넣어
    /// 꼭짓점 0 의 깃발을 지운다.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn InactivateRect2GridPoints_Via(&self, mIdx: i32, LLx: i32, LLy: i32, URx: i32, URy: i32, up: bool, grid: &mut Grid) {
        let drc = &self.drc_info;
        if mIdx < 0 || mIdx as usize >= drc.Metal_info.len() {
            return;
        }
        let obs_l = 0;
        let obs_h = self.layerNo - 1;
        let mi = &drc.Metal_info[mIdx as usize];
        let mut hit = |x: i32, y: i32| {
            if grid.vertices_total.is_empty() {
                return; // C++ 은 빈 벡터의 [0] 에 쓴다
            }
            let i = grid.map_index(mIdx, x, y);
            if up {
                grid.vertices_total[i].via_active_up = false;
            } else {
                grid.vertices_total[i].via_active_down = false;
            }
        };
        let first = |v: i32, n: i32| if v % n == 0 { (v / n + 1) * n } else { ceil_mul(v, n) };
        if mi.direct == 0 {
            let curlayer_unit = mi.grid_unit_x;
            let mut x = ceil_mul(LLx, curlayer_unit);
            while x < URx {
                for (on, nb) in [(mIdx != obs_l, mIdx - 1), (mIdx != obs_h, mIdx + 1)] {
                    if !on {
                        continue;
                    }
                    let nexlayer_unit = drc.Metal_info[nb as usize].grid_unit_y;
                    let mut y = first(LLy, nexlayer_unit);
                    while y < URy {
                        if x >= LLx && x <= URx && y >= LLy && y <= URy {
                            hit(x, y);
                        }
                        y += nexlayer_unit;
                    }
                }
                x += curlayer_unit;
            }
        } else if mi.direct == 1 {
            let curlayer_unit = mi.grid_unit_y;
            let mut y = ceil_mul(LLy, curlayer_unit);
            while y < URy {
                for (on, nb) in [(mIdx != obs_l, mIdx - 1), (mIdx != obs_h, mIdx + 1)] {
                    if !on {
                        continue;
                    }
                    let nexlayer_unit = drc.Metal_info[nb as usize].grid_unit_x;
                    let mut x = first(LLx, nexlayer_unit);
                    while x < URx {
                        if x >= LLx && x <= URx && y >= LLy && y <= URy {
                            hit(x, y);
                        }
                        x += nexlayer_unit;
                    }
                }
                y += curlayer_unit;
            }
        }
    }

    /// GcellDetailRouter::AddViaEnclosure (GcellDetailRouter.cpp:1704-1988), bidirection = false.
    /// 둘레 접점마다 그 층의 금속 방향으로 끝단 간격(dist_ee)만큼 불린 상자에서 위·아래 비아를 막는다.
    /// 출발·도착 사각형 안에 드는 접점(같은 층)은 건너뛴다.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn AddViaEnclosure(&self, grid: &mut Grid, Set_x_contact: &BTreeSet<C5>, Set_net_contact: &BTreeSet<C5>,
                                  LL: point, UR: point, temp_source: &[Sink], temp_dest: &[Sink]) {
        let Set = self.Findset(Set_net_contact, Set_x_contact, LL, UR);
        let drc = &self.drc_info;
        let inside = |v: &[Sink], metal: i32, c: &C5| {
            v.iter().any(|s| s.metalIdx == metal && s.LL.x <= c.0 && s.LL.y <= c.1 && s.UR.x >= c.3 && s.UR.y >= c.4)
        };
        for c in &Set {
            let mIdx = c.2;
            if mIdx < 0 || mIdx as usize >= drc.Metal_info.len() {
                continue; // Metal_info[-1] (UB)
            }
            let mi = &drc.Metal_info[mIdx as usize];
            let ee = mi.dist_ee;
            let skip = inside(temp_source, mIdx, c) || inside(temp_dest, mIdx, c);
            if mi.direct == 0 {
                if mIdx < self.layerNo - 1 {
                    let vm = &drc.Via_model[mIdx as usize];
                    let (bx0, by0, bx1, by1) = (c.0, c.1 + vm.LowerRect[0].y - ee, c.3, c.4 + vm.LowerRect[1].y + ee);
                    if skip {
                        continue;
                    }
                    self.InactivateRect2GridPoints_Via(vm.LowerIdx, bx0, by0, bx1, by1, true, grid);
                    self.InactivateRect2GridPoints_Via(vm.UpperIdx, bx0, by0, bx1, by1, false, grid);
                }
                if mIdx > 0 {
                    let vm = &drc.Via_model[(mIdx - 1) as usize];
                    let (bx0, by0, bx1, by1) = (c.0, c.1 + vm.UpperRect[0].y - ee, c.3, c.4 + vm.UpperRect[1].y + ee);
                    if skip {
                        continue;
                    }
                    self.InactivateRect2GridPoints_Via(vm.UpperIdx, bx0, by0, bx1, by1, false, grid);
                    self.InactivateRect2GridPoints_Via(vm.LowerIdx, bx0, by0, bx1, by1, true, grid);
                }
            } else {
                if mIdx < self.layerNo - 1 {
                    let vm = &drc.Via_model[mIdx as usize];
                    let (bx0, by0, bx1, by1) = (c.0 + vm.LowerRect[0].x - ee, c.1, c.3 + vm.LowerRect[1].x + ee, c.4);
                    if skip {
                        continue;
                    }
                    self.InactivateRect2GridPoints_Via(vm.LowerIdx, bx0, by0, bx1, by1, true, grid);
                    self.InactivateRect2GridPoints_Via(vm.UpperIdx, bx0, by0, bx1, by1, false, grid);
                }
                if mIdx > 0 {
                    let vm = &drc.Via_model[(mIdx - 1) as usize];
                    let (bx0, by0, bx1, by1) = (c.0 + vm.UpperRect[0].x - ee, c.1, c.3 + vm.UpperRect[1].x + ee, c.4);
                    if skip {
                        continue;
                    }
                    self.InactivateRect2GridPoints_Via(vm.UpperIdx, bx0, by0, bx1, by1, false, grid);
                    self.InactivateRect2GridPoints_Via(vm.LowerIdx, bx0, by0, bx1, by1, true, grid);
                }
            }
        }
    }

    /// GcellDetailRouter::AddViaSpacing (GcellDetailRouter.cpp:1990-2119) — 창 안 비아 둘레의 비아를
    /// 막고, 도착 꼭짓점 옆(한 칸 띄워) 비아 간격만큼을 막는다
    pub(crate) fn AddViaSpacing(&self, Pset_via: &BTreeSet<P3>, grid: &mut Grid, LL: point, UR: point) {
        let drc = &self.drc_info;
        for (vIdx, x, y) in self.findviaset(Pset_via, LL, UR) {
            let vi = &drc.Via_info[vIdx as usize];
            let (bx0, by0) = (x - vi.dist_ss - vi.width, y - vi.dist_ss_y - vi.width_y);
            let (bx1, by1) = (x + vi.dist_ss + vi.width, y + vi.dist_ss_y + vi.width_y);
            self.InactivateRect2GridPoints_Via(vIdx, bx0, by0, bx1, by1, true, grid);
            self.InactivateRect2GridPoints_Via(vIdx + 1, bx0, by0, bx1, by1, false, grid);
        }
        let nM = drc.Metal_info.len() as i32;
        let dests = grid.Dest.clone();
        for dest in dests {
            let (metal, x, y) = {
                let v = &grid.vertices_total[dest as usize];
                (v.metal, v.x, v.y)
            };
            let mi = &drc.Metal_info[metal as usize];
            let pairs: [(i32, i32, i32); 2] = [(mi.upper_via_index, metal, metal + 1), (mi.lower_via_index, metal - 1, metal)];
            for (k, &(vIdx, lo_m, hi_m)) in pairs.iter().enumerate() {
                let ok = if k == 0 { vIdx != -1 && metal != nM - 1 } else { vIdx != -1 && metal != 0 };
                if !ok {
                    continue;
                }
                let vi = &drc.Via_info[vIdx as usize];
                let boxes = if mi.direct == 0 {
                    let s = vi.dist_ss + vi.width;
                    [(x - s, y - 1, x - 1, y + 1), (x + 1, y - 1, x + s, y + 1)]
                } else {
                    let s = vi.dist_ss_y + vi.width_y;
                    [(x - 1, y + 1, x + 1, y + s), (x - 1, y - s, x + 1, y - 1)]
                };
                for (bx0, by0, bx1, by1) in boxes {
                    self.InactivateRect2GridPoints_Via(lo_m, bx0, by0, bx1, by1, true, grid);
                    self.InactivateRect2GridPoints_Via(hi_m, bx0, by0, bx1, by1, false, grid);
                }
            }
        }
    }

    /// GcellDetailRouter::UpdatePlistNets (GcellDetailRouter.cpp:3825-3907) — 새 경로를 층 방향대로
    /// 사각형으로 만들고(GetPhsical_Metal) label 대로 늘려 격자점으로, 그 비아의 위·아래 사각형도
    pub(crate) fn UpdatePlistNets(&self, physical_path: &mut [Vec<Metal>], plist: &mut Plist, extend_labels: &[Vec<i32>]) {
        self.GetPhsical_Metal(physical_path);
        for (i, path) in physical_path.iter_mut().enumerate() {
            for (j, m) in path.iter_mut().enumerate() {
                let label = extend_labels.get(i).and_then(|l| l.get(j)).copied().unwrap_or(0);
                self.ExtendByLabel(m, label);
                self.ConvertRect(plist, m.MetalIdx, m.MetalRect.placedLL, m.MetalRect.placedUR);
            }
        }
        let temp_via_contact = self.GetPhsical_Via_contacts(physical_path);
        for c in &temp_via_contact {
            self.CreatePlistSingleContact(plist, c);
        }
    }

    /// GcellDetailRouter::GetPhsical_Metal — 층 방향으로 (폭의 반만큼 옆으로, 끝은 늘리지 않는다)
    fn GetPhsical_Metal(&self, physical_path: &mut [Vec<Metal>]) {
        for path in physical_path.iter_mut() {
            for m in path.iter_mut() {
                let (p0, p1, h) = (m.LinePoint[0], m.LinePoint[1], m.width / 2);
                let r = &mut m.MetalRect;
                if self.drc_info.Metal_info[m.MetalIdx as usize].direct == 1 {
                    if p0.x <= p1.x {
                        (r.placedLL, r.placedUR) = (point::new(p0.x, p0.y - h), point::new(p1.x, p1.y + h));
                    } else {
                        (r.placedLL, r.placedUR) = (point::new(p1.x, p1.y - h), point::new(p0.x, p0.y + h));
                    }
                } else if p0.y <= p1.y {
                    (r.placedLL, r.placedUR) = (point::new(p0.x - h, p0.y), point::new(p1.x + h, p1.y));
                } else {
                    (r.placedLL, r.placedUR) = (point::new(p1.x - h, p1.y), point::new(p0.x + h, p0.y));
                }
            }
        }
    }

    /// GcellDetailRouter::GetPhsical_Via_contacts — 경로마다 층이 하나 차이 나고 끝점이 겹치는 금속 쌍의
    /// 비아(ViaComp 순)의 위·아래 사각형
    fn GetPhsical_Via_contacts(&self, physical_path: &[Vec<Metal>]) -> Vec<contact> {
        let mut set_via: BTreeSet<ByVia> = BTreeSet::new();
        for temp_path in physical_path {
            for (j, a) in temp_path.iter().enumerate() {
                for (h, b) in temp_path.iter().enumerate() {
                    if j == h || a.MetalIdx != b.MetalIdx - 1 {
                        continue;
                    }
                    for pa in [a.LinePoint[0], a.LinePoint[1]] {
                        for pb in [b.LinePoint[0], b.LinePoint[1]] {
                            if pa.x == pb.x && pa.y == pb.y {
                                let mut v = Via { model_index: a.MetalIdx, position: pa, ..Via::default() };
                                self.UpdateVia(&mut v);
                                set_via.insert(ByVia(v));
                            }
                        }
                    }
                }
            }
        }
        let mut out = Vec::new();
        for v in set_via {
            out.push(v.0.UpperMetalRect);
            out.push(v.0.LowerMetalRect);
        }
        out
    }

    /// ExtendMetals / ExtendMetal / UpdatePlistNets 의 몸통 (셋이 같다): label 1 은 양쪽으로
    /// (int)(ceil(minL - len) / 2), 2 는 큰 쪽 끝, 3 은 작은 쪽 끝으로 minL - len. 4 는 기록만.
    pub(crate) fn ExtendByLabel(&self, m: &mut Metal, label: i32) {
        if label == 0 {
            return;
        }
        let mi = &self.drc_info.Metal_info[m.MetalIdx as usize];
        let direction = mi.direct;
        let minL = mi.minL;
        let current_length = (m.LinePoint[0].x - m.LinePoint[1].x).abs() + (m.LinePoint[0].y - m.LinePoint[1].y).abs();
        if current_length < minL && label == 1 {
            let extend_dis = f2i(((minL - current_length) as f64).ceil() / 2.0);
            if direction == 1 {
                ExtendX(m, extend_dis);
            } else {
                ExtendY(m, extend_dis);
            }
        } else if current_length < minL && label == 2 {
            let extend_dis = f2i(((minL - current_length) as f64).ceil());
            if direction == 1 {
                ExtendX_PN(m, extend_dis, true);
            } else {
                ExtendY_PN(m, extend_dis, true);
            }
        } else if current_length < minL && label == 3 {
            let extend_dis = f2i(((minL - current_length) as f64).ceil());
            if direction == 1 {
                ExtendX_PN(m, extend_dis, false);
            } else {
                ExtendY_PN(m, extend_dis, false);
            }
        }
        // label 4: "Extend Error" 를 기록만 한다
    }

    /// GcellDetailRouter::lastmile_source_new (GcellDetailRouter.cpp:2791-2907) — 경로 첫 점이 같은 층
    /// 출발 사각형 안에 없으면 가장 가까운 모서리에서 금속을 덧댄다 (label 은 안 늘어난다)
    pub(crate) fn lastmile_source_new(&self, temp_path: &mut [Vec<Metal>], temp_source: &[Sink]) -> bool {
        let temp_point = temp_path[0][0].LinePoint[0];
        let m = temp_path[0][0].MetalIdx;
        let (source_point, connected) = self.lastmile_nearest(temp_point, m, temp_source);
        if connected {
            return false;
        }
        let mi = &self.drc_info.Metal_info[m as usize];
        let mut sp = source_point;
        let mut temp_metal = Metal { MetalIdx: m, width: mi.width, LinePoint: Vec::new(), MetalRect: contact::default() };
        if mi.direct == 0 {
            if temp_point.x == sp.x {
                temp_metal.LinePoint = vec![sp, temp_point];
                temp_path[0].insert(0, temp_metal);
            } else {
                temp_metal.LinePoint.push(sp);
                sp.x = if sp.x > temp_point.x { temp_point.x - mi.width / 2 } else { temp_point.x + mi.width / 2 };
                temp_metal.LinePoint.push(sp);
                temp_path[0].insert(0, temp_metal.clone());
                temp_metal.LinePoint.clear();
                sp.x = temp_point.x;
                temp_metal.LinePoint = vec![sp, temp_point];
                temp_path[0].insert(1, temp_metal);
            }
        } else if temp_point.y == sp.y {
            temp_metal.LinePoint = vec![sp, temp_point];
            temp_path[0].insert(0, temp_metal);
        } else {
            temp_metal.LinePoint.push(sp);
            sp.y = if sp.y > temp_point.y { temp_point.y - mi.width / 2 } else { temp_point.y + mi.width / 2 };
            temp_metal.LinePoint.push(sp);
            temp_path[0].insert(0, temp_metal.clone());
            temp_metal.LinePoint.clear();
            sp.y = temp_point.y;
            temp_metal.LinePoint = vec![sp, temp_point];
            temp_path[0].insert(1, temp_metal);
        }
        true
    }

    /// GcellDetailRouter::lastmile_dest_new (GcellDetailRouter.cpp:2909-3037) — 경로 끝 점 쪽. 모서리와
    /// 끝 점을 바꿔 쓰고, 세로층은 y 를, 가로층은 x 를 맞춘다
    pub(crate) fn lastmile_dest_new(&self, temp_path: &mut [Vec<Metal>], temp_dest: &[Sink]) -> bool {
        let last_index = temp_path[0].len() - 1;
        let tp = temp_path[0][last_index].LinePoint[1];
        let m = temp_path[0][last_index].MetalIdx;
        let (nearest, connected) = self.lastmile_nearest(tp, m, temp_dest);
        let mut source_point = tp;
        let temp_point = nearest;
        if connected {
            return false;
        }
        let mi = &self.drc_info.Metal_info[m as usize];
        let mut temp_metal = Metal { MetalIdx: m, width: mi.width, LinePoint: Vec::new(), MetalRect: contact::default() };
        if mi.direct == 0 {
            if source_point.x == temp_point.x {
                temp_metal.LinePoint = vec![source_point, temp_point];
                temp_path[0].push(temp_metal);
            } else {
                temp_metal.LinePoint.push(source_point);
                source_point.y = if source_point.y > temp_point.y { temp_point.y - mi.width / 2 } else { temp_point.y + mi.width / 2 };
                temp_metal.LinePoint.push(source_point);
                temp_path[0].push(temp_metal.clone());
                temp_metal.LinePoint.clear();
                source_point.y = temp_point.y;
                temp_metal.LinePoint = vec![source_point, temp_point];
                temp_path[0].push(temp_metal);
            }
        } else if source_point.y == temp_point.y {
            temp_metal.LinePoint = vec![source_point, temp_point];
            temp_path[0].push(temp_metal);
        } else {
            temp_metal.LinePoint.push(source_point);
            source_point.x = if source_point.x > temp_point.x { temp_point.x - mi.width / 2 } else { temp_point.x + mi.width / 2 };
            temp_metal.LinePoint.push(source_point);
            temp_path[0].push(temp_metal.clone());
            temp_metal.LinePoint.clear();
            source_point.x = temp_point.x;
            temp_metal.LinePoint = vec![source_point, temp_point];
            temp_path[0].push(temp_metal);
        }
        true
    }

    /// lastmile_*_new 의 앞부분: 같은 층 사각형 안에 있나, 가장 가까운 모서리(LL 이면 +w/2, UR 이면 -w/2)
    fn lastmile_nearest(&self, temp_point: point, m: i32, sinks: &[Sink]) -> (point, bool) {
        let mut point_flag = 0;
        let mut source_point = point::default();
        let mut dis = i32::MAX;
        let mut connected = false;
        for s in sinks {
            if temp_point.x >= s.LL.x && temp_point.y >= s.LL.y && temp_point.x <= s.UR.x && temp_point.y <= s.UR.y && s.metalIdx == m {
                connected = true;
            }
            let d0 = (s.LL.x - temp_point.x).abs() + (s.LL.y - temp_point.y).abs();
            if d0 < dis && s.metalIdx == m {
                dis = d0;
                source_point = s.LL;
                point_flag = 0;
            }
            let d1 = (s.UR.x - temp_point.x).abs() + (s.UR.y - temp_point.y).abs();
            if d1 < dis && s.metalIdx == m {
                dis = d1;
                source_point = s.UR;
                point_flag = 1;
            }
        }
        let h = self.drc_info.Metal_info[m as usize].width / 2;
        if point_flag == 1 {
            source_point.x -= h;
            source_point.y -= h;
        } else {
            source_point.x += h;
            source_point.y += h;
        }
        (source_point, connected)
    }
}

/// UpdateMetalContact (PowerRouter.cpp:375-410 = GcellDetailRouter.cpp:3234-3269) — 두 점의 y 가 같으면
/// 가로로 보고 (폭의 반만큼 위아래), 아니면 세로로. 끝은 늘리지 않는다.
pub(crate) fn UpdateMetalContact(m: &mut Metal) {
    let (p0, p1, h) = (m.LinePoint[0], m.LinePoint[1], m.width / 2);
    let r = &mut m.MetalRect;
    r.metal = m.MetalIdx;
    r.placedCenter = point::new((p0.x + p1.x) / 2, (p0.y + p1.y) / 2);
    if p0.y == p1.y {
        if p0.x < p1.x {
            (r.placedLL, r.placedUR) = (point::new(p0.x, p0.y - h), point::new(p1.x, p1.y + h));
        } else {
            (r.placedLL, r.placedUR) = (point::new(p1.x, p1.y - h), point::new(p0.x, p0.y + h));
        }
    } else if p0.y < p1.y {
        (r.placedLL, r.placedUR) = (point::new(p0.x - h, p0.y), point::new(p1.x + h, p1.y));
    } else {
        (r.placedLL, r.placedUR) = (point::new(p1.x - h, p1.y), point::new(p0.x + h, p0.y));
    }
}

/// ExtendX — 양끝을 d 씩
fn ExtendX(m: &mut Metal, d: i32) {
    if m.LinePoint[0].x < m.LinePoint[1].x {
        m.LinePoint[0].x -= d;
        m.LinePoint[1].x += d;
    } else {
        m.LinePoint[0].x += d;
        m.LinePoint[1].x -= d;
    }
    UpdateMetalContact(m);
}

/// ExtendY — 양끝을 d 씩
fn ExtendY(m: &mut Metal, d: i32) {
    if m.LinePoint[0].y < m.LinePoint[1].y {
        m.LinePoint[0].y -= d;
        m.LinePoint[1].y += d;
    } else {
        m.LinePoint[0].y += d;
        m.LinePoint[1].y -= d;
    }
    UpdateMetalContact(m);
}

/// ExtendX_PN — P 면 x 가 큰 쪽 끝을 늘리고, 아니면 작은 쪽 끝을 늘린다
fn ExtendX_PN(m: &mut Metal, d: i32, P: bool) {
    if P {
        if m.LinePoint[0].x < m.LinePoint[1].x {
            m.LinePoint[1].x += d;
        } else {
            m.LinePoint[0].x += d;
        }
    } else if m.LinePoint[0].x < m.LinePoint[1].x {
        m.LinePoint[0].x -= d;
    } else {
        m.LinePoint[1].x -= d;
    }
    UpdateMetalContact(m);
}

/// ExtendY_PN — P 면 y 가 큰 쪽 끝을 늘린다. P 가 아니면 X 와 달리 y0 < y1 일 때 y1 을 줄이고,
/// 아니면 y0 을 줄인다 (C++ 그대로)
fn ExtendY_PN(m: &mut Metal, d: i32, P: bool) {
    if P {
        if m.LinePoint[0].y < m.LinePoint[1].y {
            m.LinePoint[1].y += d;
        } else {
            m.LinePoint[0].y += d;
        }
    } else if m.LinePoint[0].y < m.LinePoint[1].y {
        m.LinePoint[1].y -= d;
    } else {
        m.LinePoint[0].y -= d;
    }
    UpdateMetalContact(m);
}
