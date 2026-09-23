//! RouteWork 2·3 — PowerRouter (전원 격자, 전원 배선). router/PowerRouter.cpp 와 거기서 닿는
//! Grid·Graph·A_star·GcellDetailRouter 도우미를 옮긴다.
//!
//!   모드 2  PowerRouter(node, drc, Lmetal, Hmetal, 1, h, v) — CreatePowerGrid          pg.rs
//!   모드 3  PowerRouter(node, drc, Lmetal, Hmetal, 0, h, v) — PowerNetRouter           pn.rs
//!
//! C++ 의 상속(RawRouter <- GcellGlobalRouter <- GcellDetailRouter <- PowerRouter)은 하나의
//! PowerRouter 로 모으고, GcellDetailRouter 의 도우미는 detail.rs 에 둔다 (모드 5 는 따로 옮긴다).
//! 격자·그래프·A* 는 grid.rs, graph.rs, astar.rs. 버릇(고치면 결과가 달라지는 것)은 그 자리에 적는다.
//!
//! 모드 2 가 만든 merged_metals 는 pybind 가 안 내보내서 node.Vdd/Gnd.merged_metals 로 모드 3 에 넘긴다.
#![allow(non_snake_case, non_camel_case_types)]

mod astar;
mod detail;
mod graph;
mod grid;
mod pg;
mod pn;
mod util;

use crate::db::{self, BBox, DrcInfo, HierNode};
use crate::rdb::{Block, Metal, Net, Pin, PowerGrid, PowerNet, Via, contact, point, terminal};

/// 층마다 격자점 목록 (C++ 의 `std::vector<std::vector<RouterDB::point>> plist`)
pub(crate) type Plist = Vec<Vec<point>>;

/// RouteWork 2: PowerRouter(node, drc, Lmetal, Hmetal, 1, h_skip, v_skip)
pub fn power_grid(node: &mut HierNode, drc: &DrcInfo, lmetal: i32, hmetal: i32, h_skip: i32, v_skip: i32) -> Result<(), String> {
    // 전원 넷이 없으면 아무것도 안 한다
    if node.PowerNets.is_empty() {
        return Ok(());
    }
    let mut pr = PowerRouter::default();
    pr.CreatePowerGrid(node, drc, lmetal, hmetal, h_skip, v_skip);
    let mut vdd = std::mem::take(&mut pr.Vdd_grid);
    pr.Physical_metal_via_power_grid(&mut vdd);
    vdd.name = "vdd".into();
    if let Some(p) = node.PowerNets.iter().find(|p| p.power) {
        vdd.name = p.name.clone();
    }
    pr.Vdd_grid = vdd;
    let mut gnd = std::mem::take(&mut pr.Gnd_grid);
    pr.Physical_metal_via_power_grid(&mut gnd);
    gnd.name = "vss".into();
    if let Some(p) = node.PowerNets.iter().find(|p| !p.power) {
        gnd.name = p.name.clone();
    }
    pr.Gnd_grid = gnd;
    pr.ReturnPowerGridData(node);
    Ok(())
}

/// RouteWork 3: PowerRouter(node, drc, Lmetal, Hmetal, 0, h_skip, v_skip)
pub fn power_route(node: &mut HierNode, drc: &DrcInfo, lmetal: i32, hmetal: i32, _h_skip: i32, _v_skip: i32) -> Result<(), String> {
    let mut pr = PowerRouter::default();
    pr.PowerNetRouter(node, drc, lmetal, hmetal)?;
    pr.Physical_metal_via();
    pr.ExtendMetal();
    pr.ReturnPowerNetData(node);
    Ok(())
}

/// PowerRouter 와 그 부모들(RawRouter, GcellDetailRouter)의 필드 가운데 쓰이는 것
#[derive(Default)]
pub(crate) struct PowerRouter {
    pub Nets: Vec<Net>,
    pub Blocks: Vec<Block>,
    pub Terminals: Vec<terminal>,
    pub PowerNets: Vec<PowerNet>,
    pub Vdd_grid: PowerGrid,
    pub Gnd_grid: PowerGrid,
    pub LL: point,
    pub UR: point,
    pub path_number: i32,
    pub drc_info: DrcInfo,
    pub cross_layer_drc_info: DrcInfo,
    pub lowest_metal: i32,
    pub highest_metal: i32,
    pub grid_scale: i32,
    pub isTop: bool,
    pub width: i32,
    pub height: i32,
    pub topName: String,
    pub layerNo: i32,
    pub PowerGrid_Drc_info: DrcInfo,
}

fn pt(p: &db::Point) -> point {
    point::new(p.x, p.y)
}

impl PowerRouter {
    // ------------------------------------------------------------ GetData (PowerRouter.cpp:1317-1685)

    /// PowerRouter::GetData — getDRCdata, getBlockData, getNetData, getTerminalData, getPowerGridData,
    /// getPowerNetData
    pub fn GetData(&mut self, node: &HierNode, drc: &DrcInfo, Lmetal: i32, Hmetal: i32) {
        // GcellGlobalRouter::getDRCdata
        self.drc_info = drc.clone();
        self.cross_layer_drc_info = drc.clone();
        self.getBlockData(node, Lmetal, Hmetal);
        self.getNetData(node);
        self.getTerminalData(node);
        self.getPowerGridData(node);
        self.getPowerNetData(node);
    }

    fn getBlockData(&mut self, node: &HierNode, Lmetal: i32, Hmetal: i32) {
        self.isTop = node.isTop;
        self.topName = node.name.clone();
        self.width = node.width;
        self.height = node.height;
        self.LL = pt(&node.LL);
        self.UR = pt(&node.UR);
        self.path_number = 1;
        self.lowest_metal = Lmetal;
        self.highest_metal = Hmetal;
        self.layerNo = self.drc_info.Metal_info.len() as i32;
        self.grid_scale = 1;
        for bc in &node.Blocks {
            let b = &bc.instance[bc.selectedInstance as usize];
            let temp_block = Block {
                blockName: b.name.clone(),
                blockMaster: b.master.clone(),
                gdsfile: b.gdsFile.clone(),
                numTerminals: b.blockPins.len() as i32,
                isLeaf: b.isLeaf,
                width: b.width,
                height: b.height,
                area: b.width.wrapping_mul(b.height),
                placedLL: pt(&b.placedBox.LL),
                placedUR: pt(&b.placedBox.UR),
                pins: b.blockPins.iter().map(|p| self.ConvertPin(p)).collect(),
                InternalMetal: b.interMetals.iter().map(|c| self.ConvertContact(c)).collect(),
                InternalVia: b.interVias.iter().map(|v| self.ConvertVia(v)).collect(),
                ..Block::default()
            };
            self.Blocks.push(temp_block);
        }
    }

    fn getNetData(&mut self, node: &HierNode) {
        for n in &node.Nets {
            let temp_net = Net {
                netName: n.name.clone(),
                path_metal: n.path_metal.iter().map(|m| self.ConvertMetal(m)).collect(),
                path_via: n.path_via.iter().map(|v| self.ConvertVia(v)).collect(),
                ..Net::default()
            };
            self.Nets.push(temp_net);
        }
    }

    fn getPowerGridData(&mut self, node: &HierNode) {
        // Gnd_grid.power 도 1 이다 (C++ 그대로, 쓰이지 않는다)
        let conv = |g: &db::PowerGrid| PowerGrid {
            name: String::new(),
            metals: g.metals.iter().map(|m| self.ConvertMetal(m)).collect(),
            merged_metals: g.merged_metals.iter().map(|m| self.ConvertMetal(m)).collect(),
            vias: g.vias.iter().map(|v| self.ConvertVia(v)).collect(),
            power: true,
        };
        let (vdd, gnd) = (conv(&node.Vdd), conv(&node.Gnd));
        self.Vdd_grid = vdd;
        self.Gnd_grid = gnd;
    }

    fn getTerminalData(&mut self, node: &HierNode) {
        for t in &node.Terminals {
            let temp_terminal = terminal {
                name: t.name.clone(),
                type_: t.type_.clone(),
                netIter: t.netIter,
                termContacts: t.termContacts.iter().map(|c| self.ConvertContact(c)).collect(),
            };
            self.Terminals.push(temp_terminal);
        }
    }

    fn getPowerNetData(&mut self, node: &HierNode) {
        for p in &node.PowerNets {
            let temp_net = PowerNet {
                netName: p.name.clone(),
                power: p.power,
                path_metal: p.path_metal.iter().map(|m| self.ConvertMetal(m)).collect(),
                path_via: p.path_via.iter().map(|v| self.ConvertVia(v)).collect(),
                pins: p.Pins.iter().map(|x| self.ConvertPin(x)).collect(),
                DoNotRoute: node.DoNotRoute.contains(&p.name),
                ..PowerNet::default()
            };
            self.PowerNets.push(temp_net);
        }
    }

    fn metal_of(&self, name: &str) -> i32 {
        // 없으면 contact 의 기본값 -1 (Power Router-Error 를 남기고 넘어간다)
        self.drc_info.Metalmap.get(name).copied().unwrap_or(-1)
    }

    /// PowerRouter::ConvertContact — 중심은 사각형에서 다시 구한다
    fn ConvertContact(&self, c: &db::Contact) -> contact {
        let placedLL = pt(&c.placedBox.LL);
        let placedUR = pt(&c.placedBox.UR);
        contact {
            metal: self.metal_of(&c.metal),
            placedLL,
            placedUR,
            placedCenter: point::new((placedLL.x + placedUR.x) / 2, (placedLL.y + placedUR.y) / 2),
            ..contact::default()
        }
    }

    /// 핀 접점·금속·비아 사각형: 중심은 PnRDB 의 것을 그대로
    fn contact_placed(&self, c: &db::Contact, metal: i32) -> contact {
        contact { metal, placedLL: pt(&c.placedBox.LL), placedUR: pt(&c.placedBox.UR), placedCenter: pt(&c.placedCenter), ..contact::default() }
    }

    /// PowerRouter::ConvertMetal — LinePoint 가 둘 모자라면 C++ 은 범위 밖을 읽는다 (여기서는 (0, 0))
    fn ConvertMetal(&self, m: &db::Metal) -> Metal {
        let lp = |i: usize| m.LinePoint.get(i).map(pt).unwrap_or_default();
        Metal {
            MetalIdx: m.MetalIdx,
            LinePoint: vec![lp(0), lp(1)],
            width: m.width,
            MetalRect: self.contact_placed(&m.MetalRect, self.metal_of(&m.MetalRect.metal)),
        }
    }

    /// PowerRouter::ConvertVia
    fn ConvertVia(&self, v: &db::Via) -> Via {
        Via {
            model_index: v.model_index,
            position: pt(&v.placedpos),
            ViaRect: self.contact_placed(&v.ViaRect, self.drc_info.Viamap.get(&v.ViaRect.metal).copied().unwrap_or(-1)),
            LowerMetalRect: self.contact_placed(&v.LowerMetalRect, self.metal_of(&v.LowerMetalRect.metal)),
            UpperMetalRect: self.contact_placed(&v.UpperMetalRect, self.metal_of(&v.UpperMetalRect.metal)),
        }
    }

    /// PowerRouter::ConvertPin
    fn ConvertPin(&self, p: &db::Pin) -> Pin {
        Pin {
            pinName: p.name.clone(),
            netIter: p.netIter,
            pinContacts: p.pinContacts.iter().map(|c| self.contact_placed(c, self.metal_of(&c.metal))).collect(),
            pinVias: p.pinVias.iter().map(|v| self.ConvertVia(v)).collect(),
        }
    }

    // ------------------------------------------------------------ PnRDB 로 (GcellDetailRouter.cpp:4852-4984)

    fn metal_name(&self, m: i32) -> String {
        self.drc_info.Metal_info.get(m as usize).map(|mi| mi.name.clone()).unwrap_or_default()
    }

    /// GcellDetailRouter::ConvertToContactPnRDB_Placed_Placed — 층이 음수면 0 (M1) 으로
    fn ConvertToContactPnRDB_Placed_Placed(&self, c: &contact) -> db::Contact {
        let metal = if c.metal < 0 { 0 } else { c.metal };
        db::Contact {
            metal: self.metal_name(metal),
            placedBox: BBox { LL: db::Point { x: c.placedLL.x, y: c.placedLL.y }, UR: db::Point { x: c.placedUR.x, y: c.placedUR.y } },
            placedCenter: db::Point { x: c.placedCenter.x, y: c.placedCenter.y },
            ..db::Contact::default()
        }
    }

    /// PowerRouter::ConvertToMetalPnRDB_Placed_Placed
    fn ConvertToMetalPnRDB_Placed_Placed(&self, m: &Metal) -> db::Metal {
        db::Metal {
            MetalIdx: m.MetalIdx,
            width: m.width,
            LinePoint: m.LinePoint.iter().map(|p| db::Point { x: p.x, y: p.y }).collect(),
            MetalRect: self.ConvertToContactPnRDB_Placed_Placed(&m.MetalRect),
        }
    }

    /// GcellDetailRouter::ConvertToViaPnRDB_Placed_Placed — ViaRect 이름은 Via_info 에서
    fn ConvertToViaPnRDB_Placed_Placed(&self, v: &Via) -> db::Via {
        let rect = |c: &contact, name: String| db::Contact {
            metal: name,
            placedBox: BBox { LL: db::Point { x: c.placedLL.x, y: c.placedLL.y }, UR: db::Point { x: c.placedUR.x, y: c.placedUR.y } },
            placedCenter: db::Point { x: c.placedCenter.x, y: c.placedCenter.y },
            ..db::Contact::default()
        };
        let via_name = self.drc_info.Via_info.get(v.ViaRect.metal as usize).map(|vi| vi.name.clone()).unwrap_or_default();
        db::Via {
            model_index: v.model_index,
            placedpos: db::Point { x: v.position.x, y: v.position.y },
            ViaRect: rect(&v.ViaRect, via_name),
            LowerMetalRect: rect(&v.LowerMetalRect, self.metal_name(v.LowerMetalRect.metal)),
            UpperMetalRect: rect(&v.UpperMetalRect, self.metal_name(v.UpperMetalRect.metal)),
            ..db::Via::default()
        }
    }

    /// PowerRouter::UpdateVia (PowerRouter.cpp:1004-1026) — 비아 모형으로 세 사각형을 채운다
    fn UpdateVia(&self, v: &mut Via) {
        let vm = &self.drc_info.Via_model[v.model_index as usize];
        let at = |r: &[db::Point], k: usize| r.get(k).map(|p| point::new(p.x + v.position.x, p.y + v.position.y)).unwrap_or(v.position);
        v.ViaRect = contact { metal: v.model_index, placedCenter: v.position, placedLL: at(&vm.ViaRect, 0), placedUR: at(&vm.ViaRect, 1), ..v.ViaRect };
        v.LowerMetalRect =
            contact { metal: vm.LowerIdx, placedCenter: v.position, placedLL: at(&vm.LowerRect, 0), placedUR: at(&vm.LowerRect, 1), ..v.LowerMetalRect };
        v.UpperMetalRect =
            contact { metal: vm.UpperIdx, placedCenter: v.position, placedLL: at(&vm.UpperRect, 0), placedUR: at(&vm.UpperRect, 1), ..v.UpperMetalRect };
    }
}
