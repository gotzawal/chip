//! RouteWork 4 — GcellGlobalRouter (전역 배선). router/GcellGlobalRouter.cpp, GlobalGrid.cpp,
//! GlobalGraph.cpp 를 옮긴다. ILP 는 lp_solve 그대로 (crate::lp).
use crate::db::{DrcInfo, HierNode};

/// 모드 5 (상세 배선) 가 읽는 전역 배선 상태
pub struct GcellGlobalRouter {}

impl GcellGlobalRouter {
    pub fn new(_node: &mut HierNode, _drc: &DrcInfo, _lmetal: i32, _hmetal: i32) -> Result<Self, String> {
        Err("모드 4 (전역 배선) 는 아직 옮기지 않았다".into())
    }
}
