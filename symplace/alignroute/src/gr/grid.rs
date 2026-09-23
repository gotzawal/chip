//! GlobalGrid — 전역 배선의 칸 격자 (router/GlobalGrid.{h,cpp}).
//!
//! 금속층마다 칸 층 하나(tileLayerNo = 1). 칸은 x_unit x y_unit (트랙 scale 개), 칸 번호는 (층, X, Y) 차례.
//! 칸 사이 변의 용량은 경계를 지나는 트랙 수, 비아 변은 넓이 / 비아 간격. 장애물(블록 내부 금속, 모든 핀)을
//! 점으로 흩어 놓고 칸 경계 위의 점 하나마다 1.5 를 뺀다. 버릇은 그대로 둔다:
//! - `AdjustVerticalEdgeCapacityfrom*` 는 칸 번호와 좌표를 섞어 사실상 아무것도 안 한다.
//! - 없는 층을 `metal2tile[m]` 로 읽으면 0 이 들어간다 (모드 5 가 같은 지도를 본다).
//! - 복사 생성자는 IDXmap 을 복사하지 않는다 (`Gcell = GlobalGrid(Initial_Gcell)` 뒤 IDXmap 은 빈 벡터).
#![allow(non_snake_case)]

use super::{at, at_mut, ub};
use crate::db::DrcInfo;
use crate::rdb::{point, terminal, tile, tileEdge, Block, ByPointXY, ByPointYX, NType, Net};
use std::collections::{BTreeMap, BTreeSet};

/// C++ 의 GlobalGrid 멤버 그대로 (모드 5 가 `GR.Gcell` 로 읽는다)
#[derive(Clone, Debug, Default)]
pub struct GlobalGrid {
    /// 칸 크기
    pub x_unit: i32,
    pub y_unit: i32,
    pub metal2tile: BTreeMap<i32, i32>,
    pub tile2metal: BTreeMap<i32, BTreeSet<i32>>,
    /// 칸 층마다 tiles_total 의 첫·끝 번호 (끝 < 첫 이면 그 층에 칸이 없다)
    pub Start_index: Vec<i32>,
    pub End_index: Vec<i32>,
    pub tiles_total: Vec<tile>,
    pub drc_info: DrcInfo,
    /// 칸 층 수
    pub layerNo: i32,
    /// 금속층 수 (Metal_info.size())
    pub metalLayerNo: i32,
    /// 넓힌 Lmetal/Hmetal
    pub lowest_metal: i32,
    pub highest_metal: i32,
    pub maxXidx: i32,
    pub maxYidx: i32,
    pub LL: point,
    pub UR: point,
    /// 칸 층마다 칸 중심 (x, y) -> 칸 번호
    pub XYmap: Vec<BTreeMap<ByPointXY, i32>>,
    pub YXmap: Vec<BTreeMap<ByPointYX, i32>>,
    /// 금속층마다 장애물 점 (가로층은 XYSet, 세로층은 YXSet)
    pub XYSet: Vec<BTreeSet<ByPointXY>>,
    pub YXSet: Vec<BTreeSet<ByPointYX>>,
    /// 칸 층마다 (Xidx, Yidx) -> 칸 번호. 복사하면 비는 것까지 C++ 그대로다.
    pub IDXmap: Vec<BTreeMap<ByPointXY, i32>>,
}

/// `ceil(double(a) / b) * b` / `floor(...)` 를 int 로 (C++ 순서의 double 계산 그대로)
fn ceil_mul(a: i32, b: i32) -> i32 {
    ((f64::from(a) / f64::from(b)).ceil() * f64::from(b)) as i32
}

fn floor_div(a: i32, b: i32) -> i32 {
    (f64::from(a) / f64::from(b)).floor() as i32
}

fn ceil_div(a: i32, b: i32) -> i32 {
    (f64::from(a) / f64::from(b)).ceil() as i32
}

/// 걸음이 0 이하면 C++ 의 격자 반복이 끝나지 않는다
fn step_ok(unit: i32, what: &str) -> Result<(), String> {
    if unit > 0 { Ok(()) } else { Err(format!("GlobalGrid: {what} = {unit} (C++ 에서는 반복이 끝나지 않는다)")) }
}

impl GlobalGrid {
    /// GlobalGrid(drc_info, LLx, LLy, URx, URy, Lmetal, Hmetal, tileLayerNo, scale)
    #[allow(clippy::too_many_arguments)]
    pub fn new(drc_info: &DrcInfo, LLx: i32, LLy: i32, URx: i32, URy: i32, Lmetal: i32, Hmetal: i32, tileLayerNo: i32,
               scale: i32) -> Result<Self, String> {
        let mut g = GlobalGrid { lowest_metal: Lmetal, highest_metal: Hmetal, ..Default::default() };
        g.layerNo = (f64::from(Hmetal.wrapping_sub(Lmetal).wrapping_add(1)) / f64::from(tileLayerNo)).ceil() as i32;
        g.metalLayerNo = drc_info.Metal_info.len() as i32;
        let nl = usize::try_from(g.layerNo).map_err(|_| format!("std::length_error: vector (layerNo = {})", g.layerNo))?;
        g.Start_index = vec![0; nl];
        g.End_index = vec![-1; nl];
        g.XYmap = vec![BTreeMap::new(); nl];
        g.YXmap = vec![BTreeMap::new(); nl];
        g.XYSet = vec![BTreeSet::new(); drc_info.Metal_info.len()];
        g.YXSet = vec![BTreeSet::new(); drc_info.Metal_info.len()];
        g.IDXmap = vec![BTreeMap::new(); nl];
        g.drc_info = drc_info.clone();
        g.LL = point::new(LLx, LLy);
        g.UR = point::new(URx, URy);
        g.maxXidx = 0;
        g.maxYidx = 0;

        let mi = &drc_info.Metal_info;
        if at(mi, Lmetal, "Metal_info")?.direct == 0 {
            // 세로
            g.x_unit = at(mi, Lmetal, "Metal_info")?.grid_unit_x.wrapping_mul(scale);
            g.y_unit = at(mi, Lmetal.wrapping_add(1), "Metal_info")?.grid_unit_y.wrapping_mul(scale);
        } else {
            g.x_unit = at(mi, Lmetal.wrapping_add(1), "Metal_info")?.grid_unit_x.wrapping_mul(scale);
            g.y_unit = at(mi, Lmetal, "Metal_info")?.grid_unit_y.wrapping_mul(scale);
        }

        // 1. 칸
        let mut i = Lmetal;
        while i <= Hmetal {
            let layerIdx = (i - Lmetal) / tileLayerNo;
            g.tile2metal.entry(layerIdx).or_default().clear();
            let mut tmpV = Vec::new();
            let mut j = 0;
            while j < tileLayerNo && i + j <= Hmetal {
                g.metal2tile.insert(i + j, layerIdx);
                g.tile2metal.entry(layerIdx).or_default().insert(i + j);
                tmpV.push(i + j);
                j += 1;
            }
            *at_mut(&mut g.Start_index, layerIdx, "Start_index")? = g.tiles_total.len() as i32;
            if g.LL.x < g.UR.x {
                step_ok(g.x_unit, "x_unit")?;
            }
            let mut X = g.LL.x;
            while X < g.UR.x {
                let Xidx = X.wrapping_sub(g.LL.x) / g.x_unit;
                if Xidx > g.maxXidx {
                    g.maxXidx = Xidx;
                }
                let mut tmpT = tile::default();
                tmpT.width = if X.wrapping_add(g.x_unit) > g.UR.x { g.UR.x.wrapping_sub(X) } else { g.x_unit };
                tmpT.x = X.wrapping_add(tmpT.width / 2);
                if g.LL.y < g.UR.y {
                    step_ok(g.y_unit, "y_unit")?;
                }
                let mut Y = g.LL.y;
                while Y < g.UR.y {
                    let Yidx = Y.wrapping_sub(g.LL.y) / g.y_unit;
                    if Yidx > g.maxYidx {
                        g.maxYidx = Yidx;
                    }
                    tmpT.height = if Y.wrapping_add(g.y_unit) > g.UR.y { g.UR.y.wrapping_sub(Y) } else { g.y_unit };
                    tmpT.y = Y.wrapping_add(tmpT.height / 2);
                    tmpT.index = g.tiles_total.len() as i32;
                    tmpT.metal = tmpV.clone();
                    tmpT.Xidx = Xidx;
                    tmpT.Yidx = Yidx;
                    tmpT.tileLayer = layerIdx;
                    let tmpP = point::new(tmpT.x, tmpT.y);
                    g.tiles_total.push(tmpT.clone());
                    let last = g.tiles_total.len() as i32 - 1;
                    at_mut(&mut g.XYmap, layerIdx, "XYmap")?.entry(ByPointXY(tmpP)).or_insert(last);
                    at_mut(&mut g.YXmap, layerIdx, "YXmap")?.entry(ByPointYX(tmpP)).or_insert(last);
                    at_mut(&mut g.IDXmap, layerIdx, "IDXmap")?.entry(ByPointXY(point::new(Xidx, Yidx))).or_insert(last);
                    Y = Y.wrapping_add(g.y_unit);
                }
                X = X.wrapping_add(g.x_unit);
            }
            *at_mut(&mut g.End_index, layerIdx, "End_index")? = g.tiles_total.len() as i32 - 1;
            i = i.wrapping_add(tileLayerNo);
        }

        // 2. 칸 사이 변: 세로층은 (x, y) 순서로 같은 x 의 이웃을 북/남, 가로층은 (y, x) 순서로 같은 y 를 동/서
        for i in Lmetal..=Hmetal {
            let layerIdx = *g.metal2tile.entry(i).or_insert(0);
            let m = at(mi, i, "Metal_info")?;
            if m.direct == 0 {
                let pairs: Vec<(point, i32, point, i32)> = {
                    let map = at(&g.XYmap, layerIdx, "XYmap")?;
                    map.iter().zip(map.iter().skip(1)).map(|(a, b)| (a.0.0, *a.1, b.0.0, *b.1)).collect()
                };
                for (p1, pre, p2, post) in pairs {
                    if p1.x != p2.x {
                        continue;
                    }
                    let gu = m.grid_unit_x;
                    let t = at_mut(&mut g.tiles_total, pre, "tiles_total")?;
                    let c = div(t.width, gu)?;
                    if t.north.is_empty() {
                        t.north.push(tileEdge { next: post, capacity: c });
                    } else {
                        t.north[0].capacity = t.north[0].capacity.wrapping_add(c);
                    }
                    let t = at_mut(&mut g.tiles_total, post, "tiles_total")?;
                    let c = div(t.width, gu)?;
                    if t.south.is_empty() {
                        t.south.push(tileEdge { next: pre, capacity: c });
                    } else {
                        t.south[0].capacity = t.south[0].capacity.wrapping_add(c);
                    }
                }
            } else {
                let pairs: Vec<(point, i32, point, i32)> = {
                    let map = at(&g.YXmap, layerIdx, "YXmap")?;
                    map.iter().zip(map.iter().skip(1)).map(|(a, b)| (a.0.0, *a.1, b.0.0, *b.1)).collect()
                };
                for (p1, pre, p2, post) in pairs {
                    if p1.y != p2.y {
                        continue;
                    }
                    let gu = m.grid_unit_y;
                    let t = at_mut(&mut g.tiles_total, pre, "tiles_total")?;
                    let c = div(t.height, gu)?;
                    if t.east.is_empty() {
                        t.east.push(tileEdge { next: post, capacity: c });
                    } else {
                        t.east[0].capacity = t.east[0].capacity.wrapping_add(c);
                    }
                    let t = at_mut(&mut g.tiles_total, post, "tiles_total")?;
                    let c = div(t.height, gu)?;
                    if t.west.is_empty() {
                        t.west.push(tileEdge { next: pre, capacity: c });
                    } else {
                        t.west[0].capacity = t.west[0].capacity.wrapping_add(c);
                    }
                }
            }
        }
        // 비아 변: 한 층 위 같은 (x, y) 의 칸. 용량 = (long)(w*h) / ((비아 폭 + 간격) x (비아 높이 + 간격))
        for k in 0..g.layerNo - 1 {
            let (s, e) = (*at(&g.Start_index, k, "Start_index")?, *at(&g.End_index, k, "End_index")?);
            for i in s..=e {
                let t = at(&g.tiles_total, i, "tiles_total")?;
                let tmpp = point::new(t.x, t.y);
                let found = at(&g.XYmap, k + 1, "XYmap")?.get(&ByPointXY(tmpp)).copied();
                if let Some(next) = found {
                    let t = at(&g.tiles_total, i, "tiles_total")?;
                    let viaNo = *t.metal.last().ok_or_else(|| ub("tile.metal.back() (빈 층)"))?;
                    let v = at(&drc_info.Via_info, viaNo, "Via_info")?;
                    let viaSize = v.width.wrapping_add(v.dist_ss).wrapping_mul(v.width_y.wrapping_add(v.dist_ss_y));
                    let tileSize = t.width.wrapping_mul(t.height);
                    let cap = div(tileSize, viaSize)?;
                    at_mut(&mut g.tiles_total, i, "tiles_total")?.up.push(tileEdge { next, capacity: cap });
                    at_mut(&mut g.tiles_total, next, "tiles_total")?.down.push(tileEdge { next: i, capacity: cap });
                }
            }
        }
        Ok(g)
    }

    // ---- GlobalGrid.h 의 인라인 접근자 (모드 5 의 Grid(GlobalGrid&, ...) 가 쓴다). `.at` 은 Err 로.
    pub fn GetTileLayerNum(&self) -> i32 {
        self.layerNo
    }
    pub fn GetMaxXidx(&self) -> i32 {
        self.maxXidx
    }
    pub fn GetMaxYidx(&self) -> i32 {
        self.maxYidx
    }
    /// 없으면 -1
    pub fn GetMappedLayerIndex(&self, metalIdx: i32) -> i32 {
        self.metal2tile.get(&metalIdx).copied().unwrap_or(-1)
    }
    pub fn GetTileLayer(&self, tidx: i32) -> Result<i32, String> {
        Ok(at(&self.tiles_total, tidx, "tiles_total")?.tileLayer)
    }
    pub fn GetTileXidx(&self, tidx: i32) -> Result<i32, String> {
        Ok(at(&self.tiles_total, tidx, "tiles_total")?.Xidx)
    }
    pub fn GetTileYidx(&self, tidx: i32) -> Result<i32, String> {
        Ok(at(&self.tiles_total, tidx, "tiles_total")?.Yidx)
    }
    /// `tile2metal[layerIdx]` — operator[] 라 없는 칸 층은 빈 집합으로 들어간다
    pub fn GetMappedMetalIndex(&mut self, layerIdx: i32) -> BTreeSet<i32> {
        self.tile2metal.entry(layerIdx).or_default().clone()
    }
    pub fn GetTileX(&self, tidx: i32) -> Result<i32, String> {
        Ok(at(&self.tiles_total, tidx, "tiles_total")?.x)
    }
    pub fn GetTileY(&self, tidx: i32) -> Result<i32, String> {
        Ok(at(&self.tiles_total, tidx, "tiles_total")?.y)
    }
    pub fn GetTileWidth(&self, tidx: i32) -> Result<i32, String> {
        Ok(at(&self.tiles_total, tidx, "tiles_total")?.width)
    }
    pub fn GetTileHeight(&self, tidx: i32) -> Result<i32, String> {
        Ok(at(&self.tiles_total, tidx, "tiles_total")?.height)
    }

    /// 복사 생성자 — IDXmap 만 빼고 복사한다 (C++ 초기화 목록에 IDXmap 이 없다)
    pub fn copy(other: &GlobalGrid) -> GlobalGrid {
        GlobalGrid {
            x_unit: other.x_unit,
            y_unit: other.y_unit,
            metal2tile: other.metal2tile.clone(),
            tile2metal: other.tile2metal.clone(),
            Start_index: other.Start_index.clone(),
            End_index: other.End_index.clone(),
            tiles_total: other.tiles_total.clone(),
            drc_info: other.drc_info.clone(),
            layerNo: other.layerNo,
            metalLayerNo: other.metalLayerNo,
            lowest_metal: other.lowest_metal,
            highest_metal: other.highest_metal,
            maxXidx: other.maxXidx,
            maxYidx: other.maxYidx,
            LL: other.LL,
            UR: other.UR,
            XYmap: other.XYmap.clone(),
            YXmap: other.YXmap.clone(),
            XYSet: other.XYSet.clone(),
            YXSet: other.YXSet.clone(),
            IDXmap: Vec::new(),
        }
    }

    /// 사각형을 점으로: 세로층은 y 를 y_unit 배수(절대 좌표), x 를 트랙(grid_unit_x) 배수로 YXSet 에,
    /// 가로층은 x 를 x_unit 배수, y 를 트랙(grid_unit_y) 배수로 XYSet 에
    pub fn ConvertRect2Points(&mut self, metalIdx: i32, LLx: i32, LLy: i32, URx: i32, URy: i32) -> Result<(), String> {
        let m = at(&self.drc_info.Metal_info, metalIdx, "Metal_info")?;
        if m.direct == 0 {
            let mainUnit = self.y_unit;
            let minUnit = m.grid_unit_x;
            let LLy_cc = ceil_mul(LLy, mainUnit);
            let LLx_cc = ceil_mul(LLx, minUnit);
            let set = at_mut(&mut self.YXSet, metalIdx, "YXSet")?;
            let mut y = LLy_cc;
            while y <= URy {
                step_ok(mainUnit, "y_unit")?;
                let mut x = LLx_cc;
                while x <= URx {
                    step_ok(minUnit, "grid_unit_x")?;
                    set.insert(ByPointYX(point::new(x, y)));
                    x = x.wrapping_add(minUnit);
                }
                y = y.wrapping_add(mainUnit);
            }
        } else {
            let mainUnit = self.x_unit;
            let minUnit = m.grid_unit_y;
            let LLy_cc = ceil_mul(LLy, minUnit);
            let LLx_cc = ceil_mul(LLx, mainUnit);
            let set = at_mut(&mut self.XYSet, metalIdx, "XYSet")?;
            let mut y = LLy_cc;
            while y <= URy {
                step_ok(minUnit, "grid_unit_y")?;
                let mut x = LLx_cc;
                while x <= URx {
                    step_ok(mainUnit, "x_unit")?;
                    set.insert(ByPointXY(point::new(x, y)));
                    x = x.wrapping_add(mainUnit);
                }
                y = y.wrapping_add(minUnit);
            }
        }
        Ok(())
    }

    /// 금속을 간격만큼 불리고(세로층: x 로 dist_ss, y 로 dist_ee — 가로층은 반대) 다이로 자른 뒤 점으로
    pub fn ConvertMetal2Points(&mut self, mIdx: i32, x: i32, y: i32, X: i32, Y: i32) -> Result<(), String> {
        let (mut LLx, mut LLy, mut URx, mut URy) = (x, y, X, Y);
        let m = at(&self.drc_info.Metal_info, mIdx, "Metal_info")?;
        if m.direct == 0 {
            LLx = LLx.wrapping_sub(m.dist_ss);
            URx = URx.wrapping_add(m.dist_ss);
            LLy = LLy.wrapping_sub(m.dist_ee);
            URy = URy.wrapping_add(m.dist_ee);
        } else {
            LLx = LLx.wrapping_sub(m.dist_ee);
            URx = URx.wrapping_add(m.dist_ee);
            LLy = LLy.wrapping_sub(m.dist_ss);
            URy = URy.wrapping_add(m.dist_ss);
        }
        if LLx < self.LL.x {
            LLx = self.LL.x;
        }
        if LLy < self.LL.y {
            LLy = self.LL.y;
        }
        if URx > self.UR.x {
            URx = self.UR.x;
        }
        if URy > self.UR.y {
            URy = self.UR.y;
        }
        self.ConvertRect2Points(mIdx, LLx, LLy, URx, URy)
    }

    /// 블록 내부 금속 전부 (층을 못 찾은 금속 -1 은 Metal_info.at(-1) 에서 던진다)
    pub fn ConvertGlobalInternalMetal(&mut self, Blocks: &[Block]) -> Result<(), String> {
        for b in Blocks {
            for p in &b.InternalMetal {
                self.ConvertMetal2Points(p.metal, p.placedLL.x, p.placedLL.y, p.placedUR.x, p.placedUR.y)?;
            }
        }
        Ok(())
    }

    /// excNet 이 아닌 모든 넷의 블록 핀 접점 (부르는 쪽은 excNet = Nets.size() — 자기 핀까지 전부 장애물이다)
    pub fn ConvertGlobalBlockPin(&mut self, Blocks: &[Block], Nets: &[Net], excNet: i32) -> Result<(), String> {
        for (ni, n) in Nets.iter().enumerate() {
            if ni as i32 == excNet {
                continue;
            }
            for c in &n.connected {
                if c.type_ == NType::BLOCK {
                    let pin = at(&at(Blocks, c.iter2, "Blocks")?.pins, c.iter, "pins")?;
                    for p in &pin.pinContacts {
                        self.ConvertMetal2Points(p.metal, p.placedLL.x, p.placedLL.y, p.placedUR.x, p.placedUR.y)?;
                    }
                }
            }
        }
        Ok(())
    }

    /// 칸 경계 위의 장애물 점마다 용량 1.5 를 빼고(int 로 자르고) 0 에서 막는다. 구간은 사전 순
    /// [lower_bound(한 끝), upper_bound(다른 끝)] — 세로층: 남 = y==LLy 이고 LLx<=x<=URx, 북 = y==URy;
    /// 가로층: 서 = x==LLx 이고 LLy<=y<=URy, 동 = x==URx.
    pub fn AdjustPlateEdgeCapacity(&mut self) -> Result<(), String> {
        let scale_number = 1.5f64;
        for k in 0..self.layerNo {
            let (s, e) = (*at(&self.Start_index, k, "Start_index")?, *at(&self.End_index, k, "End_index")?);
            for i in s..=e {
                let t = at(&self.tiles_total, i, "tiles_total")?;
                let (x, y, w, h) = (t.x, t.y, t.width, t.height);
                let LLx = x.wrapping_sub(w / 2);
                let LLy = y.wrapping_sub(h / 2);
                let URx = x.wrapping_add(w / 2);
                let URy = y.wrapping_add(h / 2);
                let LL = point::new(LLx, LLy);
                let UL = point::new(LLx, URy);
                let UR = point::new(URx, URy);
                let LR = point::new(URx, LLy);
                let metals = t.metal.clone();
                for mIdx in metals {
                    let direct = at(&self.drc_info.Metal_info, mIdx, "Metal_info")?.direct;
                    if direct == 0 {
                        let set = at(&self.YXSet, mIdx, "YXSet")?;
                        let south = count_range(set, ByPointYX(LL), ByPointYX(LR));
                        let north = count_range(set, ByPointYX(UL), ByPointYX(UR));
                        let t = at_mut(&mut self.tiles_total, i, "tiles_total")?;
                        sub_cap(&mut t.south, south, scale_number);
                        sub_cap(&mut t.north, north, scale_number);
                    } else {
                        let set = at(&self.XYSet, mIdx, "XYSet")?;
                        let west = count_range(set, ByPointXY(LL), ByPointXY(UL));
                        let east = count_range(set, ByPointXY(LR), ByPointXY(UR));
                        let t = at_mut(&mut self.tiles_total, i, "tiles_total")?;
                        sub_cap(&mut t.west, west, scale_number);
                        sub_cap(&mut t.east, east, scale_number);
                    }
                }
            }
        }
        Ok(())
    }

    /// 블록 내부 비아로 비아 용량 2 씩 — 좌표를 칸 크기로 나눈 값(칸 번호 꼴)으로 칸 중심 지도를 찾아서
    /// 사실상 맞는 일이 없다. 그대로 옮긴다.
    pub fn AdjustVerticalEdgeCapacityfromInternalMetal(&mut self, Blocks: &[Block]) -> Result<(), String> {
        for k in 0..self.layerNo - 1 {
            let (s, e) = (*at(&self.Start_index, k, "Start_index")?, *at(&self.End_index, k, "End_index")?);
            if s > e {
                continue;
            }
            let viaNo = *at(&self.tiles_total, s, "tiles_total")?.metal.last().ok_or_else(|| ub("tile.metal.back() (빈 층)"))?;
            for b in Blocks {
                for v in &b.InternalVia {
                    if viaNo == at(&self.drc_info.Via_model, v.model_index, "Via_model")?.ViaIdx {
                        self.adjust_via_cap(k, v.position)?;
                    }
                }
            }
        }
        Ok(())
    }

    /// 넷의 블록 핀 비아로 비아 용량 2 씩 (InternalMetal 판과 같은 버릇)
    pub fn AdjustVerticalEdgeCapacityfromBlockPin(&mut self, Blocks: &[Block], Nets: &[Net], excNet: i32) -> Result<(), String> {
        for k in 0..self.layerNo - 1 {
            let (s, e) = (*at(&self.Start_index, k, "Start_index")?, *at(&self.End_index, k, "End_index")?);
            if s > e {
                continue;
            }
            let viaNo = *at(&self.tiles_total, s, "tiles_total")?.metal.last().ok_or_else(|| ub("tile.metal.back() (빈 층)"))?;
            for (ni, n) in Nets.iter().enumerate() {
                if ni as i32 == excNet {
                    continue;
                }
                for c in &n.connected {
                    if c.type_ == NType::BLOCK {
                        let pin = at(&at(Blocks, c.iter2, "Blocks")?.pins, c.iter, "pins")?;
                        for v in &pin.pinVias {
                            if viaNo == at(&self.drc_info.Via_model, v.model_index, "Via_model")?.ViaIdx {
                                self.adjust_via_cap(k, v.position)?;
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }

    /// AdjustVerticalEdgeCapacityfrom* 의 몸통: floor/ceil(pos / unit) 을 다이 좌표로 자르고 가운데를 칸 중심 지도에서 찾는다
    fn adjust_via_cap(&mut self, k: i32, pos: point) -> Result<(), String> {
        let scale_number = 2.0f64;
        let mut LLx = floor_div(pos.x, self.x_unit);
        let mut URx = ceil_div(pos.x, self.x_unit);
        let mut LLy = floor_div(pos.y, self.y_unit);
        let mut URy = ceil_div(pos.y, self.y_unit);
        if LLx < self.LL.x {
            LLx = self.LL.x;
        }
        if LLy < self.LL.y {
            LLy = self.LL.y;
        }
        if URx > self.UR.x {
            URx = self.UR.x;
        }
        if URy > self.UR.y {
            URy = self.UR.y;
        }
        let tmpp = point::new(LLx.wrapping_add(URx) / 2, LLy.wrapping_add(URy) / 2);
        if let Some(&ti) = at(&self.XYmap, k, "XYmap")?.get(&ByPointXY(tmpp)) {
            let t = at_mut(&mut self.tiles_total, ti, "tiles_total")?;
            if !t.up.is_empty() {
                t.up[0].capacity = (f64::from(t.up[0].capacity) - scale_number) as i32;
                if t.up[0].capacity < 0 {
                    t.up[0].capacity = 0;
                }
            }
        }
        if let Some(&ti) = at(&self.XYmap, k + 1, "XYmap")?.get(&ByPointXY(tmpp)) {
            let t = at_mut(&mut self.tiles_total, ti, "tiles_total")?;
            if !t.down.is_empty() {
                t.down[0].capacity = (f64::from(t.down[0].capacity) - scale_number) as i32;
                if t.down[0].capacity < 0 {
                    t.down[0].capacity = 0;
                }
            }
        }
        Ok(())
    }

    /// 핀 사각형이 걸치는 칸들 (x_unit 격자로 내린 LL 부터 UR 앞까지) 의 중심을 그 층 지도에서 찾는다.
    /// 없는 층은 `metal2tile[m]` 이 0 을 넣어 0 번 칸 층으로 간다.
    #[allow(clippy::too_many_arguments)]
    pub fn ConvertNetBlockPin(&mut self, sSet: &mut BTreeSet<i32>, sVec: &mut Vec<i32>, metalIdx: i32, LLx: i32, LLy: i32,
                              URx: i32, URy: i32) -> Result<(), String> {
        let layerIdx = *self.metal2tile.entry(metalIdx).or_insert(0);
        let xu = self.x_unit;
        let yu = self.y_unit;
        let LLx_cc = ((f64::from(LLx.wrapping_sub(self.LL.x)) / f64::from(xu)).floor() * f64::from(xu) + f64::from(self.LL.x)) as i32;
        let LLy_cc = ((f64::from(LLy.wrapping_sub(self.LL.y)) / f64::from(yu)).floor() * f64::from(yu) + f64::from(self.LL.y)) as i32;
        let mut x = LLx_cc;
        while x < URx {
            step_ok(xu, "x_unit")?;
            let mut y = LLy_cc;
            while y < URy {
                step_ok(yu, "y_unit")?;
                let tx = if x.wrapping_add(xu) > self.UR.x { x.wrapping_add(self.UR.x.wrapping_sub(x) / 2) } else { x.wrapping_add(xu / 2) };
                let ty = if y.wrapping_add(yu) > self.UR.y { y.wrapping_add(self.UR.y.wrapping_sub(y) / 2) } else { y.wrapping_add(yu / 2) };
                if let Some(&ti) = at(&self.XYmap, layerIdx, "XYmap")?.get(&ByPointXY(point::new(tx, ty))) {
                    sSet.insert(ti);
                    sVec.push(ti);
                }
                y = y.wrapping_add(yu);
            }
            x = x.wrapping_add(xu);
        }
        Ok(())
    }

    /// 넷마다 연결(connected) 하나에 칸 묶음 하나 (connectedTile, 겹침 그대로), terminals = 그 합집합 (정렬, 유일).
    /// 단자 연결은 terminal_routing 이 0 이라 빈 묶음으로 남는다.
    pub fn SetNetSink(&mut self, Blocks: &[Block], Nets: &mut [Net], Terminals: &[terminal], terminal_routing: bool) -> Result<(), String> {
        for n in Nets.iter_mut() {
            let cNO = n.connected.len();
            n.terminals.clear();
            n.connectedTile.clear();
            n.connectedTile.resize(cNO, Vec::new());
            let mut tSet = BTreeSet::new();
            for i in 0..cNO {
                let c = n.connected[i];
                if c.type_ == NType::BLOCK {
                    let pin = at(&at(Blocks, c.iter2, "Blocks")?.pins, c.iter, "pins")?;
                    for p in &pin.pinContacts {
                        self.ConvertNetBlockPin(&mut tSet, &mut n.connectedTile[i], p.metal, p.placedLL.x, p.placedLL.y, p.placedUR.x,
                                                p.placedUR.y)?;
                    }
                } else if terminal_routing {
                    for p in &at(Terminals, c.iter, "Terminals")?.termContacts {
                        self.ConvertNetBlockPin(&mut tSet, &mut n.connectedTile[i], p.metal, p.placedLL.x, p.placedLL.y, p.placedUR.x,
                                                p.placedUR.y)?;
                    }
                }
            }
            n.terminals.extend(tSet);
        }
        Ok(())
    }
}

/// long / int (0 으로 나누면 C++ 은 죽는다)
fn div(a: i32, b: i32) -> Result<i32, String> {
    if b == 0 { Err(ub("0 으로 나누기 (용량)")) } else { Ok(a.wrapping_div(b)) }
}

/// [lower_bound(lo), upper_bound(hi)) 의 원소 수 (lo <= hi 일 때 = lo..=hi)
fn count_range<K: Ord>(set: &BTreeSet<K>, lo: K, hi: K) -> i32 {
    if lo > hi {
        // C++ 은 end() 를 지나 돈다 — 칸 폭이 양수라 생기지 않는다
        return 0;
    }
    set.range(lo..=hi).count() as i32
}

/// `cap -= n * 1.5` (int = (int)(double(cap) - n*1.5)), 0 아래면 0
fn sub_cap(edges: &mut [tileEdge], n: i32, scale_number: f64) {
    if let Some(e) = edges.first_mut() {
        e.capacity = (f64::from(e.capacity) - f64::from(n) * scale_number) as i32;
        if e.capacity < 0 {
            e.capacity = 0;
        }
    }
}
