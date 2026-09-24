//! RouteWork 4 — GcellGlobalRouter (전역 배선). router/GcellGlobalRouter.cpp, GlobalGrid.cpp,
//! GlobalGraph.cpp 를 옮긴다. ILP 는 lp_solve 그대로 (crate::lp).
//!
//! 순서 (GcellGlobalRouter.cpp:450-639):
//!   getDRCdata, getData -> placeTerminals (넷마다 첫 단자 연결을 지운다) -> 칸 크기(넓이 곱이 32 비트로 넘친다:
//!   20 또는 100 트랙) -> 핀 층으로 Lmetal/Hmetal 넓히기 -> GlobalGrid (grid.rs) + 장애물·용량 -> SetNetSink
//!   (핀 -> 칸 묶음) -> SymNet (sym.rs) -> 넷마다 후보 트리 5 개 (graph.rs) -> MirrorSymSTs -> ILP (ilp.rs)
//!   -> ReturnHierNode (hierNode 에 tiles_total, 넷의 GcellGlobalRouterPath·connectedTile).
//!
//! 모드 5 (GcellDetailRouter) 가 읽는 것은 C++ 멤버 이름 그대로 `pub` 으로 둔다 (RawRouter + GcellGlobalRouter,
//! 격자는 `Gcell`). 그림 파일 쓰기(PlotGlobalRouter*)는 결과에 닿지 않아 뺐다. 죽은 길(terminal_routing = 1 의
//! PlaceTerminal, JudgeSymmetry, 옛 ILP)도 뺐다. C++ 이 던지는 예외(`.at` 범위 밖, "Empty path")와 정의되지
//! 않은 동작(범위 밖 `operator[]` 등)은 Err 로 돌려준다 — 모듈 하나가 통째로 멈춘다. 일부러 다르게 한 곳은 하나:
//! C++ 이 끝나지 않는 MST 반복(Routing_Layers 로 그래프 번호가 어긋날 때, 메모리가 다할 때까지 돈다)을 알아보고
//! Err 로 멈춘다 (graph.rs MST).
//!
//! 검증: 기준 덤프 20 회 + 제약 변형(constref) 30 회가 기록까지 같고, ALIGN 원본 C++ 을 네이티브로 빌드한 것과
//! 무작위 hierNode 수천 개에서 내부 상태(Nets·Gcell 전부)까지 같다 (정의되지 않은 동작에 닿는 사례만 빼고).
#![allow(non_snake_case, non_camel_case_types)]

mod graph;
mod grid;
mod ilp;
mod sym;

pub use graph::{Edge, GlobalGraph, Node};
pub use grid::GlobalGrid;
pub use sym::TileSet;

use crate::db::{self, DrcInfo, HierNode};
use crate::rdb::{
    connectNode, contact, point, terminal, Block, Metal, NType, Net, Omark, Pin, PowerGrid, PowerNet, SteinerTree, Via,
};

/// ILP 변수 하나 (GcellGlobalRouter::valInfo)
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct valInfo {
    pub netIter: i32,
    pub STIter: i32,
    pub segIter: i32,
    pub candIter: i32,
    pub valIter: i32,
}

/// 모드 5 가 읽는 전역 배선 상태 — RawRouter 와 GcellGlobalRouter 의 멤버 (C++ 이름 그대로)
#[derive(Clone, Debug)]
pub struct GcellGlobalRouter {
    // ---- RawRouter
    /// getData 순서의 넷 (첫 단자 연결을 지운 뒤). 넷마다 STs(후보 5 개 — 칸 묶음이 모두 비면 없다), STindex
    /// (고른 것, 기본 0), global_path, terminals, connectedTile(연결마다 칸 묶음, 단자 연결은 빈 묶음) 이 채워져 있다.
    /// C++ RouterDB::Net 의 R_constraints/C_constraints 는 rdb::Net 에 없다 (db::HierNode 에 R/C 제약이 없어 늘 빈다).
    pub Nets: Vec<Net>,
    pub Blocks: Vec<Block>,
    pub Terminals: Vec<terminal>,
    pub PowerNets: Vec<PowerNet>,
    pub terminal_routing: bool,
    pub Vdd_grid: PowerGrid,
    pub Gnd_grid: PowerGrid,
    pub LL: point,
    pub UR: point,
    pub path_number: i32,
    /// getData 가 `Metalmap[..]`/`Viamap[..]` 로 넣은 키까지 든 사본
    pub drc_info: DrcInfo,
    /// getData 전에 뜬 사본 (넣은 키 없음)
    pub cross_layer_drc_info: DrcInfo,
    /// 넓히기 **전의** Lmetal/Hmetal (넓힌 것은 Gcell.lowest_metal/highest_metal)
    pub lowest_metal: i32,
    pub highest_metal: i32,
    pub grid_scale: i32,
    pub isTop: bool,
    pub width: i32,
    pub height: i32,
    pub topName: String,
    /// GcellGlobalRouter 는 건드리지 않는다 (0)
    pub layerNo: i32,
    pub Minlength_ViaLength_Diff: Vec<i32>,
    // ---- GcellGlobalRouter
    pub ValArray: Vec<valInfo>,
    pub NumOfVar: i32,
    pub Gcell: GlobalGrid,
}

/// C++ 의 `std::out_of_range` (`.at`)
pub(crate) fn at<'a, T>(v: &'a [T], i: i32, what: &str) -> Result<&'a T, String> {
    usize::try_from(i).ok().and_then(|u| v.get(u)).ok_or_else(|| format!("std::out_of_range: vector ({what}.at({i}), 크기 {})", v.len()))
}

pub(crate) fn at_mut<'a, T>(v: &'a mut [T], i: i32, what: &str) -> Result<&'a mut T, String> {
    let n = v.len();
    usize::try_from(i).ok().and_then(|u| v.get_mut(u)).ok_or_else(|| format!("std::out_of_range: vector ({what}.at({i}), 크기 {n})"))
}

/// C++ 에서 정의되지 않은 동작 (범위 밖 operator[] 등) — 기준과 같을 수 없어 멈춘다
pub(crate) fn ub(what: impl std::fmt::Display) -> String {
    format!("GcellGlobalRouter: 정의되지 않은 동작 — {what}")
}

fn omark(s: &str) -> Omark {
    match s {
        "Omark.S" => Omark::S,
        "Omark.W" => Omark::W,
        "Omark.E" => Omark::E,
        "Omark.FN" => Omark::FN,
        "Omark.FS" => Omark::FS,
        "Omark.FW" => Omark::FW,
        "Omark.FE" => Omark::FE,
        _ => Omark::N,
    }
}

fn pt(p: db::Point) -> point {
    point::new(p.x, p.y)
}

/// Blocks[iter2].pins[iter] (C++ 은 operator[] — 범위 밖은 정의되지 않은 동작)
fn block_pin(Blocks: &[Block], iter2: i32, iter: i32) -> Result<&Pin, String> {
    usize::try_from(iter2)
        .ok()
        .and_then(|b| Blocks.get(b))
        .and_then(|b| usize::try_from(iter).ok().and_then(|p| b.pins.get(p)))
        .ok_or_else(|| ub(format!("Blocks[{iter2}].pins[{iter}]")))
}

impl Default for GcellGlobalRouter {
    /// RawRouter() + GcellGlobalRouter 의 멤버 초기값
    fn default() -> Self {
        GcellGlobalRouter {
            Nets: Vec::new(),
            Blocks: Vec::new(),
            Terminals: Vec::new(),
            PowerNets: Vec::new(),
            terminal_routing: false,
            Vdd_grid: PowerGrid::default(),
            Gnd_grid: PowerGrid::default(),
            LL: point::default(),
            UR: point::default(),
            path_number: 1,
            drc_info: DrcInfo::default(),
            cross_layer_drc_info: DrcInfo::default(),
            lowest_metal: 0,
            highest_metal: 0,
            grid_scale: 1,
            isTop: false,
            width: 0,
            height: 0,
            topName: "defaultDesign".into(),
            layerNo: 0,
            Minlength_ViaLength_Diff: Vec::new(),
            ValArray: Vec::new(),
            NumOfVar: 0,
            Gcell: GlobalGrid::default(),
        }
    }
}

impl GcellGlobalRouter {
    /// GcellGlobalRouter(node, drcData, Lmetal, Hmetal) — 전역 배선을 하고 hierNode 에 결과를 쓴다
    pub fn new(node: &mut HierNode, drcData: &DrcInfo, Lmetal: i32, Hmetal: i32) -> Result<Self, String> {
        let mut r = GcellGlobalRouter { terminal_routing: false, ..Default::default() };
        let (mut Lmetal, mut Hmetal) = (Lmetal, Hmetal);

        // 1. 자료
        r.getDRCdata(drcData);
        r.getData(node, Lmetal, Hmetal)?;
        if r.terminal_routing {
            // PlaceTerminal() — terminal_routing 은 늘 0 이라 닿지 않는다
        } else if !node.isIntelGcellGlobalRouter {
            r.placeTerminals();
        }

        // 2. 칸 격자. 넓이 곱은 int 로 넘친다 — 1e10 보다 큰 비교는 늘 참이라 20 아니면 100 이다.
        let chip_size = r.UR.x.wrapping_sub(r.LL.x).wrapping_mul(r.UR.y.wrapping_sub(r.LL.y));
        let cs = i64::from(chip_size);
        let mut tile_size = if chip_size < 1000000 {
            20
        } else if cs < 10000000000 {
            100
        } else if cs < 1000000000000 {
            1000
        } else if cs < 100000000000000 {
            10000
        } else {
            100000
        };
        let tileLayerNo = 1;
        if node.isIntelGcellGlobalRouter {
            tile_size = 10;
        }
        // 블록 핀 층이 넷의 층 범위 ±1 안이면 Lmetal/Hmetal 을 넓힌다 (밖이면 로그만)
        for net in &r.Nets {
            for c in &net.connected {
                if c.type_ == NType::BLOCK {
                    let pin = block_pin(&r.Blocks, c.iter2, c.iter)?;
                    for pin_contact in &pin.pinContacts {
                        if pin_contact.metal < net.min_routing_layer.wrapping_sub(1) {
                            crate::route::warn(format!("Block {} pin {} is lower than min_routing_layer {}", r.Blocks[c.iter2 as usize].blockName,
                                                       pin.pinName, net.min_routing_layer));
                            continue;
                        }
                        if pin_contact.metal > net.max_routing_layer.wrapping_add(1) {
                            crate::route::warn(format!("Block {} pin {} is higher than max_routing_layer {}", r.Blocks[c.iter2 as usize].blockName,
                                                       pin.pinName, net.max_routing_layer));
                            continue;
                        }
                        Lmetal = Lmetal.min(pin_contact.metal);
                        Hmetal = Hmetal.max(pin_contact.metal);
                    }
                }
            }
        }

        let mut Initial_Gcell = GlobalGrid::new(&r.drc_info, r.LL.x, r.LL.y, r.UR.x, r.UR.y, Lmetal, Hmetal, tileLayerNo, tile_size)?;
        Initial_Gcell.ConvertGlobalInternalMetal(&r.Blocks)?;
        Initial_Gcell.AdjustVerticalEdgeCapacityfromInternalMetal(&r.Blocks)?;
        r.Gcell = GlobalGrid::copy(&Initial_Gcell);
        let nn = r.Nets.len() as i32;
        r.Gcell.ConvertGlobalBlockPin(&r.Blocks, &r.Nets, nn)?;
        r.Gcell.AdjustPlateEdgeCapacity()?;
        r.Gcell.AdjustVerticalEdgeCapacityfromBlockPin(&r.Blocks, &r.Nets, nn)?;
        r.Gcell.SetNetSink(&r.Blocks, &mut r.Nets, &r.Terminals, r.terminal_routing)?;

        let ST_number = 5;
        let mut GGgraph = GlobalGraph::new(&r.Gcell)?;
        let Tile_Set = Self::CreateTileSet(&r.Gcell);
        r.SymNet(&Tile_Set)?;

        // 3. 넷마다 후보 트리 (다른 넷과 무관, 그래프는 넷마다 새로)
        for i in 0..r.Nets.len() {
            GGgraph.clearPath();
            // 층 범위 = 넷의 범위와 핀 층을 다 덮게 (±1 거르기 없음)
            let mut l_metal = r.Nets[i].min_routing_layer;
            let mut h_metal = r.Nets[i].max_routing_layer;
            for c in &r.Nets[i].connected {
                if c.type_ == NType::BLOCK {
                    for pin_contact in &block_pin(&r.Blocks, c.iter2, c.iter)?.pinContacts {
                        l_metal = pin_contact.metal.min(l_metal);
                        h_metal = pin_contact.metal.max(h_metal);
                    }
                }
            }
            if l_metal == -1 {
                l_metal = 0;
            }
            if h_metal == -1 {
                h_metal = r.drc_info.Metal_info.len() as i32 - 1;
            }
            GGgraph.CreateAdjacentList_New(&r.Gcell, l_metal, h_metal)?;
            GGgraph.setterminals(&r.Nets[i].terminals);
            GGgraph.setTerminals(&r.Nets[i].connectedTile);
            let mut Pontential_Stiner_node = Self::Get_Potential_Steiner_node(&r.Nets[i].terminals, &Tile_Set, &r.Gcell)?;
            GGgraph.FindSTs(&r.Gcell, ST_number, &mut Pontential_Stiner_node)?;
            let temp_path = GGgraph.returnPath();
            let mut temp_st = SteinerTree::new();
            for p in temp_path {
                temp_st.path = p;
                r.Nets[i].STs.push(temp_st.clone());
            }
        }

        // 4. 대칭, ILP
        r.MirrorSymSTs(&Tile_Set)?;
        r.ILPSolveRouting(&GGgraph)?;

        // 5. hierNode 에 돌려준다
        r.ReturnHierNode(node);
        Ok(r)
    }

    pub fn getDRCdata(&mut self, drcData: &DrcInfo) {
        self.drc_info = drcData.clone();
        self.cross_layer_drc_info = drcData.clone();
    }

    /// PnRDB -> RouterDB. `Metalmap[..]` 같은 operator[] 는 없는 이름을 0 으로 넣는다 (drc_info 사본에).
    pub fn getData(&mut self, node: &HierNode, Lmetal: i32, Hmetal: i32) -> Result<(), String> {
        self.isTop = node.isTop;
        self.topName = node.name.clone();
        self.width = node.width;
        self.height = node.height;
        self.LL = pt(node.LL);
        self.UR = pt(node.UR);
        self.path_number = 5;
        let max_width = node.width;
        let max_height = node.height;
        self.lowest_metal = Lmetal;
        self.highest_metal = Hmetal;
        self.grid_scale = if max_height.wrapping_mul(max_width) <= 100000000 { 1 } else { 4 };

        // 단자: 접점마다 placedCenter 만 (층 -1)
        for t in &node.Terminals {
            let mut temp_terminal = terminal { netIter: t.netIter, ..Default::default() };
            for c in &t.termContacts {
                let temp_contact = contact { placedCenter: pt(c.placedCenter), metal: -1, ..Default::default() };
                temp_terminal.termContacts.push(temp_contact);
            }
            temp_terminal.name = t.name.clone();
            self.Terminals.push(temp_terminal);
        }

        // 넷
        for n in &node.Nets {
            let mut temp_net = Net {
                degree: n.degree,
                netName: n.name.clone(),
                shielding: n.shielding,
                sink2Terminal: n.sink2Terminal,
                symCounterpart: n.symCounterpart,
                iter2SNetLsit: n.iter2SNetLsit,
                priority: n.priority.clone(),
                multi_connection: n.multi_connection,
                ..Default::default()
            };
            if n.axis_dir == "Smark.H" {
                temp_net.sym_H = true;
            } else if n.axis_dir == "Smark.V" {
                temp_net.sym_H = false;
            }
            temp_net.center = n.axis_coor;
            for c in &n.connected {
                // PnRDB::NType 이 0 (Block) 이면 BLOCK, 아니면 TERMINAL — 단자가 여럿이면 마지막 것이 남는다
                let type_ = if c.is_block() {
                    NType::BLOCK
                } else {
                    temp_net.isTerminal = true;
                    temp_net.terminal_idx = c.iter;
                    NType::TERMINAL
                };
                temp_net.connected.push(connectNode { type_, iter: c.iter, iter2: c.iter2 });
            }
            for net_name in &node.DoNotRoute {
                if *net_name == temp_net.netName {
                    temp_net.DoNotRoute = true;
                }
            }
            let mut global_min = 0;
            let mut global_max = self.drc_info.MaxLayer;
            let rl = &node.Routing_Layers;
            if !rl.global_min_layer.is_empty() {
                global_min = *self.drc_info.Metalmap.entry(rl.global_min_layer.clone()).or_insert(0);
            }
            if !rl.global_max_layer.is_empty() {
                global_max = *self.drc_info.Metalmap.entry(rl.global_max_layer.clone()).or_insert(0);
            }
            temp_net.min_routing_layer = global_min;
            temp_net.max_routing_layer = global_max;
            for routing_layers in &rl.Routing_per_Net {
                if routing_layers.net_name == temp_net.netName {
                    let min_layer = global_min.max(*self.drc_info.Metalmap.entry(routing_layers.net_min_layer.clone()).or_insert(0));
                    // 버릇 (:1083): 최대 층도 max 로 — 넷의 최대 층이 전역보다 낮아도 줄지 않는다
                    let max_layer = global_max.max(*self.drc_info.Metalmap.entry(routing_layers.net_max_layer.clone()).or_insert(0));
                    temp_net.min_routing_layer = min_layer;
                    temp_net.max_routing_layer = max_layer;
                }
            }
            self.Nets.push(temp_net);
        }
        // R_Constraints / C_Constraints: db::HierNode 에 없다 (예제에서 늘 비어 있다)

        // 블록 (selectedInstance 의 variant)
        for b in &node.Blocks {
            let slcNumber = b.selectedInstance;
            let inst = usize::try_from(slcNumber)
                .ok()
                .and_then(|s| b.instance.get(s))
                .ok_or_else(|| ub(format!("instance[{slcNumber}]")))?;
            let mut temp_block = Block {
                blockName: inst.name.clone(),
                blockMaster: inst.master.clone(),
                gdsfile: inst.gdsFile.clone(),
                numTerminals: inst.blockPins.len() as i32,
                orient: omark(&inst.orient),
                isLeaf: inst.isLeaf,
                width: inst.width,
                height: inst.height,
                area: inst.width.wrapping_mul(inst.height),
                placedLL: pt(inst.placedBox.LL),
                placedUR: pt(inst.placedBox.UR),
                ..Default::default()
            };
            for p in &inst.blockPins {
                let mut temp_pin = Pin { pinName: p.name.clone(), netIter: p.netIter, ..Default::default() };
                for c in &p.pinContacts {
                    let mut temp_contact = contact::default();
                    if let Some(&m) = self.drc_info.Metalmap.get(&c.metal) {
                        temp_contact.metal = m;
                    }
                    AssignContact(&mut temp_contact, c);
                    temp_pin.pinContacts.push(temp_contact);
                }
                for v in &p.pinVias {
                    let mut temp_via = Via { model_index: v.model_index, position: pt(v.placedpos), ..Default::default() };
                    if let Some(&m) = self.drc_info.Viamap.get(&v.ViaRect.metal) {
                        temp_via.ViaRect.metal = m;
                    }
                    AssignContact(&mut temp_via.ViaRect, &v.ViaRect);
                    if let Some(&m) = self.drc_info.Metalmap.get(&v.LowerMetalRect.metal) {
                        temp_via.LowerMetalRect.metal = m;
                    }
                    AssignContact(&mut temp_via.LowerMetalRect, &v.LowerMetalRect);
                    if let Some(&m) = self.drc_info.Metalmap.get(&v.UpperMetalRect.metal) {
                        temp_via.UpperMetalRect.metal = m;
                    }
                    AssignContact(&mut temp_via.UpperMetalRect, &v.UpperMetalRect);
                    temp_pin.pinVias.push(temp_via);
                }
                temp_block.pins.push(temp_pin);
            }
            for m in &inst.interMetals {
                let mut temp_metal = contact::default();
                if let Some(&x) = self.drc_info.Metalmap.get(&m.metal) {
                    temp_metal.metal = x;
                }
                temp_metal.placedLL = pt(m.placedBox.LL);
                temp_metal.placedUR = pt(m.placedBox.UR);
                temp_metal.placedCenter = point::new(temp_metal.placedLL.x.wrapping_add(temp_metal.placedUR.x) / 2,
                                                     temp_metal.placedLL.y.wrapping_add(temp_metal.placedUR.y) / 2);
                temp_block.InternalMetal.push(temp_metal);
            }
            for v in &inst.interVias {
                let mut temp_via = Via { model_index: v.model_index, position: pt(v.placedpos), ..Default::default() };
                // 버릇 (:1208): Viamap.find 를 Metalmap.end() 와 견준다 — 늘 "찾음" 이라 없는 이름이 0 으로 들어간다
                temp_via.ViaRect.metal = *self.drc_info.Viamap.entry(v.ViaRect.metal.clone()).or_insert(0);
                AssignContact(&mut temp_via.ViaRect, &v.ViaRect);
                if let Some(&m) = self.drc_info.Metalmap.get(&v.LowerMetalRect.metal) {
                    temp_via.LowerMetalRect.metal = m;
                }
                AssignContact(&mut temp_via.LowerMetalRect, &v.LowerMetalRect);
                if let Some(&m) = self.drc_info.Metalmap.get(&v.UpperMetalRect.metal) {
                    temp_via.UpperMetalRect.metal = m;
                }
                AssignContact(&mut temp_via.UpperMetalRect, &v.UpperMetalRect);
                temp_block.InternalVia.push(temp_via);
            }
            self.Blocks.push(temp_block);
        }

        // 전원 넷 (상세 배선이 쓴다)
        for nit in &node.PowerNets {
            let mut temp_power_net = PowerNet { netName: nit.name.clone(), power: nit.power, ..Default::default() };
            for pit in &nit.Pins {
                let mut temp_pin = Pin { pinName: pit.name.clone(), netIter: pit.netIter, ..Default::default() };
                for cit in &pit.pinContacts {
                    let mut temp_contact = contact { metal: *self.drc_info.Metalmap.entry(cit.metal.clone()).or_insert(0), ..Default::default() };
                    AssignContact(&mut temp_contact, cit);
                    temp_pin.pinContacts.push(temp_contact);
                }
                for vit in &pit.pinVias {
                    let mut temp_via = Via { model_index: vit.model_index, ..Default::default() };
                    AssignContact(&mut temp_via.ViaRect, &vit.ViaRect);
                    AssignContact(&mut temp_via.LowerMetalRect, &vit.LowerMetalRect);
                    AssignContact(&mut temp_via.UpperMetalRect, &vit.UpperMetalRect);
                    temp_pin.pinVias.push(temp_via);
                }
                temp_power_net.pins.push(temp_pin);
            }
            for mit in &nit.path_metal {
                let mut temp_metal = Metal::default();
                CopyMetal(&mut temp_metal, mit);
                temp_power_net.path_metal.push(temp_metal);
            }
            for vit in &nit.path_via {
                let mut temp_via = Via { model_index: vit.model_index, ..Default::default() };
                AssignContact(&mut temp_via.ViaRect, &vit.ViaRect);
                AssignContact(&mut temp_via.LowerMetalRect, &vit.LowerMetalRect);
                AssignContact(&mut temp_via.UpperMetalRect, &vit.UpperMetalRect);
                temp_power_net.path_via.push(temp_via);
            }
            for net_name in &node.DoNotRoute {
                if *net_name == temp_power_net.netName {
                    temp_power_net.DoNotRoute = true;
                }
            }
            self.PowerNets.push(temp_power_net);
        }
        Ok(())
    }

    /// 넷마다 첫 단자 연결을 지우고 degree 를 하나 줄인다 (terminal_routing = 0). isTerminal 은 다시 매긴다.
    pub fn placeTerminals(&mut self) {
        for n in self.Nets.iter_mut() {
            n.isTerminal = false;
            let mj = n.connected.iter().position(|c| c.type_ == NType::TERMINAL);
            if let Some(mj) = mj {
                if !self.terminal_routing {
                    n.connected.remove(mj);
                    n.degree = n.degree.wrapping_sub(1);
                }
                n.isTerminal = true;
            }
        }
    }

    /// global_path 를 정하고, hierNode 에 칸 전체와 (이름이 같고 고른 후보가 있는 첫 넷의) 경로·칸 묶음을 쓴다
    pub fn ReturnHierNode(&mut self, HierNode: &mut HierNode) {
        for n in self.Nets.iter_mut() {
            if n.STindex >= 0 && (n.STindex as usize) < n.STs.len() {
                n.global_path = n.STs[n.STindex as usize].path.clone();
            }
        }
        HierNode.tiles_total = self.Gcell.tiles_total.iter().map(CopyTile).collect();
        for h in HierNode.Nets.iter_mut() {
            for n in &self.Nets {
                if h.name != n.netName {
                    continue;
                }
                if n.STindex < 0 || n.STindex as usize >= n.STs.len() {
                    continue;
                }
                h.GcellGlobalRouterPath = n.STs[n.STindex as usize].path.iter().map(|&(a, b)| [a, b]).collect();
                h.connectedTile = n.connectedTile.clone();
                break;
            }
        }
    }
}

pub fn AssignContact(RouterDB_contact: &mut contact, PnRDB_contact: &db::Contact) {
    RouterDB_contact.placedLL = pt(PnRDB_contact.placedBox.LL);
    RouterDB_contact.placedUR = pt(PnRDB_contact.placedBox.UR);
    RouterDB_contact.placedCenter = pt(PnRDB_contact.placedCenter);
    RouterDB_contact.originCenter = pt(PnRDB_contact.originCenter);
    RouterDB_contact.originLL = pt(PnRDB_contact.originBox.LL);
    RouterDB_contact.originUR = pt(PnRDB_contact.originBox.UR);
}

pub fn CopyMetal(RouterDB_metal: &mut Metal, PnRDB_metal: &db::Metal) {
    RouterDB_metal.MetalIdx = PnRDB_metal.MetalIdx;
    RouterDB_metal.width = PnRDB_metal.width;
    AssignContact(&mut RouterDB_metal.MetalRect, &PnRDB_metal.MetalRect);
    for p in &PnRDB_metal.LinePoint {
        RouterDB_metal.LinePoint.push(pt(*p));
    }
}

/// RouterDB::tile -> PnRDB::tile (origin_metal 은 옮기지 않는다)
pub fn CopyTile(it: &crate::rdb::tile) -> db::Tile {
    let e = |v: &[crate::rdb::tileEdge]| v.iter().map(|t| db::TileEdge { next: t.next, capacity: t.capacity }).collect();
    db::Tile {
        x: it.x,
        y: it.y,
        width: it.width,
        height: it.height,
        metal: it.metal.clone(),
        tileLayer: it.tileLayer,
        index: it.index,
        Yidx: it.Yidx,
        Xidx: it.Xidx,
        north: e(&it.north),
        south: e(&it.south),
        west: e(&it.west),
        east: e(&it.east),
        down: e(&it.down),
        up: e(&it.up),
    }
}
