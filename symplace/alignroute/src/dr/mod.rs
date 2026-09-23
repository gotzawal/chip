//! RouteWork 5 — GcellDetailRouter(node, GGR, 1, 1) (상세 배선). router/GcellDetailRouter.cpp,
//! Grid.cpp, A_star.cpp 를 옮긴다.
use crate::db::HierNode;
use crate::gr::GcellGlobalRouter;

pub fn route(_node: &mut HierNode, _gr: &GcellGlobalRouter) -> Result<(), String> {
    Err("모드 5 (상세 배선) 는 아직 옮기지 않았다".into())
}
