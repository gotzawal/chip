//! PnRDB 의 자료 — ALIGN `PlaceRouteHierFlow/PnRDB/datatype.h` 에서 배선기가 읽고 쓰는 것만.
//!
//! 필드 이름과 JSON 모양은 pybind 바인딩을 그대로 걸어 뜬 덤프(`scripts/route/align-ref/tap`)와 같다.
//! 그래서 기준 덤프를 그대로 읽어 배선하고, 결과를 그대로 견준다. C++ 의 이름을 그대로 두어
//! 옮긴 코드가 원문과 줄 단위로 맞아 보이게 한다 (`node.Blocks[i].instance[sel].blockPins`).
//! 열거형은 덤프처럼 문자열로 둔다 ("NType.Block", "Smark.V", "Omark.N").
#![allow(non_snake_case)]

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct BBox {
    pub LL: Point,
    pub UR: Point,
}

/// PnRDB::contact — 층 이름과 사각형 (배치 전 origin*, 배치 뒤 placed*)
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Contact {
    pub metal: String,
    pub originBox: BBox,
    pub originCenter: Point,
    pub placedBox: BBox,
    pub placedCenter: Point,
}

/// PnRDB::Via
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Via {
    pub model_index: i32,
    pub originpos: Point,
    pub placedpos: Point,
    pub UpperMetalRect: Contact,
    pub LowerMetalRect: Contact,
    pub ViaRect: Contact,
}

/// PnRDB::pin
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Pin {
    pub name: String,
    #[serde(rename = "type")]
    pub type_: String,
    #[serde(rename = "use")]
    pub use_: String,
    pub netIter: i32,
    pub pinContacts: Vec<Contact>,
    pub pinVias: Vec<Via>,
}

/// PnRDB::Metal — 배선 한 토막 (LinePoint 두 점 + 폭)
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Metal {
    pub MetalIdx: i32,
    pub LinePoint: Vec<Point>,
    pub width: i32,
    pub MetalRect: Contact,
}

/// PnRDB::connectNode — type 은 "NType.Block" | "NType.Terminal"
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ConnectNode {
    #[serde(rename = "type")]
    pub type_: String,
    pub iter: i32,
    pub iter2: i32,
}

impl ConnectNode {
    pub fn is_block(&self) -> bool {
        self.type_ == "NType.Block"
    }
    pub fn is_terminal(&self) -> bool {
        self.type_ == "NType.Terminal"
    }
}

fn one() -> i32 {
    1
}

/// PnRDB::net
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Net {
    pub name: String,
    pub shielding: bool,
    pub sink2Terminal: bool,
    pub degree: i32,
    pub symCounterpart: i32,
    pub iter2SNetLsit: i32,
    pub connected: Vec<ConnectNode>,
    pub priority: String,
    /// "Smark.V" | "Smark.H"
    pub axis_dir: String,
    pub axis_coor: i32,
    pub path_metal: Vec<Metal>,
    pub path_via: Vec<Via>,
    pub interVias: Vec<Via>,
    pub segments: Vec<serde_json::Value>,
    pub GcellGlobalRouterPath: Vec<[i32; 2]>,
    pub connectedTile: Vec<Vec<i32>>,
    /// pybind 가 안 내보낸다 (MultiConnection 제약). 없으면 1.
    #[serde(default = "one")]
    pub multi_connection: i32,
}

/// PnRDB::terminal
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Terminal {
    pub name: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub netIter: i32,
    pub termContacts: Vec<Contact>,
}

/// PnRDB::block — 블록의 한 변이 (배선기는 selectedInstance 만 본다)
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Block {
    pub name: String,
    pub master: String,
    pub lefmaster: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub width: i32,
    pub height: i32,
    pub isLeaf: bool,
    pub originBox: BBox,
    pub originCenter: Point,
    pub gdsFile: String,
    /// "Omark.N" 등
    pub orient: String,
    pub placedBox: BBox,
    pub placedCenter: Point,
    pub blockPins: Vec<Pin>,
    pub interMetals: Vec<Contact>,
    pub interVias: Vec<Via>,
    pub dummy_power_pin: Vec<Pin>,
}

/// PnRDB::blockComplex
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct BlockComplex {
    pub instance: Vec<Block>,
    pub selectedInstance: i32,
    pub child: i32,
    pub instNum: i32,
}

/// PnRDB::PowerNet
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct PowerNet {
    pub name: String,
    pub power: bool,
    pub Pins: Vec<Pin>,
    pub connected: Vec<ConnectNode>,
    pub dummy_connected: Vec<ConnectNode>,
    pub path_metal: Vec<Metal>,
    pub path_via: Vec<Via>,
}

/// PnRDB::PowerGrid. merged_metals 는 pybind 가 안 내보낸다 — 모드 2 가 만들어 모드 3 이 읽는다
/// (한 번의 호출 안에서 넘긴다). 덤프와 견줄 때는 빼고 쓴다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct PowerGrid {
    pub name: String,
    pub metals: Vec<Metal>,
    pub vias: Vec<Via>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub merged_metals: Vec<Metal>,
}

/// PnRDB::tileEdge
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct TileEdge {
    pub next: i32,
    pub capacity: i32,
}

/// PnRDB::tile — 전역 배선의 칸 (모드 4 가 hierNode.tiles_total 에 쓴다)
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Tile {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub Xidx: i32,
    pub Yidx: i32,
    pub index: i32,
    pub tileLayer: i32,
    pub metal: Vec<i32>,
    pub north: Vec<TileEdge>,
    pub south: Vec<TileEdge>,
    pub east: Vec<TileEdge>,
    pub west: Vec<TileEdge>,
    pub up: Vec<TileEdge>,
    pub down: Vec<TileEdge>,
}

/// PnRDB::Routing_Per_Net (Route 제약의 넷별 층)
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct RoutingPerNet {
    pub net_name: String,
    pub net_min_layer: String,
    pub net_max_layer: String,
}

/// PnRDB::Routing_Layers (Route 제약). 층 이름이 비면 "정하지 않음".
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct RoutingLayers {
    pub global_min_layer: String,
    pub global_max_layer: String,
    pub Routing_per_Net: Vec<RoutingPerNet>,
}

/// PnRDB::Multi_Connection (MultiConnection 제약)
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct MultiConnection {
    pub net_name: String,
    pub multi_number: i32,
}

/// PnRDB::hierNode — 배선기가 읽고 쓰는 필드만
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct HierNode {
    pub name: String,
    pub isTop: bool,
    pub isIntelGcellGlobalRouter: bool,
    pub n_copy: i32,
    pub width: i32,
    pub height: i32,
    pub LL: Point,
    pub UR: Point,
    pub Blocks: Vec<BlockComplex>,
    pub Nets: Vec<Net>,
    pub Terminals: Vec<Terminal>,
    pub PowerNets: Vec<PowerNet>,
    pub Vdd: PowerGrid,
    pub Gnd: PowerGrid,
    pub blockPins: Vec<Pin>,
    pub interMetals: Vec<Contact>,
    pub interVias: Vec<Via>,
    pub tiles_total: Vec<Tile>,
    /// 아래 셋은 pybind 가 안 내보낸다 (제약에서 온다). 덤프에는 없고 기본값이 곧 ALIGN 의 값이다.
    pub DoNotRoute: Vec<String>,
    pub Routing_Layers: RoutingLayers,
    pub Multi_connections: Vec<MultiConnection>,
}

/// PnRDB::metal_info
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MetalInfo {
    pub name: String,
    pub layerNo: i32,
    pub width: i32,
    pub dist_ss: i32,
    /// 0 = 세로(V), 1 = 가로(H)
    pub direct: i32,
    pub grid_unit_x: i32,
    pub grid_unit_y: i32,
    pub minL: i32,
    pub maxL: i32,
    pub dist_ee: i32,
    pub offset: i32,
    pub unit_R: f64,
    pub unit_C: f64,
    pub unit_CC: f64,
    pub lower_via_index: i32,
    pub upper_via_index: i32,
}

/// PnRDB::via_info
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ViaInfo {
    pub name: String,
    pub layerNo: i32,
    pub lower_metal_index: i32,
    pub upper_metal_index: i32,
    pub width: i32,
    pub width_y: i32,
    pub cover_l: i32,
    pub cover_l_P: i32,
    pub cover_u: i32,
    pub cover_u_P: i32,
    pub dist_ss: i32,
    pub dist_ss_y: i32,
    pub R: f64,
}

/// PnRDB::ViaModel — 사각형은 비아 중심에서 [왼아래, 오른위]
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ViaModel {
    pub name: String,
    pub ViaIdx: i32,
    pub LowerIdx: i32,
    pub UpperIdx: i32,
    pub ViaRect: Vec<Point>,
    pub LowerRect: Vec<Point>,
    pub UpperRect: Vec<Point>,
    pub R: f64,
}

/// PnRDB::design_info
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct DesignInfo {
    pub Hspace: i32,
    pub Vspace: i32,
    pub signal_routing_metal_l: i32,
    pub signal_routing_metal_u: i32,
    pub power_grid_metal_l: i32,
    pub power_grid_metal_u: i32,
    pub power_routing_metal_l: i32,
    pub power_routing_metal_u: i32,
    pub h_skip_factor: i32,
    pub v_skip_factor: i32,
    pub compact_style: String,
}

/// PnRDB::Drc_info
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct DrcInfo {
    pub MaxLayer: i32,
    pub Metalmap: BTreeMap<String, i32>,
    pub Viamap: BTreeMap<String, i32>,
    pub Metal_info: Vec<MetalInfo>,
    pub Via_info: Vec<ViaInfo>,
    pub Via_model: Vec<ViaModel>,
    pub metal_weight: Vec<f64>,
    pub Design_info: DesignInfo,
}

/// 배선 한 번의 일감 — 모듈 하나. JS(src/route/align/)가 만들고, 기준 덤프에서도 만든다.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct Job {
    pub drc: DrcInfo,
    pub node: HierNode,
    /// RouteWork 모드를 이 순서로: 보통 [4, 5] (하위 모듈), [4, 5, 2, 3] (최상위)
    pub modes: Vec<i32>,
    /// 모드 4·5 의 Lmetal/Hmetal (Route 제약을 반영한 뒤)
    pub signal: [i32; 2],
    /// 모드 2 의 Lmetal/Hmetal (Design_info.power_grid_metal_l/u)
    pub powerGrid: [i32; 2],
    /// 모드 3 의 Lmetal/Hmetal (Design_info.power_routing_metal_l/u)
    pub powerRouting: [i32; 2],
    /// h_skip_factor, v_skip_factor
    pub skip: [i32; 2],
    /// 시험용: 배선하지 않고 입력 hierNode 에서 이 모드들의 기록만 뽑아 돌려준다 (자료형 왕복 확인)
    pub echo: Vec<i32>,
}
