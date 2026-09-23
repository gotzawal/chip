//! RouterDB — 배선기 안쪽 자료 (ALIGN `PlaceRouteHierFlow/router/Rdatatype.h`).
//!
//! 전역 배선(gr/), 상세 배선(dr/), 전원(pr/) 이 같이 쓴다. PnRDB(db.rs)에서 이리로 옮겨 담는 일
//! (getData / GetData)은 모드마다 조금씩 달라서 각 모듈이 한다. 이름과 기본값은 C++ 그대로 둔다
//! (C++ 에서 초기화하지 않는 필드는 0 으로 둔다 — 읽기 전에 늘 쓰이는 것들이다).
//!
//! 정렬 기준(…Comp)은 C++ 의 `operator()` 를 그대로 옮긴 "less" 함수다. `std::set<T, Comp>` 은
//! 이 less 로 Ord 를 만든 감싸개(아래 `by_*`)의 BTreeSet 으로 옮긴다 — 같은 원소(서로 less 가
//! 아닌 것)는 먼저 넣은 것이 남는 것까지 std::set 과 같다.
#![allow(non_snake_case, non_camel_case_types, dead_code)]

use std::cmp::Ordering;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct point {
    pub x: i32,
    pub y: i32,
}

impl point {
    pub fn new(x: i32, y: i32) -> Self {
        point { x, y }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct contact {
    pub metal: i32,
    pub originLL: point,
    pub originUR: point,
    pub placedLL: point,
    pub placedUR: point,
    pub originCenter: point,
    pub placedCenter: point,
}

impl Default for contact {
    fn default() -> Self {
        contact {
            metal: -1,
            originLL: point::default(),
            originUR: point::default(),
            placedLL: point::default(),
            placedUR: point::default(),
            originCenter: point::default(),
            placedCenter: point::default(),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct tileEdge {
    pub next: i32,
    pub capacity: i32,
}

/// `long width, height` 는 wasm32 에서 32 비트다 — i32 로 두고 넘침은 wrapping 으로 따라 한다.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct tile {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub metal: Vec<i32>,
    pub origin_metal: Vec<i32>,
    pub tileLayer: i32,
    pub index: i32,
    pub Yidx: i32,
    pub Xidx: i32,
    pub north: Vec<tileEdge>,
    pub south: Vec<tileEdge>,
    pub east: Vec<tileEdge>,
    pub west: Vec<tileEdge>,
    pub down: Vec<tileEdge>,
    pub up: Vec<tileEdge>,
}

impl Default for tile {
    fn default() -> Self {
        tile {
            x: -1,
            y: -1,
            width: 0,
            height: 0,
            metal: Vec::new(),
            origin_metal: Vec::new(),
            tileLayer: -1,
            index: -1,
            Yidx: -1,
            Xidx: -1,
            north: Vec::new(),
            south: Vec::new(),
            east: Vec::new(),
            west: Vec::new(),
            down: Vec::new(),
            up: Vec::new(),
        }
    }
}

/// 상세 격자의 꼭짓점 (Grid.cpp). `power` 는 C++ 에서 초기화하지 않는다.
#[derive(Clone, Debug, PartialEq)]
pub struct vertex {
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
    pub index: i32,
    pub gridmetal: Vec<i32>,
    pub expand: bool,
    pub north: Vec<i32>,
    pub south: Vec<i32>,
    pub east: Vec<i32>,
    pub west: Vec<i32>,
    pub down: i32,
    pub up: i32,
    pub power: i32,
    pub graph_index: i32,
}

impl Default for vertex {
    fn default() -> Self {
        vertex {
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
            index: -1,
            gridmetal: Vec::new(),
            expand: false,
            north: Vec::new(),
            south: Vec::new(),
            east: Vec::new(),
            west: Vec::new(),
            down: -1,
            up: -1,
            power: 0,
            graph_index: -1,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ViaModel {
    pub name: String,
    pub ViaIdx: i32,
    pub LowerIdx: i32,
    pub UpperIdx: i32,
    pub ViaRect: Vec<point>,
    pub LowerRect: Vec<point>,
    pub UpperRect: Vec<point>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Via {
    pub model_index: i32,
    pub position: point,
    pub UpperMetalRect: contact,
    pub LowerMetalRect: contact,
    pub ViaRect: contact,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Metal {
    pub MetalIdx: i32,
    pub LinePoint: Vec<point>,
    pub width: i32,
    pub MetalRect: contact,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SteinerTree {
    /// 칸 번호 쌍들 (그래프의 변)
    pub path: Vec<(i32, i32)>,
    pub valIdx: i32,
    pub sym_val_Idx: i32,
}

impl SteinerTree {
    pub fn new() -> Self {
        SteinerTree { path: Vec::new(), valIdx: 0, sym_val_Idx: -1 }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PowerGrid {
    pub name: String,
    pub metals: Vec<Metal>,
    pub vias: Vec<Via>,
    pub merged_metals: Vec<Metal>,
    pub power: bool,
}

impl Default for PowerGrid {
    fn default() -> Self {
        PowerGrid { name: String::new(), metals: Vec::new(), vias: Vec::new(), merged_metals: Vec::new(), power: true }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PowerNet {
    pub netName: String,
    pub power: bool,
    pub shielding: bool,
    pub pins: Vec<Pin>,
    pub path_metal: Vec<Metal>,
    pub path_via: Vec<Via>,
    pub extend_label: Vec<i32>,
    pub DoNotRoute: bool,
}

impl Default for PowerNet {
    fn default() -> Self {
        PowerNet {
            netName: String::new(),
            power: true,
            shielding: false,
            pins: Vec::new(),
            path_metal: Vec::new(),
            path_via: Vec::new(),
            extend_label: Vec::new(),
            DoNotRoute: false,
        }
    }
}

/// 핀 접점은 coord = [LL, UR], 단자는 [중심], 격자로 옮긴 것은 격자점들
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SinkData {
    pub coord: Vec<point>,
    pub metalIdx: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum NType {
    #[default]
    BLOCK,
    TERMINAL,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Omark {
    #[default]
    N,
    S,
    W,
    E,
    FN,
    FS,
    FW,
    FE,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct connectNode {
    pub type_: NType,
    pub iter: i32,
    pub iter2: i32,
}

/// RouterDB::Net. numSeg, sym_H, center 는 C++ 에서 초기화하지 않는다 (getData 가 쓴다).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Net {
    pub netName: String,
    pub degree: i32,
    pub isTerminal: bool,
    pub terminal_idx: i32,
    pub numSeg: i32,
    pub shielding: bool,
    pub sink2Terminal: bool,
    pub symCounterpart: i32,
    pub global_sym: i32,
    pub global_center: i32,
    pub sym_H: bool,
    pub center: i32,
    pub iter2SNetLsit: i32,
    pub connected: Vec<connectNode>,
    pub priority: String,
    pub path_metal: Vec<Metal>,
    pub extend_label: Vec<i32>,
    pub path_via: Vec<Via>,
    pub STs: Vec<SteinerTree>,
    pub global_path: Vec<(i32, i32)>,
    pub terminals: Vec<i32>,
    pub connectedTile: Vec<Vec<i32>>,
    pub STindex: i32,
    pub multi_connection: i32,
    pub DoNotRoute: bool,
    pub min_routing_layer: i32,
    pub max_routing_layer: i32,
    pub center_x: i32,
    pub center_y: i32,
}

impl Default for Net {
    fn default() -> Self {
        Net {
            netName: String::new(),
            degree: 0,
            isTerminal: false,
            terminal_idx: -1,
            numSeg: 0,
            shielding: false,
            sink2Terminal: false,
            symCounterpart: -1,
            global_sym: -1,
            global_center: -1,
            sym_H: false,
            center: 0,
            iter2SNetLsit: -1,
            connected: Vec::new(),
            priority: String::new(),
            path_metal: Vec::new(),
            extend_label: Vec::new(),
            path_via: Vec::new(),
            STs: Vec::new(),
            global_path: Vec::new(),
            terminals: Vec::new(),
            connectedTile: Vec::new(),
            STindex: 0,
            multi_connection: 1,
            DoNotRoute: false,
            min_routing_layer: -1,
            max_routing_layer: -1,
            center_x: 0,
            center_y: 0,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Pin {
    pub pinName: String,
    pub pinContacts: Vec<contact>,
    pub pinVias: Vec<Via>,
    pub netIter: i32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Block {
    pub blockName: String,
    pub blockMaster: String,
    pub numTerminals: i32,
    pub originLL: point,
    pub originUR: point,
    pub placedLL: point,
    pub placedUR: point,
    pub height: i32,
    pub width: i32,
    pub area: i32,
    pub orient: Omark,
    pub isLeaf: bool,
    pub pins: Vec<Pin>,
    pub InternalMetal: Vec<contact>,
    pub InternalVia: Vec<Via>,
    pub gdsfile: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct terminal {
    pub name: String,
    pub type_: String,
    pub netIter: i32,
    pub termContacts: Vec<contact>,
}

impl Default for terminal {
    fn default() -> Self {
        terminal { name: String::new(), type_: String::new(), netIter: -1, termContacts: Vec::new() }
    }
}

// ---------------------------------------------------------------- 정렬 기준 (C++ 의 less 그대로)

pub fn pointXYComp(l: &point, r: &point) -> bool {
    if l.x == r.x { l.y < r.y } else { l.x < r.x }
}

pub fn pointYXComp(l: &point, r: &point) -> bool {
    if l.y == r.y { l.x < r.x } else { l.y < r.y }
}

pub fn pointSetComp(l: &(i32, point), r: &(i32, point)) -> bool {
    if l.0 == r.0 {
        if l.1.x == r.1.x { l.1.y < r.1.y } else { l.1.x < r.1.x }
    } else {
        l.0 < r.0
    }
}

pub fn pointSetComp2(l: &(i32, point), r: &(i32, point)) -> bool {
    if l.1.y == r.1.y { l.1.x < r.1.x } else { l.1.y < r.1.y }
}

/// 칸 번호까지 키에 든다 — find 는 그 칸 자신만 찾는다 (전역 배선의 버릇)
pub fn tileComp(l: &tile, r: &tile) -> bool {
    if l.x == r.x {
        if l.y == r.y {
            if l.index == r.index { l.metal[0] < r.metal[0] } else { l.index < r.index }
        } else {
            l.y < r.y
        }
    } else {
        l.x < r.x
    }
}

/// C++ 의 오타(`lhs.coord.size() > 1 && lhs.coord.size() > 1`)까지 그대로. rhs 의 점이 하나뿐이면
/// C++ 은 rhs.coord[1] 을 범위 밖에서 읽는다 — 여기서는 그 경우를 부르는 쪽이 따로 처리해야 한다
/// (panic 한다). 모든 원소가 점 두 개면 (x0, y0, metal, x1, y1) 사전 순이다.
pub fn SinkDataComp(l: &SinkData, r: &SinkData) -> bool {
    if l.coord[0].x == r.coord[0].x {
        if l.coord[0].y == r.coord[0].y {
            if l.metalIdx == r.metalIdx {
                if l.coord.len() > 1 {
                    if l.coord[1].x == r.coord[1].x { l.coord[1].y < r.coord[1].y } else { l.coord[1].x < r.coord[1].x }
                } else {
                    l.coord[0].x < r.coord[0].x
                }
            } else {
                l.metalIdx < r.metalIdx
            }
        } else {
            l.coord[0].y < r.coord[0].y
        }
    } else {
        l.coord[0].x < r.coord[0].x
    }
}

pub fn SinkData2Comp(l: &SinkData, r: &SinkData) -> bool {
    if l.coord[0].y == r.coord[0].y {
        if l.coord[0].x == r.coord[0].x { l.metalIdx < r.metalIdx } else { l.coord[0].x < r.coord[0].x }
    } else {
        l.coord[0].y < r.coord[0].y
    }
}

pub fn ViaComp(l: &Via, r: &Via) -> bool {
    if l.model_index == r.model_index {
        if l.position.x == r.position.x { l.position.y < r.position.y } else { l.position.x < r.position.x }
    } else {
        l.model_index < r.model_index
    }
}

/// C++ 은 `lmetal.LinePoint[0].y == lmetal.LinePoint[0].y` 로 자기와 비교한다 (늘 참) — 그래서 키는
/// (MetalIdx, LP0.x, LP1.x, LP1.y) 이고 LP0.y 는 안 본다. 그대로 둔다.
pub fn MetalComp(l: &Metal, r: &Metal) -> bool {
    if l.MetalIdx == r.MetalIdx {
        if l.LinePoint[0].x == r.LinePoint[0].x {
            if l.LinePoint[1].x == r.LinePoint[1].x {
                l.LinePoint[1].y < r.LinePoint[1].y
            } else {
                l.LinePoint[1].x < r.LinePoint[1].x
            }
        } else {
            l.LinePoint[0].x < r.LinePoint[0].x
        }
    } else {
        l.MetalIdx < r.MetalIdx
    }
}

pub fn pairComp(l: &(i32, i32), r: &(i32, i32)) -> bool {
    if l.0 == r.0 { l.1 < r.1 } else { l.0 < r.0 }
}

pub fn pairCompDBL(l: &(f64, i32), r: &(f64, i32)) -> bool {
    if l.0 == r.0 { l.1 < r.1 } else { l.0 < r.0 }
}

/// less 함수로 Ord 를 만드는 감싸개 — `std::set<T, Comp>` 를 `BTreeSet<By<T>>` 로 옮길 때 쓴다.
/// less(a, b) 도 less(b, a) 도 아니면 같은 원소로 본다 (std::set 과 같다).
macro_rules! by_less {
    ($name:ident, $t:ty, $less:path) => {
        #[derive(Clone, Debug)]
        pub struct $name(pub $t);
        impl PartialEq for $name {
            fn eq(&self, o: &Self) -> bool {
                !$less(&self.0, &o.0) && !$less(&o.0, &self.0)
            }
        }
        impl Eq for $name {}
        impl PartialOrd for $name {
            fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
                Some(self.cmp(o))
            }
        }
        impl Ord for $name {
            fn cmp(&self, o: &Self) -> Ordering {
                if $less(&self.0, &o.0) {
                    Ordering::Less
                } else if $less(&o.0, &self.0) {
                    Ordering::Greater
                } else {
                    Ordering::Equal
                }
            }
        }
    };
}

by_less!(ByPointXY, point, pointXYComp);
by_less!(ByPointYX, point, pointYXComp);
by_less!(ByPointSet, (i32, point), pointSetComp);
by_less!(ByPointSet2, (i32, point), pointSetComp2);
by_less!(BySinkData, SinkData, SinkDataComp);
by_less!(BySinkData2, SinkData, SinkData2Comp);
by_less!(ByVia, Via, ViaComp);
by_less!(ByMetal, Metal, MetalComp);
by_less!(ByPairDBL, (f64, i32), pairCompDBL);
