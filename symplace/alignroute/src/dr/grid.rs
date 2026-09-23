//! Grid — 넷 하나의 상세 격자 (router/Grid.cpp). 모드 5 는 `Grid(GlobalGrid&, ST, ...)` 생성자
//! (Grid.cpp:3140-3553) 와 출발·도착 옮기기(setSrcDest, setSrcDest_detail) 만 쓴다.
//!
//! 꼭짓점 번호는 트랙 순서다: 층마다, 전역 경로의 칸이 이어진 트랙(세로층은 칸 열, 가로층은 칸 행)마다,
//! 트랙 안의 선(세로층은 X, 가로층은 Y)마다, 선 위의 점(이웃 층 트랙과 만나는 곳) 순서. 칸 경계의 선은
//! 두 트랙에 다 생겨서 **같은 점에 꼭짓점이 둘** 생긴다 — 지도(vertices_total_map)는 먼저 것을 가리키고,
//! 아래층과의 연결은 나중 것이 이긴다 (위층 꼭짓점의 down 을 덮어쓴다). A* 의 늘리기 걸음과 L 자 걸음이
//! 번호 ±1 로 걷기 때문에 이 번호 매김이 결과에 닿는다.
//!
//! north/south/east/west 는 C++ 에서 vector 지만 이 생성자는 같은 선의 바로 앞 꼭짓점(번호 -1) 하나만
//! 잇는다 — 그래서 방향마다 많아야 하나다. -1 은 없음.
use super::util::{FxMap, ceil_off, f2i};
use crate::db::DrcInfo;
use crate::gr::GlobalGrid;
use crate::rdb::point;
use std::collections::BTreeSet;

/// RouterDB::vertex 에서 모드 5 가 쓰는 필드 (기본값은 Rdatatype.h 그대로)
#[derive(Clone, Debug)]
pub struct Vertex {
    pub x: i32,
    pub y: i32,
    pub metal: i32,
    pub Cost: f64,
    pub Cost2Source: f64,
    pub active: bool,
    pub via_active_down: bool,
    pub via_active_up: bool,
    pub parent: i32,
    pub trace_back_node: i32,
    pub north: i32,
    pub south: i32,
    pub east: i32,
    pub west: i32,
    pub down: i32,
    pub up: i32,
}

impl Default for Vertex {
    fn default() -> Self {
        Vertex {
            x: -1,
            y: -1,
            metal: -1,
            Cost: f64::MAX,
            Cost2Source: f64::MAX,
            active: false,
            via_active_down: true,
            via_active_up: true,
            parent: -1,
            trace_back_node: -1,
            north: -1,
            south: -1,
            east: -1,
            west: -1,
            down: -1,
            up: -1,
        }
    }
}

/// SinkData — 이 흐름의 출발·도착·장애물은 늘 점 둘 [LL, UR] 이다
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sink {
    pub LL: point,
    pub UR: point,
    pub metalIdx: i32,
}

pub struct Grid<'a> {
    pub drc_info: &'a DrcInfo,
    pub vertices_total: Vec<Vertex>,
    pub Start_index_metal_vertices: Vec<i32>,
    pub End_index_metal_vertices: Vec<i32>,
    pub Source: Vec<i32>,
    pub Dest: Vec<i32>,
    pub x_unit: Vec<i32>,
    pub y_unit: Vec<i32>,
    pub x_min: Vec<i32>,
    pub y_min: Vec<i32>,
    pub GridLL: point,
    pub GridUR: point,
    /// 층마다 (x, y) -> 번호 (C++ std::map 의 insert: 먼저 것이 남는다)
    pub vertices_total_map: Vec<FxMap<(i32, i32), i32>>,
    /// 꼭짓점이 하나도 없는 격자에서 `map[p]` 가 넣은 점들 (층마다, pointXYComp 순) — PrepareGraphVertices 만 본다
    pub map_inserted: Vec<BTreeSet<(i32, i32)>>,
    pub lowest_metal: i32,
    pub highest_metal: i32,
    pub grid_scale: i32,
    pub layerNo: i32,
    pub center_x: i32,
    pub center_y: i32,
}

fn at<'v, T>(v: &'v [T], i: i32, what: &str) -> Result<&'v T, String> {
    usize::try_from(i).ok().and_then(|u| v.get(u)).ok_or_else(|| format!("std::out_of_range: vector ({what}.at({i}), 크기 {})", v.len()))
}

/// 걸음이 0 이하면 C++ 의 격자 반복이 끝나지 않는다
fn step_ok(u: i32, what: &str) -> Result<(), String> {
    if u > 0 { Ok(()) } else { Err(format!("Grid: {what} = {u} (C++ 에서는 반복이 끝나지 않는다)")) }
}

/// `for (int v = lo; v <= hi; v += step)` 의 값들 (넘침 없이)
fn steps(lo: i32, hi: i32, step: i32, out: &mut BTreeSet<i32>) {
    let mut v = lo as i64;
    while v <= hi as i64 {
        out.insert(v as i32);
        v += step as i64;
    }
}

impl<'a> Grid<'a> {
    /// Grid::Grid(GlobalGrid& GG, ST, drc_info, ll, ur, Lmetal, Hmetal, grid_scale) — Grid.cpp:3140-3553
    #[allow(clippy::too_many_arguments)]
    pub fn new(GG: &GlobalGrid, ST: &[(i32, i32)], drc_info: &'a DrcInfo, ll: point, ur: point, Lmetal: i32, Hmetal: i32,
               grid_scale: i32) -> Result<Self, String> {
        let layerNo = drc_info.Metal_info.len() as i32;
        let n = layerNo as usize;
        let mut g = Grid {
            drc_info,
            vertices_total: Vec::new(),
            Start_index_metal_vertices: vec![0; n],
            End_index_metal_vertices: vec![-1; n],
            Source: Vec::new(),
            Dest: Vec::new(),
            x_unit: vec![0; n],
            y_unit: vec![0; n],
            x_min: vec![0; n],
            y_min: vec![0; n],
            GridLL: point::new(i32::MAX, i32::MAX),
            GridUR: point::new(i32::MIN, i32::MIN),
            vertices_total_map: (0..n).map(|_| FxMap::default()).collect(),
            map_inserted: vec![BTreeSet::new(); n],
            lowest_metal: Lmetal,
            highest_metal: Hmetal,
            grid_scale,
            layerNo,
            center_x: 0,
            center_y: 0,
        };
        let MI = &drc_info.Metal_info;
        // 3. 층마다 격자 간격
        for (i, m) in MI.iter().enumerate().take(n) {
            if m.direct == 0 {
                g.x_unit[i] = m.grid_unit_x.wrapping_mul(grid_scale);
                g.y_min[i] = 1;
            } else if m.direct == 1 {
                g.y_unit[i] = m.grid_unit_y.wrapping_mul(grid_scale);
                g.x_min[i] = 1;
            }
        }
        // 4. 칸 층마다 (Y, X) / (X, Y) 표에 전역 경로의 칸을 적는다
        let tln = GG.layerNo;
        let (mx, my) = (GG.maxXidx, GG.maxYidx);
        if tln < 0 || mx < -1 || my < -1 {
            return Err(format!("Grid: 칸 표 크기가 음수다 (층 {tln}, X {mx}, Y {my})"));
        }
        let (nx, ny) = ((mx + 1) as usize, (my + 1) as usize);
        let mut Hgrid: Vec<Vec<Vec<i32>>> = (0..tln).map(|_| vec![vec![-1; nx]; ny]).collect();
        let mut Vgrid: Vec<Vec<Vec<i32>>> = (0..tln).map(|_| vec![vec![-1; ny]; nx]).collect();
        let tile = |idx: i32| at(&GG.tiles_total, idx, "tiles_total");
        for &(a, b) in ST {
            for idx in [a, b] {
                let t = tile(idx)?;
                let (tl, xi, yi) = (t.tileLayer, t.Xidx, t.Yidx);
                let h = at(&Hgrid, tl, "Hgrid")?;
                at(at(h, yi, "Hgrid[l]")?, xi, "Hgrid[l][y]")?;
                Hgrid[tl as usize][yi as usize][xi as usize] = idx;
                let v = at(&Vgrid, tl, "Vgrid")?;
                at(at(v, xi, "Vgrid[l]")?, yi, "Vgrid[l][x]")?;
                Vgrid[tl as usize][xi as usize][yi as usize] = idx;
            }
        }
        // 5. 트랙 (이어진 칸 묶음의 첫·끝 칸)
        let mut tracks: Vec<Vec<(i32, i32)>> = vec![Vec::new(); n];
        let empty = BTreeSet::new();
        for i in 0..tln as usize {
            // GetMappedMetalIndex 는 tile2metal[i] (없으면 빈 것을 넣는다 — 결과에 안 닿는다)
            let midx = GG.tile2metal.get(&(i as i32)).unwrap_or(&empty);
            for &m in midx {
                let direct = at(MI, m, "Metal_info")?.direct;
                let mut out = Vec::new();
                if direct == 0 {
                    for col in &Vgrid[i] {
                        let mut start = -1;
                        for y in 0..col.len() {
                            if start == -1 {
                                if col[y] != -1 {
                                    start = col[y];
                                }
                            } else if col[y] == -1 {
                                out.push((start, col[y - 1]));
                                start = -1;
                            }
                        }
                        if start != -1 {
                            out.push((start, col[col.len() - 1]));
                        }
                    }
                } else {
                    for row in &Hgrid[i] {
                        let mut start = -1;
                        for x in 0..row.len() {
                            if start == -1 {
                                if row[x] != -1 {
                                    start = row[x];
                                }
                            } else if row[x] == -1 {
                                out.push((start, row[x - 1]));
                                start = -1;
                            }
                        }
                        if start != -1 {
                            out.push((start, row[row.len() - 1]));
                        }
                    }
                }
                at(&tracks, m, "tracks")?;
                tracks[m as usize].extend(out);
            }
        }
        // 6. 꼭짓점
        let mut i = Lmetal;
        while i <= Hmetal {
            at(&g.Start_index_metal_vertices, i, "Start_index_metal_vertices")?;
            let iu = i as usize;
            g.Start_index_metal_vertices[iu] = g.vertices_total.len() as i32;
            if at(&tracks, i, "tracks")?.is_empty() {
                // Router-Warning: no global tiles on metal layer (End 는 -1 그대로)
                i += 1;
                continue;
            }
            for &(first, second) in &tracks[iu] {
                let (t1, t2) = (tile(first)?, tile(second)?);
                let (x1, x2, y1, y2) = (t1.x, t2.x, t1.y, t2.y);
                let (w1, w2, h1, h2) = (t1.width, t2.width, t1.height, t2.height);
                let mut track_x = x1.wrapping_sub(w1 / 2);
                let mut track_X = x2.wrapping_add(w2 / 2);
                let mut track_y = y1.wrapping_sub(h1 / 2);
                let mut track_Y = y2.wrapping_add(h2 / 2);
                if track_x < ll.x {
                    track_x = ll.x;
                }
                if track_y < ll.y {
                    track_y = ll.y;
                }
                if track_X > ur.x {
                    track_X = ur.x;
                }
                if track_Y > ur.y {
                    track_Y = ur.y;
                }
                let direct = MI[iu].direct;
                if direct == 0 {
                    if x1 != x2 {
                        // Router-Error: vertical tiles not found
                        continue;
                    }
                    let cu = g.x_unit[iu];
                    let LLx = ceil_off(track_x.wrapping_sub(MI[iu].offset), cu, MI[iu].offset);
                    let mut adj = BTreeSet::new();
                    g.adj_lines(i, track_y, track_Y, false, &mut adj)?;
                    if LLx <= track_X {
                        step_ok(cu, "x_unit")?;
                    }
                    let mut X = LLx as i64;
                    while X <= track_X as i64 {
                        g.line(i, X as i32, &adj, true)?;
                        X += cu as i64;
                    }
                } else if direct == 1 {
                    if y1 != y2 {
                        // Router-Error: horizontal tiles not found
                        continue;
                    }
                    let cu = g.y_unit[iu];
                    let LLy = ceil_off(track_y.wrapping_sub(MI[iu].offset), cu, MI[iu].offset);
                    let mut adj = BTreeSet::new();
                    g.adj_lines(i, track_x, track_X, true, &mut adj)?;
                    if LLy <= track_Y {
                        step_ok(cu, "y_unit")?;
                    }
                    let mut Y = LLy as i64;
                    while Y <= track_Y as i64 {
                        g.line(i, Y as i32, &adj, false)?;
                        Y += cu as i64;
                    }
                } else {
                    // Router-Error: incorrect routing direction
                    continue;
                }
            }
            g.End_index_metal_vertices[iu] = g.vertices_total.len() as i32 - 1;
            i += 1;
        }
        // 7. 위아래 잇기 (같은 (x, y) 의 위층 첫 꼭짓점)
        let mut k = g.lowest_metal;
        while k < g.highest_metal {
            let s = *at(&g.Start_index_metal_vertices, k, "Start_index_metal_vertices")?;
            let e = *at(&g.End_index_metal_vertices, k, "End_index_metal_vertices")?;
            let up_map = at(&g.vertices_total_map, k + 1, "vertices_total_map")?;
            let mut links = Vec::new();
            let mut i = s;
            while i <= e {
                let v = &g.vertices_total[i as usize];
                if let Some(&j) = up_map.get(&(v.x, v.y)) {
                    links.push((i, j));
                }
                i += 1;
            }
            for (i, j) in links {
                g.vertices_total[i as usize].up = j;
                g.vertices_total[j as usize].down = i;
            }
            k += 1;
        }
        Ok(g)
    }

    /// 이웃 층 트랙의 선 위치 (세로층은 Y 들, 가로층은 X 들). horizontal = 지금 층이 가로층이다.
    fn adj_lines(&self, i: i32, lo: i32, hi: i32, horizontal: bool, out: &mut BTreeSet<i32>) -> Result<(), String> {
        let MI = &self.drc_info.Metal_info;
        let unit = |k: i32| -> Result<i32, String> {
            let u = if horizontal { at(&self.x_unit, k, "x_unit")? } else { at(&self.y_unit, k, "y_unit")? };
            Ok(*u)
        };
        let off = |k: i32| MI[k as usize].offset;
        let one = |k: i32, out: &mut BTreeSet<i32>| -> Result<(), String> {
            let u = unit(k)?;
            let start = ceil_off(lo.wrapping_sub(off(k)), u, off(k));
            if start <= hi {
                step_ok(u, if horizontal { "x_unit" } else { "y_unit" })?;
            }
            steps(start, hi, u, out);
            Ok(())
        };
        if i == 0 {
            one(i + 1, out)?;
        } else if i == self.layerNo - 1 {
            one(i - 1, out)?;
        } else {
            one(i - 1, out)?;
            one(i + 1, out)?;
        }
        Ok(())
    }

    /// 선 하나 (세로층이면 X = c 인 선, 가로층이면 Y = c 인 선) 위의 꼭짓점들
    fn line(&mut self, i: i32, c: i32, adj: &BTreeSet<i32>, vertical: bool) -> Result<(), String> {
        let iu = i as usize;
        let MI = &self.drc_info.Metal_info;
        let mut nb_start = -1;
        if vertical {
            self.GridLL.x = self.GridLL.x.min(c);
            self.GridUR.x = self.GridUR.x.max(c);
        } else {
            self.GridLL.y = self.GridLL.y.min(c);
            self.GridUR.y = self.GridUR.y.max(c);
        }
        for &a in adj {
            // pmark: 이웃 층 트랙 위의 점만
            let pmark = if i == 0 || i == self.layerNo - 1 {
                true
            } else {
                let (u0, u1) = if vertical { (self.y_unit[iu - 1], self.y_unit[iu + 1]) } else { (self.x_unit[iu - 1], self.x_unit[iu + 1]) };
                if u0 == 0 || u1 == 0 {
                    return Err("Grid: 이웃 층 격자 간격이 0 이다 (C++ 은 0 으로 나눈다)".into());
                }
                a.wrapping_rem(u0) == MI[iu - 1].offset || a.wrapping_rem(u1) == MI[iu + 1].offset
            };
            if !pmark {
                continue;
            }
            let (X, Y) = if vertical { (c, a) } else { (a, c) };
            if vertical {
                self.GridLL.y = self.GridLL.y.min(Y);
                self.GridUR.y = self.GridUR.y.max(Y);
            } else {
                self.GridLL.x = self.GridLL.x.min(X);
                self.GridUR.x = self.GridUR.x.max(X);
            }
            let index = self.vertices_total.len() as i32;
            let mut tmpv = Vertex { x: X, y: Y, metal: i, active: true, ..Vertex::default() };
            if nb_start == -1 {
                nb_start = index;
            } else {
                let mut mark = false;
                let mut w = index - 1;
                while w >= nb_start {
                    let pw = &self.vertices_total[w as usize];
                    if vertical {
                        if pw.x == X {
                            if Y.wrapping_sub(pw.y) >= self.y_min[iu] {
                                mark = true;
                                break;
                            }
                        } else {
                            break;
                        }
                    } else if pw.y == Y {
                        if X.wrapping_sub(pw.x) >= self.x_min[iu] {
                            mark = true;
                            break;
                        }
                    } else {
                        break;
                    }
                    w -= 1;
                }
                if mark {
                    if vertical {
                        tmpv.south = w;
                        self.vertices_total[w as usize].north = index;
                    } else {
                        tmpv.west = w;
                        self.vertices_total[w as usize].east = index;
                    }
                }
            }
            self.vertices_total.push(tmpv);
            self.vertices_total_map[iu].entry((X, Y)).or_insert(index);
        }
        Ok(())
    }

    /// `vertices_total_map.at(m)[p]` — 없는 점이면 0 을 넣고 꼭짓점 0 을 가리킨다. 꼭짓점이 하나도 없으면
    /// C++ 은 빈 벡터의 [0] 에 false 를 쓴다 (낮은 주소에 0 — 아무 일 없다): None.
    pub fn map_index(&mut self, m: i32, x: i32, y: i32) -> Result<Option<usize>, String> {
        let mp = usize::try_from(m)
            .ok()
            .and_then(|u| self.vertices_total_map.get(u))
            .ok_or_else(|| format!("std::out_of_range: vector (vertices_total_map.at({m}))"))?;
        let i = mp.get(&(x, y)).copied().unwrap_or(0);
        if self.vertices_total.is_empty() {
            self.map_inserted[m as usize].insert((x, y));
            return Ok(None);
        }
        Ok(Some(i as usize))
    }

    /// Grid::PrepareGraphVertices(LL, UR) — 결과(vertices_graph)는 모드 5 에서 안 읽는다. 꼭짓점이 없는 격자라도
    /// 지도에 `map[p]` 가 넣은 점이 있으면 [lower_bound(LL), upper_bound(UR)) 를 돈다: 비지 않으면
    /// `vertices_total.at(0)` 이 던지고, 거꾸로면 정의되지 않은 동작 — 둘 다 Err.
    pub fn PrepareGraphVertices(&self, LL: (i32, i32), UR: (i32, i32)) -> Result<(), String> {
        if !self.vertices_total.is_empty() {
            return Ok(());
        }
        for pts in &self.map_inserted {
            if pts.is_empty() {
                continue;
            }
            let low = pts.range(LL..).next();
            let high = pts.range((std::ops::Bound::Excluded(UR), std::ops::Bound::Unbounded)).next();
            if low != high {
                return Err("PrepareGraphVertices: 꼭짓점 없는 격자의 지도를 돈다 (C++ 은 .at(0) 이 던지거나 정의되지 않은 동작)".into());
            }
        }
        Ok(())
    }

    pub fn ActivateSourceDest(&mut self) {
        for &s in &self.Source {
            self.vertices_total[s as usize].active = true;
        }
        for &d in &self.Dest {
            self.vertices_total[d as usize].active = true;
        }
    }

    pub fn InactivateSourceDest(&mut self) {
        for &s in &self.Source {
            self.vertices_total[s as usize].active = false;
        }
        for &d in &self.Dest {
            self.vertices_total[d as usize].active = false;
        }
    }

    /// Grid::ActivePointlist / InactivePointlist — 층마다의 점 집합에 든 꼭짓점을 켜거나 끈다
    pub fn SetPointlist(&mut self, plist: &[super::util::FxSet<(i32, i32)>], on: bool) {
        for v in self.vertices_total.iter_mut() {
            if plist[v.metal as usize].contains(&(v.x, v.y)) {
                v.active = on;
            }
        }
    }

    /// Grid::setSrcDest (detail = false) / setSrcDest_detail (detail = true) — Grid.cpp:1635-2066.
    /// 이 흐름의 SinkData 는 늘 점 둘이라 핀 길만 탄다. 출발이 있는데 하나도 못 옮기면 도착은 비운 채 돌아간다.
    pub fn setSrcDest(&mut self, Vsource: &[Sink], Vdest: &[Sink], detail: bool) -> Result<(), String> {
        self.Source.clear();
        self.Dest.clear();
        for s in Vsource {
            let t = self.Mapping_function_pin(s, detail)?;
            self.Source.extend(t);
        }
        if !Vsource.is_empty() && self.Source.is_empty() {
            // Router-Error: fail to find source vertices on grids
            return Ok(());
        }
        for d in Vdest {
            let t = self.Mapping_function_pin(d, detail)?;
            self.Dest.extend(t);
        }
        Ok(())
    }

    /// Grid::Mapping_function_pin(_detail) (Grid.cpp:2068-2182)
    fn Mapping_function_pin(&self, source: &Sink, detail: bool) -> Result<Vec<i32>, String> {
        let m = source.metalIdx;
        let MI = &self.drc_info.Metal_info;
        if m < 0 || m > MI.len() as i32 {
            return Ok(Vec::new());
        }
        if m == MI.len() as i32 {
            return Err(format!("Mapping_function_pin: 층 {m} = Metal_info.size() (C++ 은 범위 밖을 읽는다)"));
        }
        let mu = m as usize;
        let nb = |k: i32| at(MI, k, "Metal_info");
        let (s, e) = (self.Start_index_metal_vertices[mu], self.End_index_metal_vertices[mu]);
        let gs = self.grid_scale;
        let (gux, guy, gux1, guy1) = if m == 0 {
            if MI[mu].direct == 0 {
                (MI[mu].grid_unit_x, nb(m + 1)?.grid_unit_y, MI[mu].grid_unit_x, nb(m + 1)?.grid_unit_y)
            } else {
                (nb(m + 1)?.grid_unit_x, MI[mu].grid_unit_y, nb(m + 1)?.grid_unit_x, MI[mu].grid_unit_y)
            }
        } else if m == self.layerNo - 1 {
            if MI[mu].direct == 0 {
                (MI[mu].grid_unit_x, nb(m - 1)?.grid_unit_y, MI[mu].grid_unit_x, nb(m - 1)?.grid_unit_y)
            } else {
                (nb(m - 1)?.grid_unit_x, MI[mu].grid_unit_y, nb(m - 1)?.grid_unit_x, MI[mu].grid_unit_y)
            }
        } else if MI[mu].direct == 0 {
            (MI[mu].grid_unit_x, nb(m - 1)?.grid_unit_y, MI[mu].grid_unit_x, nb(m + 1)?.grid_unit_y)
        } else {
            (nb(m - 1)?.grid_unit_x, MI[mu].grid_unit_y, nb(m + 1)?.grid_unit_x, MI[mu].grid_unit_y)
        };
        self.Map_from_seg2gridseg_pin(source, gux, guy, gux1, guy1, gs, s, e, detail)
    }

    /// Grid::Map_from_seg2gridseg_pin(_detail) (Grid.cpp:2300-2736). offset 의 짝이 안 맞는 곳(세로층의
    /// grid_Ux, grid_Lx1 에서 두 번 빼기)까지 그대로 둔다. detail 이면 켜진 꼭짓점만.
    #[allow(clippy::too_many_arguments)]
    fn Map_from_seg2gridseg_pin(&self, s: &Sink, gux: i32, guy: i32, gux1: i32, guy1: i32, gs: i32, i0: i32, i1: i32,
                                detail: bool) -> Result<Vec<i32>, String> {
        let MI = &self.drc_info.Metal_info;
        let m = s.metalIdx as usize;
        let (Lx, Ly, Ux, Uy) = (s.LL.x, s.LL.y, s.UR.x, s.UR.y);
        let v = MI[m].direct == 0;
        let off_m = MI[m].offset;
        // metalIdx > 0 ? [m-1] : [m+1]
        let off_lo = if m > 0 { MI[m - 1].offset } else { at(MI, m as i32 + 1, "Metal_info")?.offset };
        // metalIdx < layerNo-1 ? [m+1] : [m-1]
        let off_hi = if (m as i32) < self.layerNo - 1 { MI[m + 1].offset } else { at(MI, m as i32 - 1, "Metal_info")?.offset };
        let ux = gux.wrapping_mul(gs);
        let uy = guy.wrapping_mul(gs);
        let ux1 = gux1.wrapping_mul(gs);
        let uy1 = guy1.wrapping_mul(gs);
        if ux == 0 || uy == 0 || ux1 == 0 || uy1 == 0 {
            return Err("Map_from_seg2gridseg_pin: 격자 간격이 0 이다 (C++ 은 0 으로 나눈다)".into());
        }
        let cdiv = |a: i32, b: i32| f2i((a as f64 / b as f64).ceil());

        let mut grid_Lx = Lx.wrapping_sub(if v { off_m } else { off_lo });
        grid_Lx = grid_Lx.wrapping_div(ux).wrapping_mul(ux);
        grid_Lx = grid_Lx.wrapping_add(if v { off_m } else { off_lo });

        let mut grid_Ux = Ux.wrapping_sub(if v { off_m } else { off_lo });
        grid_Ux = cdiv(grid_Ux, ux).wrapping_mul(ux);
        grid_Ux = if v { grid_Ux.wrapping_sub(off_m) } else { grid_Ux.wrapping_add(off_lo) };

        let mut grid_Ly = Ly.wrapping_sub(if v { off_lo } else { off_m });
        grid_Ly = grid_Ly.wrapping_div(uy).wrapping_mul(uy);
        grid_Ly = grid_Ly.wrapping_add(if v { off_lo } else { off_m });

        let mut grid_Uy = Uy.wrapping_sub(if v { off_lo } else { off_m });
        grid_Uy = cdiv(grid_Uy, uy).wrapping_mul(uy);
        grid_Uy = grid_Uy.wrapping_add(if v { off_lo } else { off_m });

        let mut grid_Lx1 = Lx.wrapping_sub(if v { off_m } else { off_hi });
        grid_Lx1 = grid_Lx1.wrapping_div(ux1).wrapping_mul(ux1);
        grid_Lx1 = if v { grid_Lx1.wrapping_sub(off_m) } else { grid_Lx1.wrapping_add(off_hi) };

        let mut grid_Ux1 = Ux.wrapping_sub(if v { off_m } else { off_hi });
        grid_Ux1 = cdiv(grid_Ux1, ux1).wrapping_mul(ux1);
        grid_Ux1 = if v { grid_Ux1.wrapping_sub(off_m) } else { grid_Ux1.wrapping_add(off_hi) };

        let mut grid_Ly1 = Ly.wrapping_sub(if v { off_hi } else { off_m });
        grid_Ly1 = grid_Ly1.wrapping_div(uy1).wrapping_mul(uy1);
        grid_Ly1 = grid_Ly1.wrapping_add(if v { off_hi } else { off_m });

        let mut grid_Uy1 = Uy.wrapping_sub(if v { off_hi } else { off_m });
        grid_Uy1 = cdiv(grid_Uy1, uy1).wrapping_mul(uy1);
        grid_Uy1 = grid_Uy1.wrapping_add(if v { off_hi } else { off_m });

        let mut grid_node_coord: super::util::FxSet<(i32, i32)> = Default::default();
        let mut add = |gLx: i32, gUx: i32, gLy: i32, gUy: i32, ux: i32, uy: i32, gxu: i32, gyu: i32| {
            let ni = gUx.wrapping_sub(gLx).wrapping_div(ux);
            let nj = gUy.wrapping_sub(gLy).wrapping_div(uy);
            let mut i = 0;
            while i <= ni {
                let x = gLx.wrapping_add(i.wrapping_mul(gxu).wrapping_mul(gs));
                if x >= Lx && x <= Ux {
                    let mut j = 0;
                    while j <= nj {
                        let y = gLy.wrapping_add(j.wrapping_mul(gyu).wrapping_mul(gs));
                        if y >= Ly && y <= Uy {
                            grid_node_coord.insert((x, y));
                        }
                        j += 1;
                    }
                }
                i += 1;
            }
        };
        add(grid_Lx, grid_Ux, grid_Ly, grid_Uy, ux, uy, gux, guy);
        add(grid_Lx1, grid_Ux1, grid_Ly1, grid_Uy1, ux1, uy1, gux1, guy1);

        let mut sourceL = Vec::new();
        let mut k = i0;
        while k <= i1 {
            let vt = &self.vertices_total[k as usize];
            if (!detail || vt.active) && grid_node_coord.contains(&(vt.x, vt.y)) {
                sourceL.push(k);
            }
            k += 1;
        }
        Ok(sourceL)
    }
}
