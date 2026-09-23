//! RouteWork 2·3 — PowerRouter (전원 격자, 전원 배선). router/PowerRouter.cpp 와 거기서 닿는
//! Grid·Graph·A_star·GcellDetailRouter 도우미를 옮긴다.
use crate::db::{DrcInfo, HierNode};

/// RouteWork 2: PowerRouter(node, drc, Lmetal, Hmetal, 1, h_skip, v_skip)
pub fn power_grid(_node: &mut HierNode, _drc: &DrcInfo, _lmetal: i32, _hmetal: i32, _h_skip: i32, _v_skip: i32) -> Result<(), String> {
    Err("모드 2 (전원 격자) 는 아직 옮기지 않았다".into())
}

/// RouteWork 3: PowerRouter(node, drc, Lmetal, Hmetal, 0, h_skip, v_skip)
pub fn power_route(_node: &mut HierNode, _drc: &DrcInfo, _lmetal: i32, _hmetal: i32, _h_skip: i32, _v_skip: i32) -> Result<(), String> {
    Err("모드 3 (전원 배선) 는 아직 옮기지 않았다".into())
}
