//! A_star — 연결 하나의 격자 탐색 (router/A_star.cpp). 모드 5 는 `A_star(grid, shielding)` 과
//! `FindFeasiblePath_sym(grid, 1, 0, 0, sym_path)` 로 부른다 (A_star_algorithm_Sym, A_star.cpp:1248-1380).
//!
//! 평행 배선이 없어서(left = right = 0) find_nodes_* 는 늘 빈 목록으로 참이고 값(cost)은 늘 0 이다. 남는 것:
//! - 열린 목록 `std::set<pair<double,int>, pairCompDBL>` — (키, 번호) 순서 집합. 값을 줄일 때 **새 키**로 찾아
//!   지우므로 옛 항목이 남는다 (같은 꼭짓점이 두 번 나올 수 있다). 도착점은 닫지 않는다.
//! - 값: Cost2Source(지나온 길이 x unit_R, 층을 바꾸면 비아 R) + 도착까지 맨해튼 x unit_R + 도착과의 층 차 x 비아 R
//!   + 넷 중심까지 거리 / 1e10. 키는 여기에 0.2 x (대칭 짝 거울 경로에서 떨어진 거리). f64 계산 순서는 C++ 그대로.
//! - 이웃은 N, S, W, E, 위, 아래 (켜진 것만, 위아래는 via_active 깃발도). 층을 바꿀 때는 Extention_check_prime
//!   (지금 층 토막이 최소 길이를 채울 수 있나), 그리고 L 자 걸음(번호 ±1, 위/아래)과 켜짐 검사.
//! - 도착점을 꺼내면 Pre_trace_back: parent 로 되짚어 L 자 검사를 다시 하고, trace_back_node 를 달고, 늘리기 검사.
//! - 끝나면 refreshGrid: 모든 꼭짓점의 Cost 를 INT_MAX, parent 를 -1 로 (Cost2Source, trace_back_node 는 남는다).
//!
//! C++ 이 끝나지 않거나(되짚기 고리) 범위 밖을 읽는 자리는 Err 로 돌려준다.
use super::grid::Grid;
use super::util::f2i;
use crate::db::DrcInfo;
use crate::rdb::{Metal, contact, point};
use std::cmp::Ordering;
use std::collections::BTreeSet;

/// L_list 의 키 — pairCompDBL 은 `==` 이면 번호로, 아니면 `<` 로 견준다 (NaN 은 나오지 않는다)
#[derive(Clone, Copy, Debug)]
struct K(f64);
impl PartialEq for K {
    fn eq(&self, o: &Self) -> bool {
        self.0 == o.0
    }
}
impl Eq for K {}
impl PartialOrd for K {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for K {
    fn cmp(&self, o: &Self) -> Ordering {
        if self.0 == o.0 {
            Ordering::Equal
        } else if self.0 < o.0 {
            Ordering::Less
        } else {
            Ordering::Greater
        }
    }
}

fn ub(what: impl std::fmt::Display) -> String {
    format!("A_star: 정의되지 않은 동작 — {what}")
}

/// std::set<int> 대신 — 꼭짓점 번호(0..n)와 -1 (Trace_Back_Path_trace_back_node 가 넣는다)
struct IdxSet {
    has: Vec<bool>,
    minus_one: bool,
}

impl IdxSet {
    fn new(n: usize) -> Self {
        IdxSet { has: vec![false; n], minus_one: false }
    }
    fn insert(&mut self, i: i32) {
        if i == -1 {
            self.minus_one = true;
        } else if i >= 0 && (i as usize) < self.has.len() {
            self.has[i as usize] = true;
        }
    }
    fn contains(&self, i: i32) -> bool {
        if i == -1 {
            self.minus_one
        } else {
            i >= 0 && (i as usize) < self.has.len() && self.has[i as usize]
        }
    }
}

pub struct A_star<'a> {
    source: Vec<i32>,
    dest: Vec<i32>,
    #[allow(dead_code)]
    shielding: bool,
    pub Path: Vec<Vec<i32>>,
    pub Extend_labels: Vec<Vec<i32>>,
    drc_info: &'a DrcInfo,
}

impl<'a> A_star<'a> {
    /// A_star::A_star(grid, shielding)
    pub fn new(grid: &Grid<'a>, shielding: bool) -> Self {
        A_star { source: grid.Source.clone(), dest: grid.Dest.clone(), shielding, Path: Vec::new(), Extend_labels: Vec::new(), drc_info: grid.drc_info }
    }

    /// A_star::FindFeasiblePath_sym (A_star.cpp:41-63)
    pub fn FindFeasiblePath_sym(&mut self, grid: &mut Grid, pathNo: i32, left_up: i32, right_down: i32, sym_path: &[Metal]) -> Result<bool, String> {
        let mut mark = false;
        for _ in 0..pathNo {
            let temp_path = self.A_star_algorithm_Sym(grid, left_up, right_down, sym_path)?;
            if !temp_path.is_empty() {
                self.Path = temp_path;
                mark = true;
            }
            // else: Router-Warning: feasible path might not be found
        }
        Ok(mark)
    }

    /// A_star::ConvertPathintoPhysical (A_star.cpp:75-115) — 같은 층 토막마다 금속 하나 [첫 점, 끝 점].
    /// MetalRect 는 기본값(층 -1) 그대로.
    pub fn ConvertPathintoPhysical(&self, grid: &Grid) -> Vec<Vec<Metal>> {
        let vt = &grid.vertices_total;
        let mut Phsical_Path = Vec::new();
        for path in &self.Path {
            let mut temp_physical_path = Vec::new();
            let mut flag_start_write = true;
            let mut temp_metal = Metal { MetalIdx: 0, LinePoint: Vec::new(), width: 0, MetalRect: contact::default() };
            let n = path.len();
            for j in 0..n {
                let v = &vt[path[j] as usize];
                if flag_start_write {
                    temp_metal.LinePoint.clear();
                    temp_metal.MetalIdx = v.metal;
                    temp_metal.LinePoint.push(point::new(v.x, v.y));
                    flag_start_write = false;
                }
                if j + 1 < n && v.metal != vt[path[j + 1] as usize].metal {
                    flag_start_write = true;
                    temp_metal.LinePoint.push(point::new(v.x, v.y));
                    temp_metal.width = grid.drc_info.Metal_info[v.metal as usize].width;
                    temp_physical_path.push(temp_metal.clone());
                }
                if j + 1 == n && !flag_start_write {
                    flag_start_write = true;
                    temp_metal.LinePoint.push(point::new(v.x, v.y));
                    temp_metal.width = grid.drc_info.Metal_info[v.metal as usize].width;
                    temp_physical_path.push(temp_metal.clone());
                }
            }
            Phsical_Path.push(temp_physical_path);
        }
        Phsical_Path
    }

    fn vt<'g>(grid: &'g Grid, i: i32) -> Result<&'g super::grid::Vertex, String> {
        usize::try_from(i).ok().and_then(|u| grid.vertices_total.get(u)).ok_or_else(|| ub(format!("vertices_total[{i}]")))
    }

    /// A_star::Manhattan_distan_dest — 도착 후보까지 가장 짧은 맨해튼 거리 (없으면 INT_MAX)
    fn Manhattan_distan_dest(&self, sindex: i32, grid: &Grid) -> i32 {
        let vt = &grid.vertices_total;
        let s = &vt[sindex as usize];
        let mut min_dis = i32::MAX;
        for &d in &self.dest {
            let dv = &vt[d as usize];
            let temp_dis = s.x.wrapping_sub(dv.x).wrapping_abs().wrapping_add(s.y.wrapping_sub(dv.y).wrapping_abs());
            min_dis = min_dis.min(temp_dis);
        }
        min_dis
    }

    /// A_star::Manhattan_distan_dest_via — 도착 후보와의 가장 작은 층 차 (없으면 INT_MAX)
    fn Manhattan_distan_dest_via(&self, sindex: i32, grid: &Grid) -> i32 {
        let vt = &grid.vertices_total;
        let s = &vt[sindex as usize];
        let mut min_dis = i32::MAX;
        for &d in &self.dest {
            let temp_dis = s.metal.wrapping_sub(vt[d as usize].metal).wrapping_abs();
            min_dis = min_dis.min(temp_dis);
        }
        min_dis
    }

    fn unit_R(&self, metal: i32) -> Result<f64, String> {
        usize::try_from(metal).ok().and_then(|m| self.drc_info.Metal_info.get(m)).map(|m| m.unit_R).ok_or_else(|| ub(format!("Metal_info[{metal}]")))
    }

    /// `drc_info.Via_info[drc_info.Metal_info[m].upper_via_index].R`
    fn via_R(&self, m: i32) -> Result<f64, String> {
        let mi = usize::try_from(m).ok().and_then(|u| self.drc_info.Metal_info.get(u)).ok_or_else(|| ub(format!("Metal_info[{m}]")))?;
        let vi = mi.upper_via_index;
        usize::try_from(vi).ok().and_then(|u| self.drc_info.Via_info.get(u)).map(|v| v.R).ok_or_else(|| ub(format!("Via_info[{vi}] (층 {m} 의 upper_via_index)")))
    }

    /// A_star::A_star_algorithm_Sym (A_star.cpp:1248-1380)
    fn A_star_algorithm_Sym(&mut self, grid: &mut Grid, left_up: i32, right_down: i32, sym_path: &[Metal]) -> Result<Vec<Vec<i32>>, String> {
        let n = grid.vertices_total.len();
        let mut L_list: BTreeSet<(K, i32)> = BTreeSet::new();
        let mut close_set = IdxSet::new(n);
        let mut src_index = IdxSet::new(n);
        for &s in &self.source {
            src_index.insert(s);
            close_set.insert(s);
        }
        let mut dest_index = IdxSet::new(n);
        for &d in &self.dest {
            dest_index.insert(d);
        }

        // initial_source
        for k in 0..self.source.len() {
            let s = self.source[k];
            let Mdis = self.Manhattan_distan_dest(s, grid);
            let unit_R = self.unit_R(grid.vertices_total[s as usize].metal)?;
            let (cx, cy) = (grid.center_x, grid.center_y);
            let v = &mut grid.vertices_total[s as usize];
            v.Cost = 0.0;
            v.Cost2Source = 0.0;
            let mut dis = v.Cost + Mdis as f64 * unit_R;
            dis += (v.x.wrapping_sub(cx).wrapping_abs().wrapping_add(v.y.wrapping_sub(cy).wrapping_abs())) as f64 / 1e10;
            L_list.insert((K(dis), s));
        }

        let mut found = false;
        let mut current_node = -1;
        while !found {
            let Some((_, cur)) = L_list.pop_first() else { break };
            current_node = cur;

            if dest_index.contains(current_node) {
                let extend = self.Pre_trace_back(grid, current_node, left_up, right_down, &src_index, &dest_index)?;
                if extend {
                    found = true;
                }
                continue;
            }

            close_set.insert(current_node);

            let candidate_node = self.found_near_node(current_node, grid);
            let near_node_exist = !candidate_node.is_empty();
            let candidate_node: Vec<i32> = candidate_node.into_iter().filter(|&c| !close_set.contains(c)).collect();
            if !near_node_exist {
                continue;
            }

            let mut temp_candidate_node = Vec::new();
            let mut temp_candidate_cost = Vec::new();
            for &c in &candidate_node {
                let (parallel, _) = self.parallel_routing(grid, current_node, c, left_up, right_down, &src_index, &dest_index)?;
                if parallel {
                    temp_candidate_node.push(c);
                    temp_candidate_cost.push(0i32);
                }
            }
            if temp_candidate_node.is_empty() {
                continue;
            }

            for (i, &c) in temp_candidate_node.iter().enumerate() {
                let M_dis_dest = self.Manhattan_distan_dest(c, grid);
                let M_dis_dest_via = self.Manhattan_distan_dest_via(c, grid);
                let (cv, nv) = (&grid.vertices_total[current_node as usize], &grid.vertices_total[c as usize]);
                let tmp_metal = nv.metal.min(cv.metal);
                let current_node_cost_source = cv.Cost2Source;
                let unit_R = self.unit_R(cv.metal)?;
                let via_R = self.via_R(tmp_metal)?;
                let mut cost_inc = cv.x.wrapping_sub(nv.x).wrapping_abs() as f64 * unit_R + cv.y.wrapping_sub(nv.y).wrapping_abs() as f64 * unit_R;
                if nv.metal != cv.metal {
                    cost_inc += via_R;
                }
                let mut temp_cost = current_node_cost_source + cost_inc + temp_candidate_cost[i] as f64 + M_dis_dest as f64 * unit_R
                    + via_R * M_dis_dest_via as f64;
                temp_cost += (nv.x.wrapping_sub(grid.center_x).wrapping_abs().wrapping_add(nv.y.wrapping_sub(grid.center_y).wrapping_abs())) as f64 / 1e10;
                if temp_cost < nv.Cost {
                    let sym_cost = self.Find_Symmetry_Cost(grid, c, sym_path)?;
                    let sym_factor = 0.2;
                    // 새 키로 찾아 지운다 — 옛 키의 항목은 남는다
                    L_list.remove(&(K(temp_cost + sym_factor * sym_cost as f64), c));
                    let nvm = &mut grid.vertices_total[c as usize];
                    nvm.Cost = temp_cost;
                    nvm.Cost2Source = current_node_cost_source + cost_inc;
                    let dis = nvm.Cost + sym_factor * sym_cost as f64;
                    nvm.parent = current_node;
                    L_list.insert((K(dis), c));
                }
            }
        }

        let mut temp_path = Vec::new();
        if found {
            temp_path = self.Trace_Back_Paths(grid, current_node, left_up, right_down, &mut src_index)?;
        }
        // refreshGrid
        for v in grid.vertices_total.iter_mut() {
            v.Cost = i32::MAX as f64;
            v.parent = -1;
        }
        Ok(temp_path)
    }

    /// A_star::Find_Symmetry_Cost — 대칭 짝 경로(거울상) 가운데 가장 가까운 토막까지의 거리 (없으면 0)
    fn Find_Symmetry_Cost(&self, grid: &Grid, current_node: i32, sym_path: &[Metal]) -> Result<i32, String> {
        if sym_path.is_empty() {
            return Ok(0);
        }
        let v = &grid.vertices_total[current_node as usize];
        let (x, y) = (v.x, v.y);
        let mut sym_cost = i32::MAX;
        for m in sym_path {
            let direct = usize::try_from(m.MetalIdx)
                .ok()
                .and_then(|u| self.drc_info.Metal_info.get(u))
                .ok_or_else(|| ub(format!("Metal_info[{}] (대칭 경로)", m.MetalIdx)))?
                .direct;
            let (p0, p1) = (m.LinePoint[0], m.LinePoint[1]);
            // layer_cost = 0 이라 층 차는 값에 안 들어간다
            let length_cost = if direct == 1 {
                let mut l = y.wrapping_sub(p0.y).wrapping_abs();
                let (min_x, max_x) = (p0.x.min(p1.x), p0.x.max(p1.x));
                if !(x <= max_x && x >= min_x) {
                    l = l.wrapping_add(x.wrapping_sub(min_x).wrapping_abs().min(x.wrapping_sub(max_x).wrapping_abs()));
                }
                l
            } else {
                let mut l = x.wrapping_sub(p0.x).wrapping_abs();
                let (min_y, max_y) = (p0.y.min(p1.y), p0.y.max(p1.y));
                if !(y <= max_y && y >= min_y) {
                    l = l.wrapping_add(y.wrapping_sub(min_y).wrapping_abs().min(y.wrapping_sub(max_y).wrapping_abs()));
                }
                l
            };
            if length_cost < sym_cost {
                sym_cost = length_cost;
            }
        }
        Ok(sym_cost)
    }

    /// A_star::found_near_node — N, S, W, E, 위(via_active_up 이면), 아래(via_active_down 이면), 켜진 것만
    fn found_near_node(&self, current_node: i32, grid: &Grid) -> Vec<i32> {
        let vt = &grid.vertices_total;
        let v = &vt[current_node as usize];
        let mut out = Vec::new();
        for t in [v.north, v.south, v.west, v.east] {
            if t >= 0 && vt[t as usize].active {
                out.push(t);
            }
        }
        if v.via_active_up && v.up != -1 && vt[v.up as usize].active {
            out.push(v.up);
        }
        if v.via_active_down && v.down != -1 && vt[v.down as usize].active {
            out.push(v.down);
        }
        out
    }

    /// A_star::parallel_routing (A_star.cpp:801-845), left = right = 0. 돌려주는 것: (찾았나, node_L_path).
    /// node_L_path 는 늘리기 검사에서 떨어지면 비고([]), L 자 연결에서 떨어지면 빈 목록 하나([[]]).
    #[allow(clippy::too_many_arguments)]
    fn parallel_routing(&mut self, grid: &Grid, current_node: i32, next_node: i32, _left: i32, _right: i32, src_index: &IdxSet,
                        _dest_index: &IdxSet) -> Result<(bool, Vec<Vec<i32>>), String> {
        // find_succsive_parallel_node 두 번: find_nodes_*(.., 0, ..) 는 빈 목록으로 참 — 시작·끝은 [current], [next]
        let vt = &grid.vertices_total;
        if vt[current_node as usize].metal != vt[next_node as usize].metal && !self.Extention_check_prime(grid, current_node, next_node, src_index)? {
            return Ok((false, Vec::new()));
        }
        let mut node_L_path = Vec::new();
        let (connection, node_set) = self.L_shape_Connection_Check(grid, current_node, next_node)?;
        node_L_path.push(node_set);
        if !connection {
            return Ok((false, node_L_path));
        }
        Ok((true, node_L_path))
    }

    /// A_star::L_shape_Connection_Check (A_star.cpp:862-970) — 위로 먼저(dummy_layer = 1), 아래로(-1) 걸어 본다
    fn L_shape_Connection_Check(&self, grid: &Grid, start_points: i32, end_points: i32) -> Result<(bool, Vec<i32>), String> {
        let n = grid.vertices_total.len() as i32;
        let walk = |dummy_layer: i32| -> Result<Option<Vec<i32>>, String> {
            let vt = &grid.vertices_total;
            let mut node_set = vec![start_points];
            let mut unit_node_set: BTreeSet<i32> = BTreeSet::new();
            while *node_set.last().unwrap() != end_points {
                let current_node = *node_set.last().unwrap();
                if !unit_node_set.insert(current_node) {
                    return Ok(None);
                }
                let (e, c) = (&vt[end_points as usize], &vt[current_node as usize]);
                let x = e.x.wrapping_sub(c.x).signum();
                let y = e.y.wrapping_sub(c.y).signum();
                let metal = e.metal.wrapping_sub(c.metal).signum();
                let next = self.find_next_node(grid, current_node, x, y, metal, dummy_layer)?;
                if next < 0 || next >= n {
                    return Ok(None);
                }
                node_set.push(next);
            }
            Ok(Some(node_set))
        };
        let Some(node_set_up) = walk(1)? else { return Ok((false, Vec::new())) };
        let Some(node_set_down) = walk(-1)? else { return Ok((false, Vec::new())) };
        let activa_up = Self::Check_activa_via_active(grid, &node_set_up);
        let activa_down = Self::Check_activa_via_active(grid, &node_set_down);
        if activa_up || activa_down {
            let mut node_set = Vec::new();
            if activa_up {
                node_set = node_set_up;
            }
            if activa_down {
                node_set = node_set_down;
            }
            Ok((true, node_set))
        } else {
            Ok((false, Vec::new()))
        }
    }

    /// A_star::find_next_node (A_star.cpp:972-1006) — 같은 층은 번호 ±1, 층 바꾸기는 위/아래
    fn find_next_node(&self, grid: &Grid, current_node: i32, x: i32, y: i32, layer: i32, dummy_layer: i32) -> Result<i32, String> {
        let v = &grid.vertices_total[current_node as usize];
        let direct = usize::try_from(v.metal).ok().and_then(|m| self.drc_info.Metal_info.get(m)).ok_or_else(|| ub("Metal_info[층]"))?.direct;
        let next_node = if direct == 1 && x != 0 {
            current_node + x
        } else if direct == 1 && x == 0 && layer != 0 {
            if layer > 0 { v.up } else { v.down }
        } else if direct == 1 && x == 0 && layer == 0 {
            if dummy_layer > 0 { v.up } else { v.down }
        } else if direct == 0 && y != 0 {
            current_node + y
        } else if direct == 0 && y == 0 && layer != 0 {
            if layer > 0 { v.up } else { v.down }
        } else if direct == 0 && y == 0 && layer == 0 {
            if dummy_layer > 0 { v.up } else { v.down }
        } else {
            -1
        };
        Ok(next_node)
    }

    /// A_star::Check_activa_via_active (A_star.cpp:1037-1064)
    #[allow(clippy::if_same_then_else)]
    fn Check_activa_via_active(grid: &Grid, nodes: &[i32]) -> bool {
        let vt = &grid.vertices_total;
        if nodes.is_empty() || !vt[nodes[0] as usize].active {
            return false;
        }
        for i in 1..nodes.len() {
            if nodes[i] < 0 || nodes[i] > vt.len() as i32 - 1 || !vt[nodes[i] as usize].active {
                return false;
            }
            let parent = nodes[i - 1] as usize;
            let cur = nodes[i] as usize;
            let parent_metal = vt[parent].metal;
            let current_metal = vt[cur].metal;
            if parent_metal == current_metal && !vt[cur].active {
                return false;
            } else if parent_metal > current_metal && (!vt[cur].active || !vt[cur].via_active_up || !vt[parent].active || !vt[parent].via_active_down) {
                return false;
            } else if parent_metal < current_metal && (!vt[cur].active || !vt[cur].via_active_down || !vt[parent].active || !vt[parent].via_active_up) {
                return false;
            }
        }
        true
    }

    /// A_star::trace_back_node_parent / trace_back_node (A_star.cpp:265-355) — parent (또는 trace_back_node)
    /// 를 따라 같은 층의 첫 꼭짓점까지. C++ 은 되돌아온 점을 current_node 하나만 기억해서, 그리로 되돌아오거나
    /// 다른 고리에 들면 끝나지 않는다 — 그때는 Err.
    fn trace_same_layer(grid: &Grid, current_node: i32, by_parent: bool) -> Result<i32, String> {
        let vt = &grid.vertices_total;
        let n = vt.len() as i32;
        let mut first_node_same_layer = current_node;
        let mut dummy_node = current_node;
        let mut steps = 0usize;
        loop {
            let d = &vt[dummy_node as usize];
            let last_node = if by_parent { d.parent } else { d.trace_back_node };
            if last_node < 0 || last_node >= n {
                break;
            } else if vt[last_node as usize].metal == d.metal && last_node != current_node {
                first_node_same_layer = last_node;
                dummy_node = last_node;
            } else if vt[last_node as usize].metal != d.metal && last_node != current_node {
                break;
            } else {
                return Err(format!("trace_back_node 가 {current_node} 로 되돌아온다 (C++ 은 끝나지 않는다)"));
            }
            steps += 1;
            if steps > vt.len() + 1 {
                return Err(format!("trace_back_node 가 고리를 돈다 ({current_node} 에서, C++ 은 끝나지 않는다)"));
            }
        }
        Ok(first_node_same_layer)
    }

    /// CheckExendable_With_Certain_Length* 의 한쪽 걷기: 번호 ±1 로 걸으며 켜져 있고, 같은 층이고,
    /// 시작점과 x 나 y 가 같은 동안 half 만큼 갈 수 있나 (옆 트랙·중복 꼭짓점으로 샐 수 있다)
    fn walk(grid: &Grid, start: i32, direction: i32, half_minL: i32) -> bool {
        let vt = &grid.vertices_total;
        let s = &vt[start as usize];
        let mut culmulated_length = 0;
        let mut dummy_node = start;
        loop {
            if culmulated_length >= half_minL {
                return true;
            }
            let next_node = dummy_node + direction;
            if next_node < 0 || next_node >= vt.len() as i32 {
                return false;
            }
            let nv = &vt[next_node as usize];
            if !nv.active || (nv.x != s.x && nv.y != s.y) || nv.metal != s.metal {
                return false;
            }
            culmulated_length = nv.x.wrapping_sub(s.x).wrapping_abs().wrapping_add(nv.y.wrapping_sub(s.y).wrapping_abs());
            dummy_node = next_node;
        }
    }

    fn directions(first_node_same_layer: i32, current_node: i32) -> (i32, i32) {
        if first_node_same_layer <= current_node { (-1, 1) } else { (1, -1) }
    }

    /// A_star::CheckExendable_With_Certain_Length (양끝을 반씩)
    fn CheckExendable_With_Certain_Length(first_node_same_layer: i32, current_node: i32, length: i32, minL: i32, grid: &Grid) -> bool {
        let half_minL = f2i(((minL as f64 - length as f64) / 2.0).ceil());
        let (fd, cd) = Self::directions(first_node_same_layer, current_node);
        let a = Self::walk(grid, first_node_same_layer, fd, half_minL);
        let b = Self::walk(grid, current_node, cd, half_minL);
        a && b
    }

    /// A_star::CheckExendable_With_Certain_Length_Head_Extend — 첫 점 쪽으로만. direction = 첫 점 쪽
    fn CheckExendable_Head(first_node_same_layer: i32, current_node: i32, length: i32, minL: i32, grid: &Grid) -> (bool, i32) {
        let half_minL = f2i((minL as f64 - length as f64).ceil());
        let (fd, _) = Self::directions(first_node_same_layer, current_node);
        (Self::walk(grid, first_node_same_layer, fd, half_minL), fd)
    }

    /// A_star::CheckExendable_With_Certain_Length_Tail_Extend — 끝 점 쪽으로만. direction = 끝 점 쪽
    fn CheckExendable_Tail(first_node_same_layer: i32, current_node: i32, length: i32, minL: i32, grid: &Grid) -> (bool, i32) {
        let half_minL = f2i((minL as f64 - length as f64).ceil());
        let (_, cd) = Self::directions(first_node_same_layer, current_node);
        (Self::walk(grid, current_node, cd, half_minL), cd)
    }

    /// 비아 간격 (금속 방향으로): 가로층이면 width + dist_ss, 세로층이면 width_y + dist_ss_y
    fn via_space_length(&self, metal_run: i32, a: i32, b: i32) -> Result<i32, String> {
        let via_index = if a < b { a } else { b };
        let vi = usize::try_from(via_index).ok().and_then(|u| self.drc_info.Via_info.get(u)).ok_or_else(|| ub(format!("Via_info[{via_index}]")))?;
        Ok(if self.drc_info.Metal_info[metal_run as usize].direct == 1 {
            vi.width.wrapping_add(vi.dist_ss)
        } else {
            vi.width_y.wrapping_add(vi.dist_ss_y)
        })
    }

    fn minL(&self, metal: i32) -> Result<i32, String> {
        usize::try_from(metal).ok().and_then(|u| self.drc_info.Metal_info.get(u)).map(|m| m.minL).ok_or_else(|| ub(format!("Metal_info[{metal}]")))
    }

    /// A_star::Extention_check_prime (A_star.cpp:1076-1115) — 층을 바꾸기 전에 지금 층 토막이 최소 길이를
    /// 채울 수 있나 (parent 를 따라)
    fn Extention_check_prime(&mut self, grid: &Grid, current_node: i32, next_node: i32, source_index: &IdxSet) -> Result<bool, String> {
        let node_same_layer = Self::trace_same_layer(grid, current_node, true)?;
        if source_index.contains(node_same_layer) {
            return Ok(true);
        }
        let vt = &grid.vertices_total;
        let (cv, sv) = (&vt[current_node as usize], &vt[node_same_layer as usize]);
        let metal = cv.metal;
        let length = cv.x.wrapping_sub(sv.x).wrapping_abs().wrapping_add(cv.y.wrapping_sub(sv.y).wrapping_abs());
        let minL = self.minL(metal)?;
        let delta_length = length.wrapping_sub(minL);
        let temp_parent = sv.parent;
        let mut via_space_length = 0;
        if temp_parent != -1 && Self::vt(grid, temp_parent)?.metal == vt[next_node as usize].metal {
            via_space_length = self.via_space_length(cv.metal, cv.metal, vt[next_node as usize].metal)?;
        }
        if delta_length < 0 && length >= via_space_length {
            let feasible_half = Self::CheckExendable_With_Certain_Length(node_same_layer, current_node, length, minL, grid);
            let (feasible_head, _) = Self::CheckExendable_Head(node_same_layer, current_node, length, minL, grid);
            let (feasible_tail, _) = Self::CheckExendable_Tail(node_same_layer, current_node, length, minL, grid);
            Ok(feasible_half || feasible_head || feasible_tail)
        } else {
            Ok(length >= via_space_length)
        }
    }

    /// A_star::Extention_check (A_star.cpp:1117-1173) — trace_back_node 를 따라. 비아 간격보다 짧으면
    /// 끝의 `return true` 로 떨어진다.
    fn Extention_check(&mut self, grid: &Grid, current_node: i32, source_index: &IdxSet) -> Result<bool, String> {
        let n = grid.vertices_total.len() as i32;
        let parent = grid.vertices_total[current_node as usize].trace_back_node;
        if parent == -1 {
            return Ok(true);
        }
        if parent >= 0 && parent < n {
            let vt = &grid.vertices_total;
            if vt[current_node as usize].metal == vt[parent as usize].metal {
                return Ok(true);
            }
            let node_same_layer = Self::trace_same_layer(grid, parent, false)?;
            if source_index.contains(node_same_layer) {
                return Ok(true);
            }
            let (pv, sv) = (&vt[parent as usize], &vt[node_same_layer as usize]);
            let metal = pv.metal;
            let length = pv.x.wrapping_sub(sv.x).wrapping_abs().wrapping_add(pv.y.wrapping_sub(sv.y).wrapping_abs());
            let minL = self.minL(metal)?;
            let delta_length = length.wrapping_sub(minL);
            let temp_parent = sv.trace_back_node;
            let mut via_space_length = 0;
            if temp_parent != -1 && Self::vt(grid, temp_parent)?.metal == vt[current_node as usize].metal {
                via_space_length = self.via_space_length(pv.metal, pv.metal, vt[current_node as usize].metal)?;
            }
            if delta_length < 0 && length >= via_space_length {
                let feasible_half = Self::CheckExendable_With_Certain_Length(node_same_layer, parent, length, minL, grid);
                let (feasible_head, _) = Self::CheckExendable_Head(node_same_layer, parent, length, minL, grid);
                let (feasible_tail, _) = Self::CheckExendable_Tail(node_same_layer, parent, length, minL, grid);
                return Ok(feasible_half || feasible_head || feasible_tail);
            } else if length >= via_space_length {
                return Ok(true);
            }
        }
        // Extention check bug parent node is out of grid (assert 는 꺼져 있다)
        Ok(true)
    }

    /// A_star::Trace_Back_Path_parent — parent 를 따라 출발점까지, 출발점부터 차례로
    fn Trace_Back_Path_parent(grid: &Grid, current_node: i32, src_index: &IdxSet) -> Result<Vec<i32>, String> {
        let mut temp_path = vec![current_node];
        let mut temp_parent = current_node;
        while !src_index.contains(temp_parent) {
            temp_parent = Self::vt(grid, temp_parent)?.parent;
            temp_path.push(temp_parent);
            if temp_path.len() > grid.vertices_total.len() + 1 {
                return Err("Trace_Back_Path_parent: parent 가 고리를 돈다 (C++ 은 끝나지 않는다)".into());
            }
        }
        temp_path.reverse();
        Ok(temp_path)
    }

    /// A_star::Trace_Back_Path_trace_back_node — src_index 에 -1 을 넣고 trace_back_node 를 따라
    fn Trace_Back_Path_trace_back_node(grid: &Grid, current_node: i32, src_index: &mut IdxSet) -> Result<Vec<i32>, String> {
        let mut temp_path = vec![current_node];
        let mut temp_parent = current_node;
        src_index.insert(-1);
        while !src_index.contains(temp_parent) {
            temp_parent = Self::vt(grid, temp_parent)?.trace_back_node;
            temp_path.push(temp_parent);
            if temp_path.len() > grid.vertices_total.len() + 1 {
                return Err("Trace_Back_Path_trace_back_node: 고리를 돈다 (C++ 은 끝나지 않는다)".into());
            }
        }
        temp_path.reverse();
        Ok(temp_path)
    }

    /// A_star::Pre_trace_back (A_star.cpp:1671-1707) — parent 경로를 다시 이어 보고(L 자 검사를 다시 돌린다),
    /// 순환을 지우고 trace_back_node 를 달고, 늘리기 검사를 한다
    fn Pre_trace_back(&mut self, grid: &mut Grid, current_node: i32, left: i32, right: i32, src_index: &IdxSet,
                      dest_index: &IdxSet) -> Result<bool, String> {
        let temp_path = Self::Trace_Back_Path_parent(grid, current_node, src_index)?;
        let mut Node_Path: Vec<Vec<i32>> = vec![Vec::new(); (left + right + 1) as usize];
        if src_index.contains(current_node) {
            return Ok(true);
        }
        for i in 0..temp_path.len() - 1 {
            let (_, node_L_path) = self.parallel_routing(grid, temp_path[i], temp_path[i + 1], left, right, src_index, dest_index)?;
            for (j, np) in Node_Path.iter_mut().enumerate() {
                // 빈 node_L_path[0] 읽기 (정의되지 않은 동작) 는 아무것도 붙이지 않은 것으로 둔다 (wasm 의 0 번지는 0)
                if let Some(p) = node_L_path.get(j) {
                    np.extend_from_slice(p);
                }
            }
        }
        rm_cycle_path(&mut Node_Path)?;
        // lable_father
        for p in &Node_Path {
            grid.vertices_total[p[0] as usize].trace_back_node = -1;
            for j in 1..p.len() {
                grid.vertices_total[p[j] as usize].trace_back_node = p[j - 1];
            }
        }
        // Check_Path_Extension
        for p in &Node_Path {
            for &node in p {
                if !self.Extention_check(grid, node, src_index)? {
                    return Ok(false);
                }
            }
        }
        Ok(true)
    }

    /// A_star::Trace_Back_Paths (A_star.cpp:1709-1780) — 도착점 하나에서 trace_back_node 를 따라
    fn Trace_Back_Paths(&mut self, grid: &Grid, current_node: i32, _left: i32, _right: i32, src_index: &mut IdxSet) -> Result<Vec<Vec<i32>>, String> {
        // find_succsive_parallel_node(.., 0, 0, ..) -> [current_node]
        let temp_path = Self::Trace_Back_Path_trace_back_node(grid, current_node, src_index)?;
        let extend_label = self.extend_manner_direction_check(&temp_path, grid)?;
        // shielding 은 경로가 셋 넘을 때만 — 하나뿐이다
        self.Extend_labels = vec![extend_label];
        Ok(vec![temp_path])
    }

    /// A_star::extend_manner_direction_check (A_star.cpp:1175-1234) — 같은 층 토막마다 늘리기 방식
    /// (0 안 늘림, 1 양쪽, 2 머리, 3 꼬리, 4 못 늘림). 처음과 마지막 토막은 0.
    fn extend_manner_direction_check(&self, temp_path: &[i32], grid: &Grid) -> Result<Vec<i32>, String> {
        let mut path_pairs: Vec<(i32, i32)> = Vec::new();
        let mut temp_metel = -1;
        let mut temp_pair = (-1, 0);
        for i in 0..temp_path.len() {
            let m = Self::vt(grid, temp_path[i])?.metal;
            if m != temp_metel {
                if temp_pair.0 != -1 {
                    path_pairs.push(temp_pair);
                }
                temp_pair = (temp_path[i], temp_path[i]);
                temp_metel = m;
            } else {
                temp_pair.1 = temp_path[i];
            }
            if i == temp_path.len() - 1 {
                path_pairs.push(temp_pair);
            }
        }
        let vt = &grid.vertices_total;
        let mut extend_index = Vec::new();
        for i in 0..path_pairs.len() {
            if i == 0 || i == path_pairs.len() - 1 {
                extend_index.push(0);
                continue;
            }
            let (a, b) = path_pairs[i];
            let (av, bv) = (&vt[a as usize], &vt[b as usize]);
            let length = av.x.wrapping_sub(bv.x).wrapping_abs().wrapping_add(av.y.wrapping_sub(bv.y).wrapping_abs());
            let minL = self.minL(av.metal)?;
            if length >= minL {
                extend_index.push(0);
            } else if Self::CheckExendable_With_Certain_Length(a, b, length, minL, grid) {
                extend_index.push(1);
            } else {
                let (fh, dh) = Self::CheckExendable_Head(a, b, length, minL, grid);
                if fh {
                    if dh == 1 {
                        extend_index.push(2);
                    }
                    if dh == -1 {
                        extend_index.push(3);
                    }
                } else {
                    let (ft, dt) = Self::CheckExendable_Tail(a, b, length, minL, grid);
                    if ft {
                        if dt == 1 {
                            extend_index.push(2);
                        }
                        if dt == -1 {
                            extend_index.push(3);
                        }
                    } else {
                        extend_index.push(4);
                    }
                }
            }
        }
        Ok(extend_index)
    }
}

/// A_star::rm_cycle_path (A_star.cpp:1568-1611) — compact_path 로 이어진 중복을 줄이고, 두 번 나오는 점
/// (작은 번호부터)마다 처음 나온 다음 자리부터 마지막 자리까지를 지운다
fn rm_cycle_path(Node_Path: &mut [Vec<i32>]) -> Result<(), String> {
    for p in Node_Path.iter_mut() {
        // compact_path: 빈 경로면 C++ 은 [0] 을 읽는다 (정의되지 않은 동작)
        if p.is_empty() {
            return Err(ub("compact_path 가 빈 경로의 [0] 을 읽는다"));
        }
        let mut c = vec![p[0]];
        for j in 1..p.len() {
            if p[j] != p[j - 1] {
                c.push(p[j]);
            }
        }
        let mut unit_set = BTreeSet::new();
        let mut cycle_set = BTreeSet::new();
        for &n in &c {
            if !unit_set.insert(n) {
                cycle_set.insert(n);
            }
        }
        let mut flag = vec![false; c.len()];
        for &val in &cycle_set {
            let mut first_node: i64 = -1;
            let mut end_node: i64 = -1;
            for (j, &n) in c.iter().enumerate() {
                if n == val && first_node == -1 {
                    first_node = j as i64 + 1;
                } else if n == val {
                    end_node = j as i64;
                }
            }
            let mut j = first_node;
            while j <= end_node {
                flag[j as usize] = true;
                j += 1;
            }
        }
        *p = c.iter().zip(&flag).filter(|(_, f)| !**f).map(|(n, _)| *n).collect();
    }
    Ok(())
}
