//! Graph(grid, power_grid) — 전원 격자 만들기 (router/Graph.cpp:14-22, 80-435).
//!
//! 극성마다 가장 큰 연결 덩이만 남기고(재귀 DFS 의 부풀려진 호출 수로 센다), 이웃 꼭짓점 사이
//! 토막마다 금속, 같은 극성끼리 만나는 곳에 비아를 둔다.
use super::grid::Grid;
use crate::rdb::{ByMetal, ByVia, Metal, PowerGrid, Via, contact, point};
use std::collections::BTreeSet;

/// Graph::Graph(grid, true) -> (GetVdd_grid(), GetGnd_grid())
pub fn CreatePower_Grid(grid: &mut Grid) -> (PowerGrid, PowerGrid) {
    let mut VddPower_Set: BTreeSet<ByMetal> = BTreeSet::new();
    let mut GndPower_Set: BTreeSet<ByMetal> = BTreeSet::new();
    let mut VddVia_Set: BTreeSet<ByVia> = BTreeSet::new();
    let mut GndVia_Set: BTreeSet<ByVia> = BTreeSet::new();
    let mut VddPower_metal: Vec<Metal> = Vec::new();
    let mut GndPower_metal: Vec<Metal> = Vec::new();

    Connection_Check_Power_Grid(grid, 1);
    Connection_Check_Power_Grid(grid, 0);

    let n = grid.vertices_graph.len();
    for i in 0..n {
        if !grid.vertices_graph[i].active {
            continue;
        }
        let vi = grid.vertices_graph[i].clone();
        let MetalIdx = vi.metal;
        let width = grid.drc_info.Metal_info[vi.metal as usize].width;
        let LL_point = point::new(vi.x, vi.y);
        // collect_vdd_gnd: north, south, east, west
        for t in [vi.north, vi.south, vi.east, vi.west] {
            if t < 0 {
                continue;
            }
            let Some(g) = grid.t2g(t) else { continue };
            let vg = &grid.vertices_graph[g];
            let UR_point = point::new(vg.x, vg.y);
            // adjust_line: 두 점을 x 가 같으면 y 순, 아니면 x 순으로
            let pts = if LL_point.x == UR_point.x {
                if LL_point.y <= UR_point.y { vec![LL_point, UR_point] } else { vec![UR_point, LL_point] }
            } else if LL_point.x <= UR_point.x {
                vec![LL_point, UR_point]
            } else {
                vec![UR_point, LL_point]
            };
            let temp_metal = Metal { MetalIdx, LinePoint: pts, width, MetalRect: contact::default() };
            if vg.active && vi.power == 1 && vg.power == 1 {
                VddPower_Set.insert(ByMetal(temp_metal.clone()));
                VddPower_metal.push(temp_metal.clone());
            }
            if vg.active && vi.power == 0 && vg.power == 0 {
                GndPower_Set.insert(ByMetal(temp_metal.clone()));
                GndPower_metal.push(temp_metal);
            }
        }
        // collect_vdd_gnd_via: down, up
        for t in [vi.down, vi.up] {
            if t == -1 {
                continue;
            }
            let Some(g) = grid.t2g(t) else { continue };
            let vg = &grid.vertices_graph[g];
            let model_index = if vi.metal < vg.metal { vi.metal } else { vg.metal };
            let temp_via = Via { model_index, position: LL_point, ..Via::default() };
            if vg.active && vi.power == 1 && vg.power == 1 && CheckActive(grid, g) && CheckActive(grid, i) {
                VddVia_Set.insert(ByVia(temp_via));
            }
            if vg.active && vi.power == 0 && vg.power == 0 && CheckActive(grid, g) && CheckActive(grid, i) {
                GndVia_Set.insert(ByVia(temp_via));
            }
        }
    }

    MergePowerMetal(&mut VddPower_metal);
    MergePowerMetal(&mut GndPower_metal);
    let Vdd_grid = PowerGrid {
        merged_metals: VddPower_metal,
        metals: VddPower_Set.into_iter().map(|m| m.0).collect(),
        vias: VddVia_Set.into_iter().map(|v| v.0).collect(),
        ..PowerGrid::default()
    };
    let Gnd_grid = PowerGrid {
        merged_metals: GndPower_metal,
        metals: GndPower_Set.into_iter().map(|m| m.0).collect(),
        vias: GndVia_Set.into_iter().map(|v| v.0).collect(),
        ..PowerGrid::default()
    };
    (Vdd_grid, Gnd_grid)
}

/// Graph::MergePowerMetal (Graph.cpp:80-105) — 벡터 순서에 기댄다. 빈 벡터면 C++ 은 초기화 안 된
/// 금속 하나를 넣는다: 여기서는 점 없는 금속(MetalIdx = INT_MIN, 어디에도 안 맞는다)으로 둔다.
fn MergePowerMetal(VddPower_metal: &mut Vec<Metal>) {
    let mut tempPower_metal: Vec<Metal> = Vec::new();
    let mut temp_metal = if let Some(m) = VddPower_metal.first() {
        m.clone()
    } else {
        Metal { MetalIdx: i32::MIN, LinePoint: Vec::new(), width: 0, MetalRect: contact::default() }
    };
    for m in VddPower_metal.iter().skip(1) {
        if m.MetalIdx == temp_metal.MetalIdx
            && m.MetalIdx % 2 == 0
            && m.LinePoint[0].x == temp_metal.LinePoint[0].x
            && m.LinePoint[1].x == temp_metal.LinePoint[1].x
            && m.LinePoint[0].y >= temp_metal.LinePoint[0].y
            && m.LinePoint[0].y <= temp_metal.LinePoint[1].y
        {
            temp_metal.LinePoint[1].y = m.LinePoint[1].y.max(temp_metal.LinePoint[1].y);
        } else if m.MetalIdx == temp_metal.MetalIdx
            && m.MetalIdx % 2 == 1
            && m.LinePoint[0].y == temp_metal.LinePoint[0].y
            && m.LinePoint[1].y == temp_metal.LinePoint[1].y
            && m.LinePoint[0].x >= temp_metal.LinePoint[0].x
            && m.LinePoint[0].x <= temp_metal.LinePoint[1].x
        {
            temp_metal.LinePoint[1].x = m.LinePoint[1].x.max(temp_metal.LinePoint[1].x);
        } else {
            tempPower_metal.push(temp_metal);
            temp_metal = m.clone();
        }
    }
    tempPower_metal.push(temp_metal);
    *VddPower_metal = tempPower_metal;
}

/// Graph::Connection_Check_Power_Grid (Graph.cpp:371-407) — 가장 큰 덩이(같으면 먼저 것)만 남긴다
fn Connection_Check_Power_Grid(grid: &mut Grid, power: i32) {
    let mut number_connection_graph: Vec<i64> = Vec::new();
    let mut graph_index = 0;
    for i in 0..grid.vertices_graph.len() {
        let v = &grid.vertices_graph[i];
        if v.graph_index == -1 && v.power == power && v.active {
            let mut connection_graph_number: i64 = 0;
            power_grid_dsf(grid, i, graph_index, &mut connection_graph_number, power);
            graph_index += 1;
            number_connection_graph.push(connection_graph_number);
        }
    }
    let mut max_index: i32 = -1;
    let mut max_number: i64 = -1;
    for (i, &c) in number_connection_graph.iter().enumerate() {
        if c > max_number {
            max_number = c;
            max_index = i as i32;
        }
    }
    for v in grid.vertices_graph.iter_mut() {
        if v.power == power && v.graph_index != max_index {
            v.active = false;
        }
    }
}

/// Graph::power_grid_dsf (Graph.cpp:275-369). 이웃은 방문할 때 모아 두고(아직 안 간 것만), 되돌아와서
/// 다시 확인하지 않고 모두 들어간다 — 그래서 한 꼭짓점을 여러 번 센다. 재귀를 명시적 스택으로 옮기되
/// 호출 수는 그대로 센다.
fn power_grid_dsf(grid: &mut Grid, root: usize, graph_index: i32, cnt: &mut i64, power: i32) {
    let mut stack: Vec<(Vec<usize>, usize)> = Vec::new();
    let adj = dsf_visit(grid, root, graph_index, cnt, power);
    stack.push((adj, 0));
    while let Some(top) = stack.last_mut() {
        if top.1 >= top.0.len() {
            stack.pop();
            continue;
        }
        let nxt = top.0[top.1];
        top.1 += 1;
        let adj = dsf_visit(grid, nxt, graph_index, cnt, power);
        stack.push((adj, 0));
    }
}

/// 재귀 한 번의 몸통: 표시하고 세고, 이웃을 N, S, E, W, 위, 아래 순으로 모은다
fn dsf_visit(grid: &mut Grid, i: usize, graph_index: i32, cnt: &mut i64, power: i32) -> Vec<usize> {
    grid.vertices_graph[i].graph_index = graph_index;
    *cnt += 1;
    let v = &grid.vertices_graph[i];
    let mut adjacent_nodes = Vec::new();
    for t in [v.north, v.south, v.east, v.west, v.up, v.down] {
        if t < 0 {
            continue;
        }
        if let Some(index) = grid.t2g(t) {
            let w = &grid.vertices_graph[index];
            if w.active && w.power == power && w.graph_index == -1 {
                adjacent_nodes.push(index);
            }
        }
    }
    adjacent_nodes
}

/// Graph::CheckActive — 같은 층 이웃 가운데 켜진 것이 하나라도 있나 (극성은 안 본다)
fn CheckActive(grid: &Grid, index: usize) -> bool {
    let v = &grid.vertices_graph[index];
    let mut found = false;
    for t in [v.north, v.south, v.east, v.west] {
        if t < 0 {
            continue;
        }
        if let Some(g) = grid.t2g(t)
            && grid.vertices_graph[g].active
        {
            found = true;
        }
    }
    found
}
