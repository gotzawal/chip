//! RouteWork 5 — GcellDetailRouter(node, GGR, 1, 1) (상세 배선). router/GcellDetailRouter.cpp, Grid.cpp,
//! A_star.cpp 를 옮긴다.
//!
//! 순서 (GcellDetailRouter.cpp:18-59, 367-514):
//!   모드 4 객체(GcellGlobalRouter)의 넷·블록·단자·전원 넷·칸 격자를 그대로 받는다 -> SortPinsOrder (핀 순서,
//!   넷 중심; libc++ std::sort 를 sort.rs 로) -> 모든 블록 금속·핀·전원 핀 사각형 집합(Set_x), 블록 비아 자리
//!   (Pset_via) -> 넷마다 (DoNotRoute·전역 경로 없음은 건너뜀, MultiConnection 이면 여러 번):
//!     격자(grid.rs: 전역 경로 칸 + 핀 칸 기둥 + 대칭 짝 칸) -> 핀 0 을 출발로, 핀 1.. 을 차례로 도착으로:
//!       출발·도착 사각형을 Set_x 에서 빼고 Set_x 전체를 끝단 간격만큼 불려 끈다 -> 출발·도착 꼭짓점을 켠다
//!       -> 비아 둘러싸기·간격 막기 (rect.rs) -> A* (astar.rs) -> 경로 -> 금속·비아 (path.rs) -> 출발에 경로와
//!       도착을 더한다 -> 넷 경로를 Set_x 에 넣는다 -> 모든 꼭짓점을 다시 켠다
//!   -> ReturnHierNode: 넷마다 path_metal·path_via, 포트에 닿는 넷은 모듈 핀(blockPins)으로, 나머지는 모듈 내부
//!      금속(interMetals)으로, 블록 내부 금속을 전부 덧붙인다. 단자 접점은 지운다.
//!
//! 결과에 안 닿는 것은 뺐다: 파일 쓰기(실패 때 Grid.txt 등, 비아 간격 로그), 배선 보고(router_report),
//! 대칭 짝의 사각형 모으기(CreatePlistSym*, 쓰이지 않는다), PrepareGraphVertices·Full_Connected_Vertex 의 결과.
//! C++ 이 던지는 예외(`.at` 범위 밖)와 정의되지 않은 동작, 끝나지 않는 반복은 Err 로 돌려준다. 다만 빈 벡터의
//! [0] 읽기는 기준(wasm32)에서 데이터 포인터가 null 이고 0 번지 쪽이 늘 0 이라 0 을 읽고 지나가므로 그대로
//! 따른다 (전역 후보가 없는 대칭 짝의 STs[0], 빈 경로의 compact_path).
#![allow(non_snake_case, non_camel_case_types)]

mod astar;
mod grid;
mod path;
mod rect;
mod sort;
mod util;

use crate::db::{self, BBox, DrcInfo, HierNode};
use crate::gr::GcellGlobalRouter;
use crate::rdb::{Block, Metal, NType, Net, PowerNet, Via, connectNode, contact, point, terminal};
use astar::A_star;
use grid::{Grid, Sink};
use rect::{C5, P3, c5s};
use std::collections::BTreeSet;

/// 조사용 자취 (네이티브에서 DR_TRACE 가 있으면 stderr 로) — oracle 의 같은 자리와 견준다
#[cfg(not(target_arch = "wasm32"))]
fn tr() -> bool {
    use std::sync::OnceLock;
    static T: OnceLock<bool> = OnceLock::new();
    *T.get_or_init(|| std::env::var_os("DR_TRACE").is_some())
}
#[cfg(target_arch = "wasm32")]
fn tr() -> bool {
    false
}

/// 자취: SortPinsOrder 뒤 넷마다 중심과 연결 순서 (종류/iter/iter2)
fn trace_sort(nets: &[Net]) {
    for (i, n) in nets.iter().enumerate() {
        let c: Vec<String> = n.connected.iter().map(|c| format!("{}/{}/{}", if c.type_ == NType::BLOCK { 0 } else { 1 }, c.iter, c.iter2)).collect();
        eprintln!("SORT {i} c={},{} : {}", n.center_x, n.center_y, c.join(" "));
    }
}

/// 자취: 꺼진 꼭짓점 번호들
fn trace_inactive(what: &str, i: usize, j: usize, grid: &Grid) {
    let l: String = grid.vertices_total.iter().enumerate().filter(|(_, v)| !v.active).map(|(q, _)| format!(" {q}")).collect();
    eprintln!("{what} {i} {j}:{l}");
}

/// 자취: 출발·도착 사각형과 Set_x 크기
fn trace_src_dest(i: usize, j: usize, src: &[Sink], dst: &[Sink], set_x: usize) {
    let f = |v: &[Sink]| v.iter().map(|s| format!(" [{} {} {} {} m{}]", s.LL.x, s.LL.y, s.UR.x, s.UR.y, s.metalIdx)).collect::<String>();
    eprintln!("SRC {i} {j}:{}\nDST {i} {j}:{}\nSETX {i} {j}: {set_x}", f(src), f(dst));
}

/// 자취: A* 뒤 켜진 꼭짓점·비아 수, 출발·도착 꼭짓점, 경로
fn trace_conn(i: usize, j: usize, grid: &Grid, ll: (i32, i32), ur: (i32, i32), path: &[Vec<i32>]) {
    let vt = &grid.vertices_total;
    let act = vt.iter().filter(|v| v.active).count();
    let vu = vt.iter().filter(|v| v.via_active_up).count();
    let vd = vt.iter().filter(|v| v.via_active_down).count();
    let j_ = |v: &[i32]| v.iter().map(|x| format!(" {x}")).collect::<String>();
    eprintln!("CONN {i} {j} n={} act={act} vu={vu} vd={vd} ll={},{} ur={},{}", vt.len(), ll.0, ll.1, ur.0, ur.1);
    eprintln!("  S{}\n  D{}\n  P{}", j_(&grid.Source), j_(&grid.Dest), j_(&path.concat()));
}

/// RouteWork 5: GcellDetailRouter(HierNode, GR, path_number = 1, grid_scale = 1)
pub fn route(node: &mut HierNode, gr: &GcellGlobalRouter) -> Result<(), String> {
    let mut dr = GcellDetailRouter::new(gr, 1, 1);
    // calculate_extension_length, printNetsInfo: 결과에 안 닿는다
    dr.create_detailrouter_new()?;
    dr.ReturnHierNode(node)
}

/// GcellDetailRouter 와 그 부모(RawRouter, GcellGlobalRouter)의 필드 가운데 모드 5 가 쓰는 것.
/// 넷만 고친다 — 나머지는 모드 4 객체의 것을 빌려 읽는다 (C++ 은 복사한다).
pub(crate) struct GcellDetailRouter<'a> {
    pub Nets: Vec<Net>,
    pub Blocks: &'a [Block],
    pub Terminals: &'a [terminal],
    pub PowerNets: &'a [PowerNet],
    pub drc_info: &'a DrcInfo,
    pub cross_layer_drc_info: &'a DrcInfo,
    pub Gcell: &'a crate::gr::GlobalGrid,
    pub terminal_routing: bool,
    pub lowest_metal: i32,
    pub highest_metal: i32,
    pub width: i32,
    #[allow(dead_code)]
    pub height: i32,
    pub LL: point,
    pub UR: point,
    pub path_number: i32,
    pub grid_scale: i32,
    pub layerNo: i32,
}

fn pin_of<'b>(Blocks: &'b [Block], c: &connectNode) -> Result<&'b crate::rdb::Pin, String> {
    usize::try_from(c.iter2)
        .ok()
        .and_then(|b| Blocks.get(b))
        .and_then(|b| usize::try_from(c.iter).ok().and_then(|p| b.pins.get(p)))
        .ok_or_else(|| format!("GcellDetailRouter: Blocks[{}].pins[{}] 이 없다 (정의되지 않은 동작)", c.iter2, c.iter))
}

impl<'a> GcellDetailRouter<'a> {
    /// GcellDetailRouter::GcellDetailRouter 의 복사 부분 (GcellDetailRouter.cpp:22-45)
    fn new(GR: &'a GcellGlobalRouter, path_number: i32, grid_scale: i32) -> Self {
        GcellDetailRouter {
            Nets: GR.Nets.clone(),
            Blocks: &GR.Blocks,
            Terminals: &GR.Terminals,
            PowerNets: &GR.PowerNets,
            drc_info: &GR.drc_info,
            cross_layer_drc_info: &GR.cross_layer_drc_info,
            Gcell: &GR.Gcell,
            terminal_routing: GR.terminal_routing,
            lowest_metal: GR.lowest_metal,
            highest_metal: GR.highest_metal,
            width: GR.width,
            height: GR.height,
            LL: GR.LL,
            UR: GR.UR,
            path_number,
            grid_scale,
            layerNo: GR.drc_info.Metal_info.len() as i32,
        }
    }

    // ------------------------------------------------------------ 핀 순서 (GcellDetailRouter.cpp:300-365)

    /// GcellDetailRouter::SortPinsOrder — 넷 중심(블록 핀 접점 중심의 평균)을 구하고, x+y (대칭 짝이 앞선 넷이면
    /// (폭-x)+y) 로 정렬한 뒤, 앞의 핀들에 가장 가까운 순으로 하나씩 다시 정렬한다. 단자이거나 접점 없는 핀이
    /// 끼면 비교 함수가 늘 참이다 — libc++ std::sort 를 그대로 옮긴 sort.rs 로 같은 순서를 낸다.
    fn SortPinsOrder(&mut self) -> Result<(), String> {
        let Blocks = self.Blocks;
        let width = self.width;
        // 단자가 아니고 접점이 있으면 첫 접점 중심
        let c0 = |c: &connectNode| -> Result<Option<point>, String> {
            if c.type_ == NType::TERMINAL {
                return Ok(None);
            }
            let pin = pin_of(Blocks, c)?;
            Ok(pin.pinContacts.first().map(|pc| pc.placedCenter))
        };
        for i in 0..self.Nets.len() {
            if self.Nets[i].connected.is_empty() {
                continue;
            }
            // 넷 중심
            let (mut cx, mut cy, mut count) = (self.Nets[i].center_x, self.Nets[i].center_y, 0i32);
            for c in &self.Nets[i].connected {
                if c.type_ == NType::TERMINAL {
                    continue;
                }
                let pin = pin_of(Blocks, c)?;
                for pc in &pin.pinContacts {
                    cx = cx.wrapping_add(pc.placedCenter.x);
                    cy = cy.wrapping_add(pc.placedCenter.y);
                    count += 1;
                }
            }
            if count != 0 {
                cx = cx.wrapping_div(count);
                cy = cy.wrapping_div(count);
            }
            self.Nets[i].center_x = cx;
            self.Nets[i].center_y = cy;
            // 비교 함수가 쓰는 값을 미리 (범위 밖 블록·핀은 여기서 Err)
            for c in &self.Nets[i].connected {
                c0(c)?;
            }
            let sc = self.Nets[i].symCounterpart;
            // `symCounterpart < i` 는 unsigned 비교 — 음수는 거짓
            let mirrored = sc != -1 && sc >= 0 && (sc as usize) < i;
            let key = |p: point| if mirrored { width.wrapping_sub(p.x).wrapping_add(p.y) } else { p.x.wrapping_add(p.y) };
            let mut conn = std::mem::take(&mut self.Nets[i].connected);
            let mut less = |_: &[connectNode], a: &connectNode, b: &connectNode| -> bool {
                match (c0(a).ok().flatten(), c0(b).ok().flatten()) {
                    (Some(pa), Some(pb)) => key(pa) < key(pb),
                    _ => true,
                }
            };
            let r = sort::sort(&mut conn, 0, &mut less);
            if let Err(e) = r {
                self.Nets[i].connected = conn;
                return Err(e);
            }
            // 가까운 이웃 잇기: j 번째부터를 앞의 j 개에 가장 가까운 순으로
            let n = conn.len();
            let mut j = 1;
            while j + 1 < n {
                let mut less = |v: &[connectNode], a: &connectNode, b: &connectNode| -> bool {
                    let (Some(pa), Some(pb)) = (c0(a).ok().flatten(), c0(b).ok().flatten()) else { return true };
                    let (mut da, mut db): (Option<i32>, Option<i32>) = (None, None);
                    for node_k in &v[..j] {
                        let Some(pk) = c0(node_k).ok().flatten() else { continue };
                        let a_k = pa.x.wrapping_sub(pk.x).wrapping_abs().wrapping_add(pa.y.wrapping_sub(pk.y).wrapping_abs());
                        let b_k = pb.x.wrapping_sub(pk.x).wrapping_abs().wrapping_add(pb.y.wrapping_sub(pk.y).wrapping_abs());
                        da = Some(da.map_or(a_k, |d| d.min(a_k)));
                        db = Some(db.map_or(b_k, |d| d.min(b_k)));
                    }
                    match (da, db) {
                        (Some(x), Some(y)) => x < y,
                        _ => true,
                    }
                };
                if let Err(e) = sort::sort(&mut conn, j, &mut less) {
                    self.Nets[i].connected = conn;
                    return Err(e);
                }
                j += 1;
            }
            self.Nets[i].connected = conn;
        }
        Ok(())
    }

    // ------------------------------------------------------------ 집합 (GcellDetailRouter.cpp:134-178, 919-975, 1519-1538)

    /// Contact2Sinkdata
    #[inline]
    fn c5(c: &contact) -> C5 {
        (c.placedLL.x, c.placedLL.y, c.metal, c.placedUR.x, c.placedUR.y)
    }

    /// GcellDetailRouter::ReturnInternalMetalContactALL — 블록 내부 금속, 모든 핀 접점·핀 비아의 위아래 사각형,
    /// 전원 넷 핀 접점, 넷 경로
    fn ReturnInternalMetalContactALL(&self, Set: &mut BTreeSet<C5>) {
        for b in self.Blocks {
            for c in &b.InternalMetal {
                Set.insert(Self::c5(c));
            }
            for p in &b.pins {
                for c in &p.pinContacts {
                    Set.insert(Self::c5(c));
                }
                for v in &p.pinVias {
                    Set.insert(Self::c5(&v.UpperMetalRect));
                    Set.insert(Self::c5(&v.LowerMetalRect));
                }
            }
        }
        self.insert_power_and_paths(Set);
    }

    fn insert_power_and_paths(&self, Set: &mut BTreeSet<C5>) {
        for n in self.PowerNets {
            for p in &n.pins {
                for c in &p.pinContacts {
                    Set.insert(Self::c5(c));
                }
            }
        }
        for n in &self.Nets {
            for m in &n.path_metal {
                Set.insert(Self::c5(&m.MetalRect));
            }
            for v in &n.path_via {
                Set.insert(Self::c5(&v.UpperMetalRect));
                Set.insert(Self::c5(&v.LowerMetalRect));
            }
        }
    }

    /// GcellDetailRouter::ReturnInternalMetalContact — 같은데 이 넷의 핀은 (그 자리에서) 지운다
    fn ReturnInternalMetalContact(&self, Set: &mut BTreeSet<C5>, net_num: usize) {
        Set.clear();
        for b in self.Blocks {
            for c in &b.InternalMetal {
                Set.insert(Self::c5(c));
            }
            for p in &b.pins {
                if p.netIter != net_num as i32 {
                    for c in &p.pinContacts {
                        Set.insert(Self::c5(c));
                    }
                    for v in &p.pinVias {
                        Set.insert(Self::c5(&v.UpperMetalRect));
                        Set.insert(Self::c5(&v.LowerMetalRect));
                    }
                } else {
                    for c in &p.pinContacts {
                        Set.remove(&Self::c5(c));
                    }
                    for v in &p.pinVias {
                        Set.remove(&Self::c5(&v.UpperMetalRect));
                        Set.remove(&Self::c5(&v.LowerMetalRect));
                    }
                }
            }
        }
        self.insert_power_and_paths(Set);
    }

    /// GcellDetailRouter::InsertInternalVia — 블록 내부 비아와 핀 비아의 (모형, 자리)
    fn InsertInternalVia(&self, Pset_via: &mut BTreeSet<P3>) {
        for b in self.Blocks {
            for v in &b.InternalVia {
                Pset_via.insert((v.model_index, v.position.x, v.position.y));
            }
            for p in &b.pins {
                for v in &p.pinVias {
                    Pset_via.insert((v.model_index, v.position.x, v.position.y));
                }
            }
        }
    }

    /// GcellDetailRouter::InsertPhysicalPathToSetX — 넷 경로 전체 (금속 사각형, 비아 위·아래)
    fn InsertPhysicalPathToSetX(&self, net_index: usize, Set: &mut BTreeSet<C5>) {
        let n = &self.Nets[net_index];
        for m in &n.path_metal {
            Set.insert(Self::c5(&m.MetalRect));
        }
        for v in &n.path_via {
            Set.insert(Self::c5(&v.UpperMetalRect));
            Set.insert(Self::c5(&v.LowerMetalRect));
        }
    }

    // ------------------------------------------------------------ 넷의 격자 (GcellDetailRouter.cpp:870-899, 990-1045)

    fn tile(&self, t: i32) -> Result<&crate::rdb::tile, String> {
        usize::try_from(t)
            .ok()
            .and_then(|u| self.Gcell.tiles_total.get(u))
            .ok_or_else(|| format!("GcellDetailRouter: tiles_total[{t}] 이 없다 (정의되지 않은 동작)"))
    }

    /// GcellDetailRouter::Adding_tiles_for_terminal — 단자 칸과 그 칸 기둥 전체 (아래로 끝까지, 그다음 위로)
    fn Adding_tiles_for_terminal(&self, tile_index0: i32, global_path: &mut Vec<(i32, i32)>) -> Result<(), String> {
        let mut tile_index = tile_index0;
        global_path.push((tile_index, tile_index));
        let limit = self.Gcell.tiles_total.len() + 1;
        let mut steps = 0;
        while let Some(e) = self.tile(tile_index)?.down.first() {
            // down 이 둘 이상이면 "Tile error" + assert(0) (꺼져 있다)
            tile_index = e.next;
            global_path.push((tile_index, tile_index));
            steps += 1;
            if steps > limit {
                return Err("Adding_tiles_for_terminal: 칸의 down 이 고리를 돈다 (C++ 은 끝나지 않는다)".into());
            }
        }
        while let Some(e) = self.tile(tile_index)?.up.first() {
            tile_index = e.next;
            global_path.push((tile_index, tile_index));
            steps += 1;
            if steps > 2 * limit {
                return Err("Adding_tiles_for_terminal: 칸의 up 이 고리를 돈다 (C++ 은 끝나지 않는다)".into());
            }
        }
        Ok(())
    }

    /// `Nets[k].STs[Nets[k].STindex].path` — 전역 배선이 후보를 못 낸 넷(STs 가 빈 것, STindex 는 기본값 0)은
    /// 빈 벡터의 [0] 을 읽는다. 기준(wasm32)은 데이터 포인터가 null 이고 0 번지 쪽이 0 이라 빈 경로를 읽고
    /// 지나간다 — 그대로 빈 경로. 그 밖의 범위 밖은 힙을 읽는다 (정의되지 않은 동작): Err.
    fn st_path<'n>(net: &'n Net, what: &str) -> Result<&'n [(i32, i32)], String> {
        if net.STs.is_empty() && net.STindex == 0 {
            return Ok(&[]);
        }
        usize::try_from(net.STindex)
            .ok()
            .and_then(|s| net.STs.get(s))
            .map(|st| st.path.as_slice())
            .ok_or_else(|| format!("GcellDetailRouter: {what} {} 의 STs[{}] 이 없다 (정의되지 않은 동작)", net.netName, net.STindex))
    }

    /// GcellDetailRouter::Generate_Grid_Net — 전역 경로 + 핀 칸 기둥 + (마지막 넷이 아닌) 대칭 짝의 전역 경로와
    /// 핀 칸으로 격자를 짓는다. 층 범위는 넷의 배선층과 칸 격자 범위의 겹침을 핀 층까지 넓힌 것.
    /// (기준 빌드는 NRVO 로 격자를 복사하지 않아 넷 중심이 A* 에 남는다 — 복사 생성자는 중심을 안 옮긴다.)
    fn Generate_Grid_Net(&self, i: usize) -> Result<Grid<'a>, String> {
        let net = &self.Nets[i];
        let mut global_path = Self::st_path(net, "넷")?.to_vec();
        for &t in &net.terminals {
            self.Adding_tiles_for_terminal(t, &mut global_path)?;
        }
        let sc = net.symCounterpart;
        if sc != -1 && sc < self.Nets.len() as i32 - 1 {
            let sn = usize::try_from(sc)
                .ok()
                .and_then(|s| self.Nets.get(s))
                .ok_or_else(|| format!("GcellDetailRouter: 대칭 짝 Nets[{sc}] 이 없다 (정의되지 않은 동작)"))?;
            global_path.extend(Self::st_path(sn, "대칭 짝")?.iter().copied());
            for &t in &sn.terminals {
                global_path.push((t, t));
            }
        }
        let mut temp_lowest_metal = net.min_routing_layer.max(self.Gcell.lowest_metal);
        let mut temp_highest_metal = net.max_routing_layer.min(self.Gcell.highest_metal);
        for c in &net.connected {
            if c.type_ == NType::BLOCK {
                for pc in &pin_of(self.Blocks, c)?.pinContacts {
                    temp_lowest_metal = pc.metal.min(temp_lowest_metal);
                    temp_highest_metal = pc.metal.max(temp_highest_metal);
                }
            }
        }
        let mut grid = Grid::new(self.Gcell, &global_path, self.drc_info, self.LL, self.UR, temp_lowest_metal, temp_highest_metal, self.grid_scale)?;
        // grid.Full_Connected_Vertex(): 평행 배선(left/right > 0)에서만 읽힌다
        grid.center_x = net.center_x;
        grid.center_y = net.center_y;
        Ok(grid)
    }

    /// GcellDetailRouter::findPins_new — 연결마다 핀 접점 사각형들 (단자는 층을 아는 접점만 — 모드 4 가 층을
    /// -1 로 두므로 늘 빈 목록)
    fn findPins_new(&self, i: usize) -> Result<Vec<Vec<Sink>>, String> {
        let mut temp_Pin = Vec::new();
        for c in &self.Nets[i].connected {
            let mut temp_contacts = Vec::new();
            if c.type_ == NType::BLOCK {
                for pc in &pin_of(self.Blocks, c)?.pinContacts {
                    temp_contacts.push(Sink { LL: pc.placedLL, UR: pc.placedUR, metalIdx: pc.metal });
                }
            } else {
                let t = usize::try_from(c.iter)
                    .ok()
                    .and_then(|u| self.Terminals.get(u))
                    .ok_or_else(|| format!("std::out_of_range: vector (Terminals.at({}))", c.iter))?;
                // 접점이 없으면 C++ 은 termContacts[0] 을 읽는다 (정의되지 않은 동작) — 무엇을 읽든 돌 접점이 없어 빈 목록
                if t.termContacts.first().is_some_and(|c| c.metal != -1) {
                    for tc in &t.termContacts {
                        temp_contacts.push(Sink { LL: tc.placedLL, UR: tc.placedUR, metalIdx: tc.metal });
                    }
                }
            }
            temp_Pin.push(temp_contacts);
        }
        Ok(temp_Pin)
    }

    /// GcellDetailRouter::Grid_Inactive_One_Layer — `unsigned i <= end` 라 층에 꼭짓점이 없으면(끝 = -1)
    /// 벡터 끝까지 끄고 `.at` 이 던진다
    fn Grid_Inactive_One_Layer(grid: &mut Grid, layer: i32) -> Result<(), String> {
        let at = |v: &[i32]| usize::try_from(layer).ok().and_then(|u| v.get(u)).copied().ok_or_else(|| format!("std::out_of_range: vector (Start/End_index_metal_vertices.at({layer}))"));
        let (s, e) = (at(&grid.Start_index_metal_vertices)?, at(&grid.End_index_metal_vertices)?);
        if e < 0 {
            return Err(format!("Grid_Inactive_One_Layer: 층 {layer} 에 꼭짓점이 없다 (C++ 은 unsigned 비교로 끝까지 돌다 .at 이 던진다)"));
        }
        let mut i = s;
        while i <= e {
            grid.vertices_total[i as usize].active = false;
            i += 1;
        }
        Ok(())
    }

    /// GcellDetailRouter::Mirror_Topology — 가로축(H)이면 y 를, 아니면 x 를 2·center 에서 뺀다
    fn Mirror_Topology(sym_path: &mut [Metal], HV_sym: bool, center: i32) {
        for m in sym_path.iter_mut() {
            for p in m.LinePoint.iter_mut().take(2) {
                if HV_sym {
                    p.y = 2i32.wrapping_mul(center).wrapping_sub(p.y);
                } else {
                    p.x = 2i32.wrapping_mul(center).wrapping_sub(p.x);
                }
            }
        }
    }

    // ------------------------------------------------------------ 상세 배선 (GcellDetailRouter.cpp:367-514)

    /// GcellDetailRouter::create_detailrouter_new
    fn create_detailrouter_new(&mut self) -> Result<(), String> {
        self.SortPinsOrder()?;
        if tr() {
            trace_sort(&self.Nets);
        }
        let mut Set_x: BTreeSet<C5> = BTreeSet::new();
        let mut Set_x_contact: BTreeSet<C5> = BTreeSet::new();
        self.ReturnInternalMetalContactALL(&mut Set_x);
        let mut Set_net_contact: BTreeSet<C5> = BTreeSet::new();
        let mut Pset_via: BTreeSet<P3> = BTreeSet::new();
        self.InsertInternalVia(&mut Pset_via);

        for i in 0..self.Nets.len() {
            if self.Nets[i].DoNotRoute {
                continue;
            }
            let multi_number = self.Nets[i].multi_connection;
            let mut symmetry_path: Vec<Metal> = Vec::new();
            let sc = self.Nets[i].symCounterpart;
            if sc != -1 && sc < self.Nets.len() as i32 {
                if sc < 0 {
                    return Err(format!("GcellDetailRouter: 넷 {} 의 대칭 짝 {sc} (C++ 은 Nets[{sc}] 를 읽는다)", self.Nets[i].netName));
                }
                symmetry_path = self.Nets[sc as usize].path_metal.clone();
                // 축 = 두 넷 핀 중심 x 의 평균 — 가로축 대칭에도 x 로 (GcellDetailRouter.cpp:404)
                let center = self.Nets[i].center_x.wrapping_add(self.Nets[sc as usize].center_x) / 2;
                Self::Mirror_Topology(&mut symmetry_path, self.Nets[i].sym_H, center);
            }
            // check_floating_net: 전역 경로가 없으면 건너뛴다
            if self.Nets[i].global_path.is_empty() {
                continue;
            }
            for _multi_index in 0..multi_number {
                let mut Pset_current_net_via: BTreeSet<P3> = BTreeSet::new();
                let mut Set_current_net_contact: BTreeSet<C5> = BTreeSet::new();
                self.ReturnInternalMetalContact(&mut Set_x_contact, i);
                if self.Nets[i].connected.len() <= 1 {
                    continue;
                }
                let mut grid = self.Generate_Grid_Net(i)?;
                let temp_pins = self.findPins_new(i)?;
                // Symmetry_metal_Inactive: 대칭 짝 블록 사각형을 모으기만 하고 쓰지 않는다
                if self.Nets[i].min_routing_layer == grid.lowest_metal + 1 {
                    let l = grid.lowest_metal;
                    Self::Grid_Inactive_One_Layer(&mut grid, l)?;
                }
                if self.Nets[i].max_routing_layer == grid.highest_metal - 1 {
                    let h = grid.highest_metal;
                    Self::Grid_Inactive_One_Layer(&mut grid, h)?;
                }
                let mut temp_source: Vec<Sink> = temp_pins[0].clone();
                #[allow(clippy::needless_range_loop)] // j 는 C++ 처럼 연결 번호 (자취에 찍는다)
                for j in 1..temp_pins.len() {
                    let temp_dest: Vec<Sink> = temp_pins[j].clone();
                    // 출발·도착 사각형을 장애물에서 뺀다
                    for s in temp_source.iter().chain(temp_dest.iter()) {
                        Set_x.remove(&c5s(s));
                    }
                    self.Grid_Inactive_new(&mut grid, &Set_x)?;
                    if tr() {
                        trace_inactive("ST inact", i, j, &grid);
                    }
                    let (gridll, gridur) = ((grid.GridLL.x, grid.GridLL.y), (grid.GridUR.x, grid.GridUR.y));
                    // Detailed_router_set_src_dest_new
                    grid.setSrcDest(&temp_source, &temp_dest, false)?;
                    grid.ActivateSourceDest();
                    let src_dest_plist = self.CreatePlistSrc_Dest(&temp_source, &temp_dest)?;
                    grid.SetPointlist(&src_dest_plist, true);
                    grid.setSrcDest(&temp_source, &temp_dest, true)?;
                    grid.PrepareGraphVertices(gridll, gridur)?;
                    if tr() {
                        trace_inactive("ST srcdest", i, j, &grid);
                        trace_src_dest(i, j, &temp_source, &temp_dest, Set_x.len());
                    }
                    self.AddViaEnclosure(&mut grid, &Set_x_contact, &Set_net_contact, gridll, gridur, &temp_source, &temp_dest)?;
                    self.AddViaSpacing(&Pset_via, &mut grid, gridll, gridur)?;
                    let mut a_star = A_star::new(&grid, self.Nets[i].shielding);
                    let pathMark = a_star.FindFeasiblePath_sym(&mut grid, self.path_number, 0, 0, &symmetry_path)?;
                    if tr() {
                        trace_conn(i, j, &grid, gridll, gridur, &a_star.Path);
                    }

                    let mut physical_path: Vec<Vec<Metal>> = Vec::new();
                    let mut physical_via: Vec<Via> = Vec::new();
                    if pathMark {
                        physical_path = a_star.ConvertPathintoPhysical(&grid);
                        let extend_labels = a_star.Extend_labels.clone();
                        self.returnPath_new(&mut physical_path, i, &extend_labels, &mut physical_via)?;
                        Self::InsertRoutingVia(&a_star.Path, &grid, &mut Pset_current_net_via);
                        Self::InsertRoutingVia(&a_star.Path, &grid, &mut Pset_via);
                        self.InsertRoutingContact(&Pset_current_net_via, &mut Set_current_net_contact, i)?;
                    } else {
                        crate::route::warn(format!("Router-Warning: feasible path might not be found ({} 의 핀 {j})", self.Nets[i].netName));
                    }

                    // InsertSourceDestPinContact
                    for s in temp_source.iter().chain(temp_dest.iter()) {
                        Set_x.insert(c5s(s));
                    }
                    // Update_Grid_Src_Dest (source_lock = 0): updateSource_new, 출발·도착 끄기(곧 Refresh_Grid 가 되돌린다)
                    for p in &physical_path {
                        for m in p {
                            temp_source.push(Sink { LL: m.MetalRect.placedLL, UR: m.MetalRect.placedUR, metalIdx: m.MetalIdx });
                        }
                    }
                    // 비아의 아래 사각형은 coord 를 비우지 않고 덧붙여서 (점 넷) 앞 두 점이 위 사각형 그대로다 —
                    // 층만 아래층인 위 사각형이 된다 (GcellDetailRouter.cpp:3198-3205)
                    for v in &physical_via {
                        temp_source.push(Sink { LL: v.UpperMetalRect.placedLL, UR: v.UpperMetalRect.placedUR, metalIdx: v.UpperMetalRect.metal });
                        temp_source.push(Sink { LL: v.UpperMetalRect.placedLL, UR: v.UpperMetalRect.placedUR, metalIdx: v.LowerMetalRect.metal });
                    }
                    grid.InactivateSourceDest();
                    grid.SetPointlist(&src_dest_plist, false);
                    temp_source.extend(temp_dest.iter().copied());
                    self.InsertPhysicalPathToSetX(i, &mut Set_x);
                    // Refresh_Grid
                    for v in grid.vertices_total.iter_mut() {
                        v.active = true;
                        v.via_active_down = true;
                        v.via_active_up = true;
                    }
                }
                // InsertContact2Contact
                Set_net_contact.extend(Set_current_net_contact.iter().copied());
            }
        }
        Ok(())
    }

    // ------------------------------------------------------------ PnRDB 로 (GcellDetailRouter.cpp:4667-4984)

    fn metal_name(&self, m: i32) -> Result<String, String> {
        usize::try_from(m)
            .ok()
            .and_then(|u| self.drc_info.Metal_info.get(u))
            .map(|mi| mi.name.clone())
            .ok_or_else(|| format!("GcellDetailRouter: Metal_info[{m}] 이 없다 (정의되지 않은 동작)"))
    }

    fn via_name(&self, v: i32) -> Result<String, String> {
        usize::try_from(v)
            .ok()
            .and_then(|u| self.drc_info.Via_info.get(u))
            .map(|vi| vi.name.clone())
            .ok_or_else(|| format!("GcellDetailRouter: Via_info[{v}] 이 없다 (정의되지 않은 동작)"))
    }

    fn P(p: point) -> db::Point {
        db::Point { x: p.x, y: p.y }
    }

    /// ConvertToContactPnRDB_Placed_Origin — 이름과 origin 칸에 (placed 칸은 비운다)
    fn Placed_Origin(&self, c: &contact) -> Result<db::Contact, String> {
        Ok(db::Contact {
            metal: self.metal_name(c.metal)?,
            originBox: BBox { LL: Self::P(c.placedLL), UR: Self::P(c.placedUR) },
            originCenter: Self::P(c.placedCenter),
            ..db::Contact::default()
        })
    }

    /// ConvertToViaPnRDB_Placed_Origin
    fn Via_Placed_Origin(&self, v: &Via) -> Result<db::Via, String> {
        let rect = |c: &contact, name: String| db::Contact {
            metal: name,
            originBox: BBox { LL: Self::P(c.placedLL), UR: Self::P(c.placedUR) },
            originCenter: Self::P(c.placedCenter),
            ..db::Contact::default()
        };
        Ok(db::Via {
            model_index: v.model_index,
            originpos: Self::P(v.position),
            ViaRect: rect(&v.ViaRect, self.via_name(v.ViaRect.metal)?),
            LowerMetalRect: rect(&v.LowerMetalRect, self.metal_name(v.LowerMetalRect.metal)?),
            UpperMetalRect: rect(&v.UpperMetalRect, self.metal_name(v.UpperMetalRect.metal)?),
            ..db::Via::default()
        })
    }

    /// ConvertToViaPnRDB_Placed_Placed
    fn Via_Placed_Placed(&self, v: &Via) -> Result<db::Via, String> {
        let rect = |c: &contact, name: String| db::Contact {
            metal: name,
            placedBox: BBox { LL: Self::P(c.placedLL), UR: Self::P(c.placedUR) },
            placedCenter: Self::P(c.placedCenter),
            ..db::Contact::default()
        };
        Ok(db::Via {
            model_index: v.model_index,
            placedpos: Self::P(v.position),
            ViaRect: rect(&v.ViaRect, self.via_name(v.ViaRect.metal)?),
            LowerMetalRect: rect(&v.LowerMetalRect, self.metal_name(v.LowerMetalRect.metal)?),
            UpperMetalRect: rect(&v.UpperMetalRect, self.metal_name(v.UpperMetalRect.metal)?),
            ..db::Via::default()
        })
    }

    /// GcellDetailRouter::NetToNodeNet — 금속은 이름·placed 칸, 비아는 placed 칸
    fn NetToNodeNet(&self, node: &mut HierNode, net: &Net, j: usize) -> Result<(), String> {
        for m in &net.path_metal {
            let temp_metal = db::Metal {
                MetalIdx: m.MetalIdx,
                width: m.width,
                LinePoint: vec![Self::P(m.LinePoint[0]), Self::P(m.LinePoint[1])],
                MetalRect: db::Contact {
                    metal: self.metal_name(m.MetalRect.metal)?,
                    placedBox: BBox { LL: Self::P(m.MetalRect.placedLL), UR: Self::P(m.MetalRect.placedUR) },
                    placedCenter: Self::P(m.MetalRect.placedCenter),
                    ..db::Contact::default()
                },
            };
            node.Nets[j].path_metal.push(temp_metal);
        }
        for v in &net.path_via {
            let tv = self.Via_Placed_Placed(v)?;
            node.Nets[j].path_via.push(tv);
        }
        Ok(())
    }

    /// GcellDetailRouter::NetToNodeInterMetal — 넷의 블록 핀 접점·비아, 경로 금속, 경로 비아(와 그 위·아래
    /// 사각형)를 모듈 내부 금속·비아로
    fn NetToNodeInterMetal(&self, node: &mut HierNode, net: &Net) -> Result<(), String> {
        for c in &net.connected {
            if c.type_ == NType::BLOCK {
                let pin = pin_of(self.Blocks, c)?;
                for pc in &pin.pinContacts {
                    node.interMetals.push(self.Placed_Origin(pc)?);
                }
                for pv in &pin.pinVias {
                    node.interVias.push(self.Via_Placed_Origin(pv)?);
                }
            }
        }
        for m in &net.path_metal {
            node.interMetals.push(self.Placed_Origin(&m.MetalRect)?);
        }
        for v in &net.path_via {
            let tv = self.Via_Placed_Origin(v)?;
            let (lo, up) = (tv.LowerMetalRect.clone(), tv.UpperMetalRect.clone());
            node.interVias.push(tv);
            node.interMetals.push(lo);
            node.interMetals.push(up);
        }
        Ok(())
    }

    /// GcellDetailRouter::NetToNodeBlockPins — 단자(포트)에 닿는 넷은 모듈 핀 하나로: 이름은 단자 이름,
    /// 접점은 넷의 블록 핀 접점과 경로 금속, 비아는 핀 비아와 경로 비아
    fn NetToNodeBlockPins(&self, node: &mut HierNode, net: &Net) -> Result<(), String> {
        if net.terminal_idx == -1 {
            // Router-Warning: cannot found terminal conntecting to net
            return Ok(());
        }
        let t = usize::try_from(net.terminal_idx)
            .ok()
            .and_then(|u| self.Terminals.get(u))
            .ok_or_else(|| format!("std::out_of_range: vector (Terminals.at({}))", net.terminal_idx))?;
        let mut temp_pin = db::Pin { name: t.name.clone(), netIter: -1, ..db::Pin::default() };
        if self.terminal_routing {
            let c = t.termContacts.first().ok_or("GcellDetailRouter: 단자 접점이 없다 (C++ 은 termContacts[0] 을 읽는다)")?;
            temp_pin.pinContacts.push(self.Placed_Origin(c)?);
        } else {
            for c in &net.connected {
                if c.type_ == NType::BLOCK {
                    let pin = pin_of(self.Blocks, c)?;
                    for pc in &pin.pinContacts {
                        temp_pin.pinContacts.push(self.Placed_Origin(pc)?);
                    }
                    for pv in &pin.pinVias {
                        temp_pin.pinVias.push(self.Via_Placed_Origin(pv)?);
                    }
                }
            }
            for m in &net.path_metal {
                temp_pin.pinContacts.push(self.Placed_Origin(&m.MetalRect)?);
            }
            for v in &net.path_via {
                temp_pin.pinVias.push(self.Via_Placed_Origin(v)?);
            }
        }
        node.blockPins.push(temp_pin);
        Ok(())
    }

    /// GcellDetailRouter::ReturnHierNode (GcellDetailRouter.cpp:4798-4850)
    fn ReturnHierNode(&self, node: &mut HierNode) -> Result<(), String> {
        node.blockPins.clear();
        node.interMetals.clear();
        node.interVias.clear();
        for t in node.Terminals.iter_mut() {
            t.termContacts.clear();
        }
        for n in node.Nets.iter_mut() {
            n.path_metal.clear();
            n.path_via.clear();
        }
        for net in &self.Nets {
            if net.isTerminal {
                self.NetToNodeBlockPins(node, net)?;
            } else {
                self.NetToNodeInterMetal(node, net)?;
            }
            if let Some(j) = node.Nets.iter().position(|h| h.name == net.netName) {
                node.Nets[j].path_metal.clear();
                node.Nets[j].path_via.clear();
                self.NetToNodeNet(node, net, j)?;
            }
        }
        // terminal_routing 이면 TerminalToNodeTerminal — 늘 0
        // BlockInterMetalToNodeInterMetal
        for b in self.Blocks {
            for c in &b.InternalMetal {
                node.interMetals.push(self.Placed_Origin(c)?);
            }
            for v in &b.InternalVia {
                node.interVias.push(self.Via_Placed_Origin(v)?);
            }
        }
        Ok(())
    }
}
