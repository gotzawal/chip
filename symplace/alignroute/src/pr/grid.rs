//! Grid — 상세 격자 (router/Grid.cpp). PowerRouter 가 쓰는 생성자(Grid.cpp:993-1262)와 도우미만 옮긴다.
//!
//! 꼭짓점의 north/south/east/west 는 C++ 에서 vector 지만, 이 생성자는 같은 트랙의 바로 앞 꼭짓점
//! (번호 -1) 하나만 잇는다 — 그래서 방향마다 많아야 하나다. 여기서는 -1(없음) 또는 번호로 둔다.
//! Full_Connected_Vertex 는 옮기지 않는다: 그 결과(vertices_total_full_connected)는 평행 배선
//! (left/right > 0)에서만 읽히고 PowerRouter 는 늘 0, 0 으로 부른다.
use super::util::{FxMap, FxSet, ceil_to, f2i, gcd};
use crate::db::DrcInfo;
use crate::rdb::point;

/// RouterDB::vertex 에서 PowerRouter 가 쓰는 필드 (기본값은 Rdatatype.h 그대로)
#[derive(Clone, Debug)]
pub struct Vertex {
    pub x: i32,
    pub y: i32,
    pub metal: i32,
    pub Cost: f64,
    pub active: bool,
    pub via_active_down: bool,
    pub via_active_up: bool,
    pub parent: i32,
    pub trace_back_node: i32,
    #[allow(dead_code)]
    pub index: i32,
    pub north: i32,
    pub south: i32,
    pub east: i32,
    pub west: i32,
    pub down: i32,
    pub up: i32,
    /// C++ 은 초기화하지 않는다 — 생성자가 늘 쓴다
    pub power: i32,
    pub graph_index: i32,
}

impl Default for Vertex {
    fn default() -> Self {
        Vertex {
            x: -1,
            y: -1,
            metal: -1,
            Cost: f64::MAX,
            active: false,
            via_active_down: true,
            via_active_up: true,
            parent: -1,
            trace_back_node: -1,
            index: -1,
            north: -1,
            south: -1,
            east: -1,
            west: -1,
            down: -1,
            up: -1,
            power: 0,
            graph_index: -1,
        }
    }
}

/// 핀 접점·격자 금속 사각형 (SinkData 의 coord 가 [LL, UR] 인 경우만 쓰인다)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sink {
    pub metalIdx: i32,
    pub LL: point,
    pub UR: point,
}

pub struct Grid<'a> {
    pub drc_info: &'a DrcInfo,
    pub vertices_total: Vec<Vertex>,
    /// PrepareGraphVertices 의 결과 (모드 2)
    pub vertices_graph: Vec<Vertex>,
    /// total -> graph 번호. C++ 의 unordered_map (없으면 -1)
    pub total2graph: Vec<i32>,
    pub Start_index_metal_vertices: Vec<i32>,
    pub End_index_metal_vertices: Vec<i32>,
    pub Source: Vec<i32>,
    pub Dest: Vec<i32>,
    pub x_unit: Vec<i32>,
    pub y_unit: Vec<i32>,
    pub x_min: Vec<i32>,
    pub y_min: Vec<i32>,
    pub LL: point,
    pub UR: point,
    /// 층마다 (x, y) -> 번호. C++ 의 std::map (insert 는 먼저 것을 남긴다). 조회만 한다.
    pub vertices_total_map: Vec<FxMap<(i32, i32), i32>>,
    #[allow(dead_code)]
    pub lowest_metal: i32,
    #[allow(dead_code)]
    pub highest_metal: i32,
    pub grid_scale: i32,
    pub layerNo: i32,
    pub center_x: i32,
    pub center_y: i32,
}

impl<'a> Grid<'a> {
    /// Grid::Grid(drc_info, ll, ur, Lmetal, Hmetal, grid_scale) — Grid.cpp:993-1262
    pub fn new(drc_info: &'a DrcInfo, ll: point, ur: point, Lmetal: i32, Hmetal: i32, grid_scale: i32) -> Self {
        let layerNo = drc_info.Metal_info.len() as i32;
        let n = layerNo as usize;
        let mut g = Grid {
            drc_info,
            vertices_total: Vec::new(),
            vertices_graph: Vec::new(),
            total2graph: Vec::new(),
            Start_index_metal_vertices: vec![0; n],
            End_index_metal_vertices: vec![-1; n],
            Source: Vec::new(),
            Dest: Vec::new(),
            x_unit: vec![0; n],
            y_unit: vec![0; n],
            x_min: vec![0; n],
            y_min: vec![0; n],
            LL: ll,
            UR: ur,
            vertices_total_map: (0..n).map(|_| FxMap::default()).collect(),
            lowest_metal: Lmetal,
            highest_metal: Hmetal,
            grid_scale,
            layerNo,
            center_x: 0,
            center_y: 0,
        };
        // 3. 층마다 격자 간격
        for i in 0..n {
            let mi = &drc_info.Metal_info[i];
            if mi.direct == 0 {
                g.x_unit[i] = mi.grid_unit_x * grid_scale;
                g.y_min[i] = 1;
            } else if mi.direct == 1 {
                g.y_unit[i] = mi.grid_unit_y * grid_scale;
                g.x_min[i] = 1;
            }
        }
        // 4. 꼭짓점. Power 깃발 하나를 모든 층이 나눠 쓰고 트랙마다 뒤집는다 (꼭짓점이 없는 트랙도)
        let mut Power = false;
        let (LL, UR) = (g.LL, g.UR);
        for i in Lmetal..=Hmetal {
            let iu = i as usize;
            g.Start_index_metal_vertices[iu] = g.vertices_total.len() as i32;
            let direct = drc_info.Metal_info[iu].direct;
            if direct == 0 {
                let curlayer_unit = g.x_unit[iu];
                let LLx = ceil_to(LL.x, curlayer_unit);
                let (nexlayer_unit, LLy);
                if i == 0 {
                    nexlayer_unit = g.y_unit[iu + 1];
                    LLy = ceil_to(LL.y, g.y_unit[iu + 1]);
                } else if i == layerNo - 1 {
                    nexlayer_unit = g.y_unit[iu - 1];
                    LLy = ceil_to(LL.y, g.y_unit[iu - 1]);
                } else {
                    nexlayer_unit = gcd(g.y_unit[iu - 1], g.y_unit[iu + 1]);
                    let LLy_1 = ceil_to(LL.y, g.y_unit[iu - 1]);
                    let LLy_2 = ceil_to(LL.y, g.y_unit[iu + 1]);
                    LLy = if LLy_1 < LLy_2 { LLy_1 } else { LLy_2 };
                }
                let mut X = LLx;
                while X <= UR.x {
                    Power = !Power;
                    let mut Y = LLy;
                    while Y <= UR.y {
                        let pmark = i == 0 || i == layerNo - 1 || Y % g.y_unit[iu - 1] == 0 || Y % g.y_unit[iu + 1] == 0;
                        if pmark {
                            g.push_vertex(iu, X, Y, Power, true);
                        }
                        Y += nexlayer_unit;
                    }
                    X += curlayer_unit;
                }
            } else if direct == 1 {
                let curlayer_unit = g.y_unit[iu];
                let LLy = ceil_to(LL.y, curlayer_unit);
                let (nexlayer_unit, LLx);
                if i == 0 {
                    nexlayer_unit = g.x_unit[iu + 1];
                    LLx = ceil_to(LL.x, g.x_unit[iu + 1]);
                } else if i == layerNo - 1 {
                    nexlayer_unit = g.x_unit[iu - 1];
                    LLx = ceil_to(LL.x, g.x_unit[iu - 1]);
                } else {
                    nexlayer_unit = gcd(g.x_unit[iu - 1], g.x_unit[iu + 1]);
                    let LLx_1 = ceil_to(LL.x, g.x_unit[iu - 1]);
                    let LLx_2 = ceil_to(LL.x, g.x_unit[iu + 1]);
                    LLx = if LLx_1 < LLx_2 { LLx_1 } else { LLx_2 };
                }
                let mut Y = LLy;
                while Y <= UR.y {
                    Power = !Power;
                    let mut X = LLx;
                    while X <= UR.x {
                        let pmark = i == 0 || i == layerNo - 1 || X % g.x_unit[iu - 1] == 0 || X % g.x_unit[iu + 1] == 0;
                        if pmark {
                            g.push_vertex(iu, X, Y, Power, false);
                        }
                        X += nexlayer_unit;
                    }
                    Y += curlayer_unit;
                }
            } else {
                // Router-Error: incorrect routing direction — 건너뛴다 (End 는 아래에서 쓴다)
            }
            g.End_index_metal_vertices[iu] = g.vertices_total.len() as i32 - 1;
        }
        // 5. 위아래 잇기 (같은 (x, y))
        for k in Lmetal..Hmetal {
            let ku = k as usize;
            for i in g.Start_index_metal_vertices[ku]..=g.End_index_metal_vertices[ku] {
                let (x, y) = (g.vertices_total[i as usize].x, g.vertices_total[i as usize].y);
                if let Some(&j) = g.vertices_total_map[ku + 1].get(&(x, y)) {
                    g.vertices_total[i as usize].up = j;
                    g.vertices_total[j as usize].down = i;
                }
            }
        }
        g
    }

    /// 꼭짓점 하나를 넣고 같은 트랙의 앞 꼭짓점과 잇는다 (세로층은 south/north, 가로층은 west/east)
    fn push_vertex(&mut self, i: usize, X: i32, Y: i32, Power: bool, vertical: bool) {
        let index = self.vertices_total.len() as i32;
        let mut tmpv = Vertex {
            x: X,
            y: Y,
            metal: i as i32,
            power: if Power { 1 } else { 0 },
            active: true,
            index,
            ..Vertex::default()
        };
        let start = self.Start_index_metal_vertices[i];
        let mut mark = false;
        let mut w = index - 1;
        while w >= start {
            let pw = &self.vertices_total[w as usize];
            if vertical {
                if pw.x == tmpv.x {
                    if tmpv.y - pw.y >= self.y_min[i] {
                        mark = true;
                        break;
                    }
                } else {
                    break;
                }
            } else if pw.y == tmpv.y {
                if tmpv.x - pw.x >= self.x_min[i] {
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
        self.vertices_total.push(tmpv);
        self.vertices_total_map[i].entry((X, Y)).or_insert(index);
    }

    /// `vertices_total_map.at(m)[p]` — 없는 점이면 operator[] 가 0 을 넣어 꼭짓점 0 을 가리킨다
    #[inline]
    pub fn map_index(&self, m: i32, x: i32, y: i32) -> usize {
        self.vertices_total_map[m as usize].get(&(x, y)).copied().unwrap_or(0) as usize
    }

    /// Grid::PrepareGraphVertices (Grid.cpp:1575-1610) — 켜진 꼭짓점을 층 순, 층 안은 (x, y) 순으로
    pub fn PrepareGraphVertices(&mut self, LLx: i32, LLy: i32, URx: i32, URy: i32) {
        self.vertices_graph.clear();
        self.total2graph = vec![-1; self.vertices_total.len()];
        for k in 0..self.layerNo as usize {
            if self.vertices_total_map[k].is_empty() {
                continue;
            }
            let mut ents: Vec<((i32, i32), i32)> = self.vertices_total_map[k]
                .iter()
                .filter(|(p, _)| (LLx, LLy) <= **p && **p <= (URx, URy))
                .map(|(p, i)| (*p, *i))
                .collect();
            ents.sort_unstable();
            for (_, i) in ents {
                let v = &self.vertices_total[i as usize];
                if v.active && v.x >= LLx && v.x <= URx && v.y >= LLy && v.y <= URy {
                    self.vertices_graph.push(v.clone());
                    self.total2graph[i as usize] = self.vertices_graph.len() as i32 - 1;
                }
            }
        }
    }

    /// total2graph.find(t) — 없으면 None
    #[inline]
    pub fn t2g(&self, t: i32) -> Option<usize> {
        if t < 0 || t as usize >= self.total2graph.len() {
            return None;
        }
        let g = self.total2graph[t as usize];
        if g < 0 { None } else { Some(g as usize) }
    }

    /// Grid::ActivateSourceDest
    pub fn ActivateSourceDest(&mut self) {
        for &s in &self.Source {
            self.vertices_total[s as usize].active = true;
        }
        for &d in &self.Dest {
            self.vertices_total[d as usize].active = true;
        }
    }

    /// Grid::setSrcDest / setSrcDest_detail (Grid.cpp:1635-2066) — 핀(coord 가 둘)만 온다.
    /// 출발이 있는데 하나도 못 옮기면 도착은 옮기지 않고 돌아간다. detail 이면 켜진 꼭짓점만.
    pub fn setSrcDest(&mut self, Vsource: &[Sink], Vdest: &[Sink], detail: bool) {
        self.Source.clear();
        self.Dest.clear();
        for s in Vsource {
            let t = self.Mapping_function_pin(s, detail);
            self.Source.extend(t);
        }
        if !Vsource.is_empty() && self.Source.is_empty() {
            // Router-Error: fail to find source vertices on grids
            return;
        }
        for d in Vdest {
            let t = self.Mapping_function_pin(d, detail);
            self.Dest.extend(t);
        }
    }

    /// Grid::Mapping_function_pin(_detail) (Grid.cpp:2068-2182)
    fn Mapping_function_pin(&self, source: &Sink, detail: bool) -> Vec<i32> {
        let m = source.metalIdx;
        let MI = &self.drc_info.Metal_info;
        // C++ 은 m == Metal_info.size() 도 통과시켜 범위 밖을 읽는다 — 여기서는 빈 결과로
        if m < 0 || m >= MI.len() as i32 {
            return Vec::new();
        }
        let mu = m as usize;
        let (s, e) = (self.Start_index_metal_vertices[mu], self.End_index_metal_vertices[mu]);
        let gs = self.grid_scale;
        if m == 0 {
            if MI[mu].direct == 0 {
                self.Map_from_seg2gridseg_pin(source, MI[mu].grid_unit_x, MI[mu + 1].grid_unit_y, MI[mu].grid_unit_x, MI[mu + 1].grid_unit_y, gs, s, e, detail)
            } else {
                self.Map_from_seg2gridseg_pin(source, MI[mu + 1].grid_unit_x, MI[mu].grid_unit_y, MI[mu + 1].grid_unit_x, MI[mu].grid_unit_y, gs, s, e, detail)
            }
        } else if m == self.layerNo - 1 {
            if MI[mu].direct == 0 {
                self.Map_from_seg2gridseg_pin(source, MI[mu].grid_unit_x, MI[mu - 1].grid_unit_y, MI[mu].grid_unit_x, MI[mu - 1].grid_unit_y, gs, s, e, detail)
            } else {
                self.Map_from_seg2gridseg_pin(source, MI[mu - 1].grid_unit_x, MI[mu].grid_unit_y, MI[mu - 1].grid_unit_x, MI[mu].grid_unit_y, gs, s, e, detail)
            }
        } else if MI[mu].direct == 0 {
            self.Map_from_seg2gridseg_pin(source, MI[mu].grid_unit_x, MI[mu - 1].grid_unit_y, MI[mu].grid_unit_x, MI[mu + 1].grid_unit_y, gs, s, e, detail)
        } else {
            self.Map_from_seg2gridseg_pin(source, MI[mu - 1].grid_unit_x, MI[mu].grid_unit_y, MI[mu + 1].grid_unit_x, MI[mu].grid_unit_y, gs, s, e, detail)
        }
    }

    /// Grid::Map_from_seg2gridseg_pin(_detail) (Grid.cpp:2300-2736). offset 의 짝이 안 맞는 곳
    /// (세로층의 grid_Ux, grid_Lx1 에서 두 번 빼기)까지 그대로 둔다.
    #[allow(clippy::too_many_arguments)]
    fn Map_from_seg2gridseg_pin(&self, s: &Sink, gux: i32, guy: i32, gux1: i32, guy1: i32, gs: i32, i0: i32, i1: i32, detail: bool) -> Vec<i32> {
        let MI = &self.drc_info.Metal_info;
        let m = s.metalIdx as usize;
        let (Lx, Ly, Ux, Uy) = (s.LL.x, s.LL.y, s.UR.x, s.UR.y);
        let v = MI[m].direct == 0;
        let off_m = MI[m].offset;
        // metalIdx > 0 ? [m-1] : [m+1]
        let off_lo = if m > 0 { MI[m - 1].offset } else { MI[m + 1].offset };
        // metalIdx < layerNo-1 ? [m+1] : [m-1]
        let off_hi = if (m as i32) < self.layerNo - 1 { MI[m + 1].offset } else { MI[m - 1].offset };
        let ux = gux * gs;
        let uy = guy * gs;
        let ux1 = gux1 * gs;
        let uy1 = guy1 * gs;
        let cdiv = |a: i32, b: i32| f2i((a as f64 / b as f64).ceil());

        let mut grid_Lx = Lx - if v { off_m } else { off_lo };
        grid_Lx /= ux;
        grid_Lx *= ux;
        grid_Lx += if v { off_m } else { off_lo };

        let mut grid_Ux = Ux - if v { off_m } else { off_lo };
        grid_Ux = cdiv(grid_Ux, ux);
        grid_Ux *= ux;
        if v {
            grid_Ux -= off_m;
        } else {
            grid_Ux += off_lo;
        }

        let mut grid_Ly = Ly - if v { off_lo } else { off_m };
        grid_Ly /= uy;
        grid_Ly *= uy;
        grid_Ly += if v { off_lo } else { off_m };

        let mut grid_Uy = Uy - if v { off_lo } else { off_m };
        grid_Uy = cdiv(grid_Uy, uy);
        grid_Uy *= uy;
        grid_Uy += if v { off_lo } else { off_m };

        let mut grid_Lx1 = Lx - if v { off_m } else { off_hi };
        grid_Lx1 /= ux1;
        grid_Lx1 *= ux1;
        if v {
            grid_Lx1 -= off_m;
        } else {
            grid_Lx1 += off_hi;
        }

        let mut grid_Ux1 = Ux - if v { off_m } else { off_hi };
        grid_Ux1 = cdiv(grid_Ux1, ux1);
        grid_Ux1 *= ux1;
        if v {
            grid_Ux1 -= off_m;
        } else {
            grid_Ux1 += off_hi;
        }

        let mut grid_Ly1 = Ly - if v { off_hi } else { off_m };
        grid_Ly1 /= uy1;
        grid_Ly1 *= uy1;
        grid_Ly1 += if v { off_hi } else { off_m };

        let mut grid_Uy1 = Uy - if v { off_hi } else { off_m };
        grid_Uy1 = cdiv(grid_Uy1, uy1);
        grid_Uy1 *= uy1;
        grid_Uy1 += if v { off_hi } else { off_m };

        let mut grid_node_coord: FxSet<(i32, i32)> = FxSet::default();
        let mut i = 0;
        while i <= (grid_Ux - grid_Lx) / ux {
            let x = grid_Lx + i * gux * gs;
            if x >= Lx && x <= Ux {
                let mut j = 0;
                while j <= (grid_Uy - grid_Ly) / uy {
                    let y = grid_Ly + j * guy * gs;
                    if y >= Ly && y <= Uy {
                        grid_node_coord.insert((x, y));
                    }
                    j += 1;
                }
            }
            i += 1;
        }
        let mut i = 0;
        while i <= (grid_Ux1 - grid_Lx1) / ux1 {
            let x = grid_Lx1 + i * gux1 * gs;
            if x >= Lx && x <= Ux {
                let mut j = 0;
                while j <= (grid_Uy1 - grid_Ly1) / uy1 {
                    let y = grid_Ly1 + j * guy1 * gs;
                    if y >= Ly && y <= Uy {
                        grid_node_coord.insert((x, y));
                    }
                    j += 1;
                }
            }
            i += 1;
        }

        let mut sourceL = Vec::new();
        for k in i0..=i1 {
            let vt = &self.vertices_total[k as usize];
            if detail && !vt.active {
                continue;
            }
            if grid_node_coord.contains(&(vt.x, vt.y)) {
                sourceL.push(k);
            }
        }
        sourceL
    }
}
