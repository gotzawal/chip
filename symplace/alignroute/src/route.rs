//! 모듈 하나의 배선 — `align/pnr/router.py` 의 route_single_variant 에서 RouteWork 를 부르는 순서.
//!
//!   RouteWork 4  GcellGlobalRouter(node, drc, Lmetal, Hmetal)          전역 배선      gr/
//!   RouteWork 5  GcellDetailRouter(node, GGR, 1, 1)                     상세 배선      dr/
//!   RouteWork 2  PowerRouter(node, drc, Lmetal, Hmetal, 1, h, v)        전원 격자      pr/  (최상위만)
//!   RouteWork 3  PowerRouter(node, drc, Lmetal, Hmetal, 0, h, v)        전원 배선      pr/  (최상위만)
//!
//! 모드마다 배선기가 hierNode 에 쓴 필드를 "기록" 으로 돌려준다. JS 쪽이 그것을 노드에 합친다
//! (src/route/align/bottomup.mjs 의 applyRecord).
use crate::db::{DrcInfo, HierNode, Job};
use serde::Serialize;
use serde_json::{json, Value};
use std::cell::RefCell;

thread_local! {
    static WARNINGS: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

/// ALIGN 이 spdlog 로 남기는 경고 가운데 결과를 읽는 데 필요한 것 (길 못 찾음 등)
pub fn warn(msg: impl Into<String>) {
    WARNINGS.with(|w| w.borrow_mut().push(msg.into()));
}

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "alignroute")]
unsafe extern "C" {
    fn now_ms() -> f64;
}

fn clock() -> f64 {
    #[cfg(target_arch = "wasm32")]
    {
        unsafe { now_ms() }
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
    }
}

#[derive(Serialize)]
pub struct Record {
    pub module: String,
    pub mode: i32,
    pub ms: f64,
    pub out: Value,
}

#[derive(Serialize)]
pub struct Output {
    pub records: Vec<Record>,
    pub warnings: Vec<String>,
}

/// 배선기가 모드 m 에서 hierNode 에 쓰는 필드
pub fn record(node: &HierNode, mode: i32) -> Value {
    match mode {
        4 => json!({
            "tiles_total": node.tiles_total,
            "Nets": node.Nets.iter().map(|n| json!({
                "name": n.name, "GcellGlobalRouterPath": n.GcellGlobalRouterPath, "connectedTile": n.connectedTile,
            })).collect::<Vec<_>>(),
        }),
        5 => json!({
            "Nets": node.Nets.iter().map(|n| json!({
                "name": n.name, "path_metal": n.path_metal, "path_via": n.path_via,
            })).collect::<Vec<_>>(),
            "blockPins": node.blockPins,
            "interMetals": node.interMetals,
            "interVias": node.interVias,
            "Terminals": node.Terminals.iter().map(|t| json!({
                "name": t.name, "termContacts": t.termContacts,
            })).collect::<Vec<_>>(),
        }),
        2 => json!({
            "Vdd": { "name": node.Vdd.name, "metals": node.Vdd.metals, "vias": node.Vdd.vias },
            "Gnd": { "name": node.Gnd.name, "metals": node.Gnd.metals, "vias": node.Gnd.vias },
        }),
        3 => json!({
            "PowerNets": node.PowerNets.iter().map(|p| json!({
                "name": p.name, "path_metal": p.path_metal, "path_via": p.path_via,
            })).collect::<Vec<_>>(),
            "LL": node.LL, "UR": node.UR, "width": node.width, "height": node.height,
        }),
        _ => Value::Null,
    }
}

pub fn run(job: Job) -> Result<Output, String> {
    WARNINGS.with(|w| w.borrow_mut().clear());
    let Job { drc, mut node, modes, signal, powerGrid, powerRouting, skip, echo } = job;
    let mut records = Vec::new();
    for &m in &echo {
        records.push(Record { module: node.name.clone(), mode: m, ms: 0.0, out: record(&node, m) });
    }
    let mut ggr: Option<crate::gr::GcellGlobalRouter> = None;
    for &m in &modes {
        let t0 = clock();
        step(&mut node, &drc, m, &mut ggr, signal, powerGrid, powerRouting, skip)?;
        records.push(Record { module: node.name.clone(), mode: m, ms: clock() - t0, out: record(&node, m) });
    }
    let warnings = WARNINGS.with(|w| std::mem::take(&mut *w.borrow_mut()));
    Ok(Output { records, warnings })
}

#[allow(clippy::too_many_arguments)]
fn step(node: &mut HierNode, drc: &DrcInfo, mode: i32, ggr: &mut Option<crate::gr::GcellGlobalRouter>,
        signal: [i32; 2], power_grid: [i32; 2], power_routing: [i32; 2], skip: [i32; 2]) -> Result<(), String> {
    match mode {
        4 => {
            *ggr = Some(crate::gr::GcellGlobalRouter::new(node, drc, signal[0], signal[1])?);
            Ok(())
        }
        5 => {
            let g = ggr.as_ref().ok_or("모드 5 는 같은 호출 안에서 모드 4 를 먼저 돌려야 한다")?;
            crate::dr::route(node, g)
        }
        2 => crate::pr::power_grid(node, drc, power_grid[0], power_grid[1], skip[0], skip[1]),
        3 => crate::pr::power_route(node, drc, power_routing[0], power_routing[1], skip[0], skip[1]),
        _ => Err(format!("RouteWork 모드 {mode} 는 옮기지 않았다 (4, 5, 2, 3 만)")),
    }
}

/// JSON 일감 -> JSON 결과. 오류는 {"error": ...} 로.
pub fn run_json(input: &[u8]) -> Vec<u8> {
    let out = match serde_json::from_slice::<Job>(input) {
        Err(e) => Err(format!("일감 JSON 을 못 읽었다: {e}")),
        Ok(job) => run(job),
    };
    match out {
        Ok(o) => serde_json::to_vec(&o).unwrap_or_else(|e| format!("{{\"error\":\"결과를 못 썼다: {e}\"}}").into_bytes()),
        Err(msg) => serde_json::to_vec(&json!({ "error": msg })).unwrap(),
    }
}
