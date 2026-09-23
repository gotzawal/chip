//! A_star — 격자 위 한 핀에서 도착 후보들까지 (router/A_star.cpp). PowerRouter 는 A_star(grid, 0) 과
//! FindFeasiblePath(grid, 1, 0, 0) 으로 부른다: 평행 배선이 없어서(left = right = 0)
//! find_nodes_* 는 늘 빈 목록으로 참을 돌려주고, 시작·끝 점은 [현재], [다음] 하나씩이다.
//! 그 밖(L 자 걷기, 비아 검사, 늘리기 검사, 역추적)은 C++ 그대로 옮긴다.
use super::grid::Grid;
use super::util::f2i;
use crate::db::DrcInfo;
use crate::rdb::{Metal, contact, point};
use std::cmp::Ordering;
use std::collections::BTreeSet;

/// L_list 의 키 — std::set<pair<double,int>, pairCompDBL>. NaN 과 -0.0 은 나오지 않는다.
#[derive(Clone, Copy, Debug, PartialEq)]
struct K(f64);
impl Eq for K {}
impl PartialOrd for K {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for K {
    fn cmp(&self, o: &Self) -> Ordering {
        self.0.total_cmp(&o.0)
    }
}

pub struct A_star<'a> {
    source: Vec<i32>,
    dest: Vec<i32>,
    shielding: bool,
    pub Path: Vec<Vec<i32>>,
    Extend_labels: Vec<Vec<i32>>,
    drc_info: &'a DrcInfo,
    /// C++ 이 끝나지 않는(무한 반복) 자리에 닿았다 — 부르는 쪽이 오류로 돌린다
    pub stuck: Option<String>,
    /// 조사용: 빈 node_L_path[0] 을 읽은 횟수 (C++ 에서는 정의되지 않은 동작)
    pub ub_empty_node_L_path: usize,
}

impl<'a> A_star<'a> {
    /// A_star::A_star(grid, shielding)
    pub fn new(grid: &Grid<'a>, shielding: bool) -> Self {
        A_star {
            source: grid.Source.clone(),
            dest: grid.Dest.clone(),
            shielding,
            Path: Vec::new(),
            Extend_labels: Vec::new(),
            drc_info: grid.drc_info,
            stuck: None,
            ub_empty_node_L_path: 0,
        }
    }

    /// A_star::FindFeasiblePath (A_star.cpp:17-39)
    pub fn FindFeasiblePath(&mut self, grid: &mut Grid, pathNo: i32, left_up: i32, right_down: i32) -> bool {
        let mut mark = false;
        for _ in 0..pathNo {
            let temp_path = self.A_star_algorithm(grid, left_up, right_down);
            if self.stuck.is_some() {
                return false;
            }
            if !temp_path.is_empty() {
                self.Path = temp_path;
                mark = true;
            }
        }
        mark
    }

    pub fn GetExtendLabel(&self) -> Vec<Vec<i32>> {
        self.Extend_labels.clone()
    }

    pub fn GetPath(&self) -> Vec<Vec<i32>> {
        self.Path.clone()
    }

    /// A_star::ConvertPathintoPhysical (A_star.cpp:75-115) — 같은 층 토막마다 금속 하나.
    /// 한 꼭짓점짜리 토막은 [p, p]. MetalRect 는 기본값 그대로.
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

    /// A_star::Manhattan_distan_dest — 도착 후보까지 가장 짧은 맨해튼 거리 (없으면 INT_MAX)
    fn Manhattan_distan_dest(&self, sindex: i32, grid: &Grid) -> i32 {
        let vt = &grid.vertices_total;
        let s = &vt[sindex as usize];
        let mut min_dis = i32::MAX;
        for &d in &self.dest {
            let dv = &vt[d as usize];
            let temp_dis = (s.x - dv.x).abs() + (s.y - dv.y).abs();
            min_dis = min_dis.min(temp_dis);
        }
        min_dis
    }

    /// A_star::A_star_algorithm (A_star.cpp:1432-1543)
    fn A_star_algorithm(&mut self, grid: &mut Grid, left_up: i32, right_down: i32) -> Vec<Vec<i32>> {
        let via_expand_effort = 100;
        let mut L_list: BTreeSet<(K, i32)> = BTreeSet::new();
        let mut close_set: BTreeSet<i32> = BTreeSet::new();
        let mut src_index: BTreeSet<i32> = BTreeSet::new();
        for &s in &self.source {
            src_index.insert(s);
            close_set.insert(s);
        }
        let dest_index: BTreeSet<i32> = self.dest.iter().copied().collect();

        // initial_source
        for k in 0..self.source.len() {
            let s = self.source[k];
            let Mdis = self.Manhattan_distan_dest(s, grid);
            let v = &mut grid.vertices_total[s as usize];
            v.Cost = 0.0;
            let mut dis = v.Cost + Mdis as f64 * self.drc_info.Metal_info[v.metal as usize].unit_R;
            dis += ((v.x - grid.center_x).abs() + (v.y - grid.center_y).abs()) as f64 / 1e10;
            L_list.insert((K(dis), s));
        }

        let mut found = false;
        let mut current_node = -1;
        while !L_list.is_empty() && !found {
            let (_, cur) = L_list.pop_first().unwrap();
            current_node = cur;

            if dest_index.contains(&current_node) {
                let extend = self.Pre_trace_back(grid, current_node, left_up, right_down, &src_index, &dest_index);
                if self.stuck.is_some() {
                    return Vec::new();
                }
                if extend {
                    found = true;
                }
                continue;
            }

            let mut candidate_node = self.found_near_node(current_node, grid);
            let near_node_exist = !candidate_node.is_empty();
            candidate_node.retain(|c| !close_set.contains(c));
            if !near_node_exist {
                continue;
            }

            let mut temp_candidate_node = Vec::new();
            let mut temp_candidate_cost = Vec::new();
            for &c in &candidate_node {
                let mut cost = 0;
                let (parallel, _) = self.parallel_routing(grid, current_node, c, left_up, right_down, &src_index, &dest_index, &mut cost);
                if self.stuck.is_some() {
                    return Vec::new();
                }
                if parallel {
                    temp_candidate_node.push(c);
                    temp_candidate_cost.push(cost);
                }
            }
            if temp_candidate_node.is_empty() {
                continue;
            }

            for (i, &c) in temp_candidate_node.iter().enumerate() {
                let M_dis = self.Manhattan_distan_dest(c, grid);
                let vt = &grid.vertices_total;
                let (cv, nv) = (&vt[current_node as usize], &vt[c as usize]);
                // double + int + int + int + int 을 왼쪽부터, 그리고 int 로
                let temp_cost = f2i(cv.Cost + (cv.x - nv.x).abs() as f64 + (cv.y - nv.y).abs() as f64
                    + (via_expand_effort * (nv.metal - cv.metal).abs()) as f64
                    + temp_candidate_cost[i] as f64);
                if (temp_cost as f64) < nv.Cost {
                    // temp_pair 는 pair<int,int> — (int)(DBL_MAX + M) = INT_MIN 이라 처음 지우기는 헛돈다
                    let old = f2i(nv.Cost + M_dis as f64);
                    L_list.remove(&(K(old as f64), c));
                    let nvm = &mut grid.vertices_total[c as usize];
                    nvm.Cost = temp_cost as f64;
                    let dis = f2i(nvm.Cost + M_dis as f64);
                    nvm.parent = current_node;
                    L_list.insert((K(dis as f64), c));
                }
            }
        }

        let mut temp_path = Vec::new();
        if found {
            temp_path = self.Trace_Back_Paths(grid, current_node, left_up, right_down, &src_index, &dest_index);
        }
        // refreshGrid
        for v in grid.vertices_total.iter_mut() {
            v.Cost = i32::MAX as f64;
            v.parent = -1;
        }
        temp_path
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

    /// A_star::parallel_routing (A_star.cpp:801-845) with left = right = 0.
    /// 돌려주는 것: (찾았나, node_L_path). node_L_path 는 늘리기 검사에서 떨어지면 비고([]),
    /// L 자 연결에서 떨어지면 빈 목록 하나([[]])다.
    #[allow(clippy::too_many_arguments)]
    fn parallel_routing(&mut self, grid: &Grid, current_node: i32, next_node: i32, left: i32, right: i32,
                        src_index: &BTreeSet<i32>, _dest_index: &BTreeSet<i32>, cost: &mut i32) -> (bool, Vec<Vec<i32>>) {
        debug_assert!(left == 0 && right == 0);
        // find_succsive_parallel_node: find_nodes_*(.., 0, ..) 는 빈 목록으로 참, Check_Src_Dest(빈 것) 도 참.
        // 출발 쪽이면 cost = penety(0).
        let start_points = [current_node];
        let end_points = [next_node];
        if src_index.contains(&current_node) {
            *cost = 0;
        }
        let vt = &grid.vertices_total;
        if vt[current_node as usize].metal != vt[next_node as usize].metal
            && !self.Extention_check_prime(grid, current_node, next_node, src_index)
        {
            return (false, Vec::new());
        }
        let mut node_L_path = Vec::new();
        // L_shape_Connection
        for i in 0..start_points.len() {
            let (connection, node_set) = self.L_shape_Connection_Check(grid, start_points[i], end_points[i]);
            node_L_path.push(node_set);
            if !connection {
                return (false, node_L_path);
            }
        }
        (true, node_L_path)
    }

    /// A_star::L_shape_Connection_Check (A_star.cpp:862-970)
    fn L_shape_Connection_Check(&self, grid: &Grid, start_points: i32, end_points: i32) -> (bool, Vec<i32>) {
        let n = grid.vertices_total.len() as i32;
        let walk = |dummy_layer: i32| -> Option<Vec<i32>> {
            let vt = &grid.vertices_total;
            let mut node_set = vec![start_points];
            let mut unit_node_set: BTreeSet<i32> = BTreeSet::new();
            while *node_set.last().unwrap() != end_points {
                let current_node = *node_set.last().unwrap();
                if !unit_node_set.insert(current_node) {
                    return None;
                }
                let (e, c) = (&vt[end_points as usize], &vt[current_node as usize]);
                let x = (e.x - c.x).signum();
                let y = (e.y - c.y).signum();
                let metal = (e.metal - c.metal).signum();
                let next = self.find_next_node(grid, current_node, x, y, metal, dummy_layer);
                if next < 0 || next >= n {
                    return None;
                }
                node_set.push(next);
            }
            Some(node_set)
        };
        let Some(node_set_up) = walk(1) else { return (false, Vec::new()) };
        let Some(node_set_down) = walk(-1) else { return (false, Vec::new()) };
        let activa_up = self.Check_activa_via_active(grid, &node_set_up);
        let activa_down = self.Check_activa_via_active(grid, &node_set_down);
        if activa_up || activa_down {
            let mut node_set = Vec::new();
            if activa_up {
                node_set = node_set_up;
            }
            if activa_down {
                node_set = node_set_down;
            }
            (true, node_set)
        } else {
            (false, Vec::new())
        }
    }

    /// A_star::find_next_node (A_star.cpp:972-1006) — 같은 층은 번호 ±1, 층 바꾸기는 위/아래
    fn find_next_node(&self, grid: &Grid, current_node: i32, x: i32, y: i32, layer: i32, dummy_layer: i32) -> i32 {
        let v = &grid.vertices_total[current_node as usize];
        let direct = self.drc_info.Metal_info[v.metal as usize].direct;
        let mut next_node = -1;
        if direct == 1 && x != 0 {
            next_node = current_node + x;
        } else if direct == 1 && x == 0 && layer != 0 {
            next_node = if layer > 0 { v.up } else { v.down };
        } else if direct == 1 && x == 0 && layer == 0 {
            next_node = if dummy_layer > 0 { v.up } else { v.down };
        } else if direct == 0 && y != 0 {
            next_node = current_node + y;
        } else if direct == 0 && y == 0 && layer != 0 {
            next_node = if layer > 0 { v.up } else { v.down };
        } else if direct == 0 && y == 0 && layer == 0 {
            next_node = if dummy_layer > 0 { v.up } else { v.down };
        }
        next_node
    }

    /// A_star::Check_activa_via_active (A_star.cpp:1037-1064)
    #[allow(clippy::if_same_then_else)]
    fn Check_activa_via_active(&self, grid: &Grid, nodes: &[i32]) -> bool {
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
            } else if parent_metal > current_metal
                && (!vt[cur].active || !vt[cur].via_active_up || !vt[parent].active || !vt[parent].via_active_down)
            {
                return false;
            } else if parent_metal < current_metal
                && (!vt[cur].active || !vt[cur].via_active_down || !vt[parent].active || !vt[parent].via_active_up)
            {
                return false;
            }
        }
        true
    }

    /// A_star::trace_back_node_parent / trace_back_node (A_star.cpp:265-355) — parent (또는
    /// trace_back_node) 를 따라 같은 층의 첫 꼭짓점까지. C++ 은 되돌아온 점을 current_node 하나만
    /// 기억해서, 그리로 되돌아오면 끝나지 않는다 — 그때는 stuck 을 세우고 멈춘다.
    fn trace_same_layer(&mut self, current_node: i32, grid: &Grid, by_parent: bool) -> i32 {
        let vt = &grid.vertices_total;
        let mut first_node_same_layer = current_node;
        let mut dummy_node = current_node;
        loop {
            let d = &vt[dummy_node as usize];
            let last_node = if by_parent { d.parent } else { d.trace_back_node };
            if last_node < 0 || last_node >= vt.len() as i32 {
                break;
            } else if vt[last_node as usize].metal == d.metal && last_node != current_node {
                first_node_same_layer = last_node;
                dummy_node = last_node;
            } else if vt[last_node as usize].metal != d.metal && last_node != current_node {
                break;
            } else {
                self.stuck = Some(format!("trace_back_node 가 {current_node} 로 되돌아온다 (C++ 은 끝나지 않는다)"));
                break;
            }
        }
        first_node_same_layer
    }

    /// CheckExendable_With_Certain_Length* 의 한쪽 걷기: 번호 ±1 로 걸으며 켜져 있고, 같은 층이고,
    /// 시작점과 x 나 y 가 같은 동안 half 만큼 갈 수 있나
    #[allow(clippy::if_same_then_else)]
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
            if !nv.active {
                return false;
            } else if (nv.x != s.x && nv.y != s.y) || nv.metal != s.metal {
                return false;
            } else {
                culmulated_length = (nv.x - s.x).abs() + (nv.y - s.y).abs();
                dummy_node = next_node;
            }
        }
    }

    fn directions(first_node_same_layer: i32, current_node: i32) -> (i32, i32) {
        if first_node_same_layer <= current_node { (-1, 1) } else { (1, -1) }
    }

    /// A_star::CheckExendable_With_Certain_Length (양끝을 반씩)
    fn CheckExendable_With_Certain_Length(first_node_same_layer: i32, current_node: i32, length: i32, minL: i32, grid: &Grid) -> bool {
        let half_minL = f2i((((minL as f64) - (length as f64)) / 2.0).ceil());
        let (fd, cd) = Self::directions(first_node_same_layer, current_node);
        let a = Self::walk(grid, first_node_same_layer, fd, half_minL);
        let b = Self::walk(grid, current_node, cd, half_minL);
        a && b
    }

    /// A_star::CheckExendable_With_Certain_Length_Head_Extend — 첫 점 쪽으로만. direction = 첫 점 쪽
    fn CheckExendable_Head(first_node_same_layer: i32, current_node: i32, length: i32, minL: i32, grid: &Grid) -> (bool, i32) {
        let half_minL = f2i(((minL as f64) - (length as f64)).ceil());
        let (fd, _) = Self::directions(first_node_same_layer, current_node);
        (Self::walk(grid, first_node_same_layer, fd, half_minL), fd)
    }

    /// A_star::CheckExendable_With_Certain_Length_Tail_Extend — 끝 점 쪽으로만. direction = 끝 점 쪽
    fn CheckExendable_Tail(first_node_same_layer: i32, current_node: i32, length: i32, minL: i32, grid: &Grid) -> (bool, i32) {
        let half_minL = f2i(((minL as f64) - (length as f64)).ceil());
        let (_, cd) = Self::directions(first_node_same_layer, current_node);
        (Self::walk(grid, current_node, cd, half_minL), cd)
    }

    /// 비아 간격 (같은 층 금속 방향으로): 가로층이면 width + dist_ss, 세로층이면 width_y + dist_ss_y
    fn via_space_length(&self, metal_run: i32, a: i32, b: i32) -> i32 {
        let via_index = if a < b { a } else { b } as usize;
        let vi = &self.drc_info.Via_info[via_index];
        if self.drc_info.Metal_info[metal_run as usize].direct == 1 {
            vi.width + vi.dist_ss
        } else {
            vi.width_y + vi.dist_ss_y
        }
    }

    /// A_star::Extention_check_prime (A_star.cpp:1076-1115) — 층을 바꾸기 전에 지금 층 토막이
    /// 최소 길이를 채울 수 있나 (parent 를 따라)
    fn Extention_check_prime(&mut self, grid: &Grid, current_node: i32, next_node: i32, source_index: &BTreeSet<i32>) -> bool {
        let node_same_layer = self.trace_same_layer(current_node, grid, true);
        if self.stuck.is_some() {
            return false;
        }
        if source_index.contains(&node_same_layer) {
            return true;
        }
        let vt = &grid.vertices_total;
        let (cv, sv) = (&vt[current_node as usize], &vt[node_same_layer as usize]);
        let metal = cv.metal;
        let length = (cv.x - sv.x).abs() + (cv.y - sv.y).abs();
        let minL = self.drc_info.Metal_info[metal as usize].minL;
        let delta_length = length - minL;
        let temp_parent = sv.parent;
        let mut via_space_length = 0;
        if temp_parent != -1 && vt[temp_parent as usize].metal == vt[next_node as usize].metal {
            via_space_length = self.via_space_length(cv.metal, cv.metal, vt[next_node as usize].metal);
        }
        if delta_length < 0 && length >= via_space_length {
            let feasible_half = Self::CheckExendable_With_Certain_Length(node_same_layer, current_node, length, minL, grid);
            let (feasible_head, _) = Self::CheckExendable_Head(node_same_layer, current_node, length, minL, grid);
            let (feasible_tail, _) = Self::CheckExendable_Tail(node_same_layer, current_node, length, minL, grid);
            feasible_half || feasible_head || feasible_tail
        } else {
            length >= via_space_length
        }
    }

    /// A_star::Extention_check (A_star.cpp:1117-1173) — trace_back_node 를 따라. 비아 간격보다 짧으면
    /// 끝의 `return true` 로 떨어진다.
    fn Extention_check(&mut self, grid: &Grid, current_node: i32, source_index: &BTreeSet<i32>) -> bool {
        let n = grid.vertices_total.len() as i32;
        let parent = grid.vertices_total[current_node as usize].trace_back_node;
        if parent == -1 {
            return true;
        }
        if parent >= 0 && parent < n {
            let vt = &grid.vertices_total;
            if vt[current_node as usize].metal == vt[parent as usize].metal {
                return true;
            }
            let node_same_layer = self.trace_same_layer(parent, grid, false);
            if self.stuck.is_some() {
                return false;
            }
            if source_index.contains(&node_same_layer) {
                return true;
            }
            let vt = &grid.vertices_total;
            let (pv, sv) = (&vt[parent as usize], &vt[node_same_layer as usize]);
            let metal = pv.metal;
            let length = (pv.x - sv.x).abs() + (pv.y - sv.y).abs();
            let minL = self.drc_info.Metal_info[metal as usize].minL;
            let delta_length = length - minL;
            let temp_parent = sv.trace_back_node;
            let mut via_space_length = 0;
            if temp_parent != -1 && vt[temp_parent as usize].metal == vt[current_node as usize].metal {
                via_space_length = self.via_space_length(pv.metal, pv.metal, vt[current_node as usize].metal);
            }
            if delta_length < 0 && length >= via_space_length {
                let feasible_half = Self::CheckExendable_With_Certain_Length(node_same_layer, parent, length, minL, grid);
                let (feasible_head, _) = Self::CheckExendable_Head(node_same_layer, parent, length, minL, grid);
                let (feasible_tail, _) = Self::CheckExendable_Tail(node_same_layer, parent, length, minL, grid);
                return feasible_half || feasible_head || feasible_tail;
            } else if length >= via_space_length {
                return true;
            }
        }
        // Extention check bug parent node is out of grid (assert 는 꺼져 있다)
        true
    }

    /// A_star::Trace_Back_Path_parent — parent 를 따라 출발점까지, 출발점부터 차례로
    fn Trace_Back_Path_parent(grid: &Grid, current_node: i32, src_index: &BTreeSet<i32>) -> Vec<i32> {
        let mut temp_path = vec![current_node];
        let mut temp_parent = current_node;
        while !src_index.contains(&temp_parent) {
            temp_parent = grid.vertices_total[temp_parent as usize].parent;
            temp_path.push(temp_parent);
            // -1 이면 C++ 은 vertices_total[-1] 을 읽고, 고리면 끝나지 않는다 — 앞에 -1 을 두어 알린다
            if temp_parent < 0 || temp_path.len() > grid.vertices_total.len() + 1 {
                temp_path.push(-1);
                break;
            }
        }
        temp_path.reverse();
        temp_path
    }

    /// A_star::Trace_Back_Path_trace_back_node — src_index 에 -1 을 넣고 trace_back_node 를 따라
    fn Trace_Back_Path_trace_back_node(grid: &Grid, current_node: i32, src_index: &mut BTreeSet<i32>) -> Vec<i32> {
        let mut temp_path = vec![current_node];
        let mut temp_parent = current_node;
        src_index.insert(-1);
        while !src_index.contains(&temp_parent) {
            temp_parent = grid.vertices_total[temp_parent as usize].trace_back_node;
            temp_path.push(temp_parent);
            if temp_path.len() > grid.vertices_total.len() + 1 {
                temp_path.push(-1); // 고리 (C++ 은 끝나지 않는다)
                break;
            }
        }
        temp_path.reverse();
        temp_path
    }

    /// A_star::Pre_trace_back (A_star.cpp:1671-1707) — parent 경로를 다시 이어 보고(평행 배선 검사를
    /// 다시 돌린다), 순환을 지우고 trace_back_node 를 달고, 늘리기 검사를 한다
    fn Pre_trace_back(&mut self, grid: &mut Grid, current_node: i32, left: i32, right: i32,
                      src_index: &BTreeSet<i32>, dest_index: &BTreeSet<i32>) -> bool {
        let temp_path = Self::Trace_Back_Path_parent(grid, current_node, src_index);
        if temp_path.first().is_some_and(|&t| t < 0) {
            self.stuck = Some("Pre_trace_back: parent 가 -1 에 닿았다 (C++ 은 vertices_total[-1] 을 읽는다)".into());
            return false;
        }
        let mut Node_Path: Vec<Vec<i32>> = vec![Vec::new(); (left + right + 1) as usize];
        if src_index.contains(&current_node) {
            return true;
        }
        for i in 0..temp_path.len() - 1 {
            let mut cost = 0;
            let (_, node_L_path) = self.parallel_routing(grid, temp_path[i], temp_path[i + 1], left, right, src_index, dest_index, &mut cost);
            if self.stuck.is_some() {
                return false;
            }
            for (j, np) in Node_Path.iter_mut().enumerate() {
                match node_L_path.get(j) {
                    Some(p) => np.extend_from_slice(p),
                    // 빈 node_L_path[0] 읽기 (UB) — 아무것도 붙이지 않은 것으로 둔다
                    None => self.ub_empty_node_L_path += 1,
                }
            }
        }
        rm_cycle_path(&mut Node_Path);
        // lable_father
        for p in &Node_Path {
            if p.is_empty() {
                continue; // compact_path 의 빈 경로 (UB)
            }
            grid.vertices_total[p[0] as usize].trace_back_node = -1;
            for j in 1..p.len() {
                grid.vertices_total[p[j] as usize].trace_back_node = p[j - 1];
            }
        }
        // Check_Path_Extension
        for p in &Node_Path {
            for &node in p {
                if !self.Extention_check(grid, node, src_index) {
                    return false;
                }
                if self.stuck.is_some() {
                    return false;
                }
            }
        }
        true
    }

    /// A_star::Trace_Back_Paths (A_star.cpp:1709-1780) — 도착점 하나에서 trace_back_node 를 따라
    fn Trace_Back_Paths(&mut self, grid: &Grid, current_node: i32, _left: i32, _right: i32,
                        src_index: &BTreeSet<i32>, _dest_index: &BTreeSet<i32>) -> Vec<Vec<i32>> {
        let mut src = src_index.clone();
        // find_succsive_parallel_node(.., 0, 0, ..) -> [current_node]
        let nodes = [current_node];
        let mut temp_paths = Vec::new();
        let mut extend_labels = Vec::new();
        for &node in &nodes {
            let temp_path = Self::Trace_Back_Path_trace_back_node(grid, node, &mut src);
            if temp_path.first().is_some_and(|&t| t < 0) {
                self.stuck = Some("Trace_Back_Paths: 경로가 -1 에서 시작한다 (C++ 은 vertices_total[-1] 을 읽는다)".into());
                return Vec::new();
            }
            let extend_label = self.extend_manner_direction_check(&temp_path, grid);
            temp_paths.push(temp_path);
            extend_labels.push(extend_label);
        }
        if self.shielding && temp_paths.len() > 2 {
            // CovertToShieldingNet — PowerRouter 는 shielding = 0 으로 부른다
            let last = temp_paths.len() - 1;
            for k in [0, last] {
                let p = &temp_paths[k];
                temp_paths[k] = if p.len() > 2 { p[1..p.len() - 1].to_vec() } else { Vec::new() };
                let l = &extend_labels[k];
                extend_labels[k] = if l.len() > 2 { l[1..l.len() - 1].to_vec() } else { Vec::new() };
            }
        }
        self.Extend_labels = extend_labels;
        temp_paths
    }

    /// A_star::extend_manner_direction_check (A_star.cpp:1175-1234) — 같은 층 토막마다 늘리기 방식
    /// (0 안 늘림, 1 양쪽, 2 머리, 3 꼬리, 4 못 늘림). 처음과 마지막 토막은 0.
    fn extend_manner_direction_check(&self, temp_path: &[i32], grid: &Grid) -> Vec<i32> {
        let vt = &grid.vertices_total;
        let mut path_pairs: Vec<(i32, i32)> = Vec::new();
        let mut temp_metel = -1;
        let mut temp_pair = (-1, 0);
        for i in 0..temp_path.len() {
            let m = vt[temp_path[i] as usize].metal;
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
        let mut extend_index = Vec::new();
        for i in 0..path_pairs.len() {
            if i == 0 || i == path_pairs.len() - 1 {
                extend_index.push(0);
                continue;
            }
            let (a, b) = path_pairs[i];
            let (av, bv) = (&vt[a as usize], &vt[b as usize]);
            let length = (av.x - bv.x).abs() + (av.y - bv.y).abs();
            let minL = self.drc_info.Metal_info[av.metal as usize].minL;
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
        extend_index
    }
}

/// A_star::rm_cycle_path (A_star.cpp:1568-1611) — compact_path 로 이어진 중복을 줄이고, 두 번 나오는
/// 점(작은 번호부터)마다 처음 나온 다음 자리부터 마지막 자리까지를 지운다
fn rm_cycle_path(Node_Path: &mut [Vec<i32>]) {
    for p in Node_Path.iter_mut() {
        // compact_path (빈 경로면 C++ 은 [0] 을 읽는다 — 그대로 둔다)
        if p.is_empty() {
            continue;
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
}
