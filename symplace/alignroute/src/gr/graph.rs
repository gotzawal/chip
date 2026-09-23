//! GlobalGraph — 칸 그래프와 후보 트리 만들기 (router/GlobalGraph.{h,cpp}).
//!
//! 넷마다 칸 그래프를 새로 짓고(CreateAdjacentList_New), 반복 스타이너 한 단계 + "MST"(0 번 묶음에서
//! 다익스트라로 나무를 키운다) 로 후보 트리를 5 개 만든다. 후보를 하나 만들 때마다 쓴 변의 무게를 두 배로
//! 올린다. 버릇은 그대로 둔다:
//! - 그래프 번호는 켜진 칸만 차례로 넣은 번호인데, 변의 dest 와 조회는 칸 번호로 한다 (층을 줄이면 어긋난다).
//! - Iterated_Steiner 는 가장 좋은 후보의 길이 대신 마지막 후보의 길이로 견준다. 후보 목록은 5 번에 걸쳐 준다.
//! - 다익스트라의 열린 목록은 `multimap<double,int>` — 같은 거리는 넣은 순서대로 꺼낸다.
#![allow(non_snake_case)]

use super::grid::GlobalGrid;
use super::ub;
use crate::rdb::tileEdge;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Edge {
    pub dest: i32,
    pub weight: i32,
    /// SetSrcDest 가 붙이는 S/D 변은 C++ 에서 초기화하지 않는다 (읽지 않는다) — 0 으로 둔다
    pub capacity: i32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Node {
    pub src: i32,
    pub metal_layer: Vec<i32>,
    pub active: bool,
    pub list: Vec<Edge>,
}

impl Default for Node {
    fn default() -> Self {
        Node { src: 0, metal_layer: Vec::new(), active: true, list: Vec::new() }
    }
}

#[derive(Clone, Debug, Default)]
pub struct GlobalGraph {
    pub terminals: Vec<i32>,
    pub Pin_terminals: Vec<Vec<i32>>,
    pub source: i32,
    pub dest: i32,
    pub graph: Vec<Node>,
    /// 후보 트리들 (칸 번호 쌍)
    pub Path: Vec<Vec<(i32, i32)>>,
    pub path_number: i32,
}

/// `(double)abs(첫) + abs(둘째)` 를 int 무게로 (앞 항을 double 로 바꿔 더한 뒤 자른다)
fn abs_sum(first: i32, second: i32) -> i32 {
    (f64::from(first.wrapping_abs()) + f64::from(second.wrapping_abs())) as i32
}

/// multimap<double,int> 의 키 — f64 의 전순서 (음수·0 도 숫자 순서대로). 같은 키는 넣은 차례(seq)로 줄 선다.
fn fkey(d: f64) -> u64 {
    let b = d.to_bits();
    if b >> 63 == 0 { b | (1 << 63) } else { !b }
}

fn tile_at(grid: &GlobalGrid, idx: i32) -> Result<&crate::rdb::tile, String> {
    usize::try_from(idx).ok().and_then(|i| grid.tiles_total.get(i)).ok_or_else(|| ub(format!("tiles_total[{idx}]")))
}

impl GlobalGraph {
    /// GlobalGraph(GlobalGrid&) : path_number(1) — 모든 칸으로 그래프를 짓는다
    pub fn new(grid: &GlobalGrid) -> Result<Self, String> {
        let mut g = GlobalGraph { path_number: 1, ..Default::default() };
        g.CreateAdjacentList(grid)?;
        Ok(g)
    }

    pub fn clearPath(&mut self) {
        self.Path.clear();
    }

    fn node(&self, idx: i32) -> Result<&Node, String> {
        usize::try_from(idx).ok().and_then(|i| self.graph.get(i)).ok_or_else(|| ub(format!("graph[{idx}] (크기 {})", self.graph.len())))
    }

    fn node_mut(&mut self, idx: i32) -> Result<&mut Node, String> {
        let n = self.graph.len();
        usize::try_from(idx).ok().and_then(|i| self.graph.get_mut(i)).ok_or_else(|| ub(format!("graph[{idx}] (크기 {n})")))
    }

    /// 후보 트리 pathNo 개. stiner_node 는 참조로 받아 줄여 나간다 (5 번에 걸쳐 준다).
    pub fn FindSTs(&mut self, grid: &GlobalGrid, pathNo: i32, stiner_node: &mut Vec<i32>) -> Result<(), String> {
        self.path_number = pathNo;
        let temp_terminals = self.Pin_terminals.clone();
        let mut empty_flag = true;
        for t in &temp_terminals {
            if !t.is_empty() {
                empty_flag = false;
            }
        }
        if empty_flag {
            return Ok(());
        }
        for _ in 0..pathNo {
            self.Pin_terminals = temp_terminals.clone();
            let mut temp_path = Vec::new();
            self.Iterated_Steiner(grid, stiner_node)?;
            let mut weight = 0;
            self.MST(&mut weight, &mut temp_path, grid)?;
            self.UpdateEdgeWeight(&temp_path)?;
            self.Path.push(temp_path);
        }
        self.refreshWeight(grid)
    }

    /// 쓴 변의 무게를 두 배로 (양쪽 방향, 같은 dest 인 변 전부)
    pub fn UpdateEdgeWeight(&mut self, temp_path: &[(i32, i32)]) -> Result<(), String> {
        let times = 2;
        for &(a, b) in temp_path {
            for e in self.node_mut(a)?.list.iter_mut() {
                if e.dest == b {
                    e.weight = e.weight.wrapping_mul(times);
                }
            }
            for e in self.node_mut(b)?.list.iter_mut() {
                if e.dest == a {
                    e.weight = e.weight.wrapping_mul(times);
                }
            }
        }
        Ok(())
    }

    /// 무게를 맨해튼 거리로 되돌린다 (다음 넷은 그래프를 새로 지으니 결과에 닿지 않는다)
    pub fn refreshWeight(&mut self, grid: &GlobalGrid) -> Result<(), String> {
        let n = self.graph.len().saturating_sub(2);
        for i in 0..n {
            let s = tile_at(grid, self.graph[i].src)?;
            let (sx, sy) = (s.x, s.y);
            for j in 0..self.graph[i].list.len() {
                let d = tile_at(grid, self.graph[i].list[j].dest)?;
                self.graph[i].list[j].weight = abs_sum(sx.wrapping_sub(d.x), sy.wrapping_sub(d.y));
            }
        }
        Ok(())
    }

    /// 반복 스타이너 한 단계. 버릇: GetWireLength 가 돌려주는 WireLength 는 **마지막** 후보의 길이다.
    pub fn Iterated_Steiner(&mut self, grid: &GlobalGrid, Pontential_Stiner_node: &mut Vec<i32>) -> Result<(), String> {
        // size_t - 2 를 int 로 (묶음이 0·1 개면 음수가 되어 돌지 않는다)
        let mut iterate_number = (self.Pin_terminals.len() as i64 - 2) as i32;
        let mut LastWireLength = i32::MAX;
        let mut WireLength = i32::MAX;
        let mut Flag = true;
        while iterate_number > 0 && Flag {
            let mut index = -1;
            self.GetWireLength(&mut WireLength, &mut index, Pontential_Stiner_node.clone(), grid)?;
            let DetailWireLength = LastWireLength.wrapping_sub(WireLength);
            if DetailWireLength > 0 {
                LastWireLength = WireLength;
                self.AddStinerNodeToTerminals(Pontential_Stiner_node, index);
            } else {
                Flag = false;
            }
            iterate_number -= 1;
        }
        Ok(())
    }

    /// index 번째 후보를 한 칸짜리 묶음으로 더하고 후보 목록에서 뺀다
    pub fn AddStinerNodeToTerminals(&mut self, Pontential_Stiner_node: &mut Vec<i32>, index: i32) {
        let mut Potential_node = Vec::new();
        for (i, &n) in Pontential_Stiner_node.iter().enumerate() {
            if i as i32 == index {
                self.Pin_terminals.push(vec![n]);
            } else {
                Potential_node.push(n);
            }
        }
        *Pontential_Stiner_node = Potential_node;
    }

    /// 후보마다 묶음으로 넣어 MST 길이를 재고, 가장 짧은 것의 번호를 index 에. WireLength 는 마지막 값으로 남는다.
    pub fn GetWireLength(&mut self, WireLength: &mut i32, index: &mut i32, Pontential_Stiner_node: Vec<i32>,
                         grid: &GlobalGrid) -> Result<(), String> {
        let mut Last_WireLength = i32::MAX;
        for (i, &n) in Pontential_Stiner_node.iter().enumerate() {
            self.Pin_terminals.push(vec![n]);
            let mut temp_path = Vec::new();
            self.MST(WireLength, &mut temp_path, grid)?;
            if *WireLength < Last_WireLength {
                Last_WireLength = *WireLength;
                *index = i as i32;
            }
            self.Pin_terminals.pop();
        }
        Ok(())
    }

    /// 0 번 묶음이 출발, 나머지가 도착 (정렬된 유일 칸)
    pub fn InitialSrcDest(&self, temp_src: &mut Vec<i32>, temp_dest: &mut Vec<i32>, pin_access: &mut Vec<i32>) {
        let mut src_set = BTreeSet::new();
        let mut dest_set = BTreeSet::new();
        for (i, g) in self.Pin_terminals.iter().enumerate() {
            if i == 0 {
                src_set.extend(g.iter().copied());
                pin_access.push(1);
            } else {
                dest_set.extend(g.iter().copied());
                pin_access.push(0);
            }
        }
        temp_src.extend(src_set);
        temp_dest.extend(dest_set);
    }

    /// 길이 닿은 묶음을 출발 쪽으로 옮기고, 길의 칸도 출발에 더한다
    pub fn ChangeSrcDest(&self, temp_src: &mut Vec<i32>, temp_dest: &mut Vec<i32>, temp_single_path: &[i32],
                         pin_access: &mut [i32]) {
        for &p in temp_single_path {
            for (j, g) in self.Pin_terminals.iter().enumerate() {
                for &k in g {
                    if p == k {
                        pin_access[j] = 1;
                    }
                }
            }
        }
        temp_src.clear();
        temp_dest.clear();
        let mut src_set = BTreeSet::new();
        let mut dest_set = BTreeSet::new();
        for (i, &a) in pin_access.iter().enumerate() {
            if a == 1 {
                src_set.extend(self.Pin_terminals[i].iter().copied());
            } else {
                dest_set.extend(self.Pin_terminals[i].iter().copied());
            }
        }
        src_set.extend(temp_single_path.iter().copied());
        temp_src.extend(src_set);
        temp_dest.extend(dest_set);
    }

    /// 이름과 달리 최소 신장 트리가 아니다: 0 번 묶음에서 시작해 다익스트라로 가장 가까운 묶음을 하나씩 잇는다.
    /// 길이 없으면 C++ 은 `std::runtime_error("Empty path")` 를 던진다 (모듈 전체가 멈춘다).
    pub fn MST(&mut self, WireLength: &mut i32, temp_path: &mut Vec<(i32, i32)>, grid: &GlobalGrid) -> Result<(), String> {
        let mut MST_path: Vec<Vec<i32>> = Vec::new();
        let mut temp_src = Vec::new();
        let mut temp_dest = Vec::new();
        let mut pin_access = Vec::new();
        self.InitialSrcDest(&mut temp_src, &mut temp_dest, &mut pin_access);
        if temp_dest.is_empty() {
            let s = *temp_src.first().ok_or_else(|| ub("MST: temp_src[0] (빈 출발)"))?;
            MST_path.push(vec![s]);
        }
        // 끝나지 않는 반복 알아보기: 닿은 묶음이 그대로인 동안 같은 출발 집합이 다시 나오면 C++ 은 영영 돈다
        // (그래프 번호가 칸 번호와 어긋나 칸이 D 로 읽힐 때 — Routing_Layers 제약에서만). 한 MST 안에서 다익스트라는
        // (출발, 도착) 만의 함수라 이 판정은 정확하다. C++ 은 MST_path 가 메모리를 다 먹을 때까지 돈다.
        let mut seen: BTreeSet<Vec<i32>> = BTreeSet::new();
        let mut naccess = pin_access.iter().filter(|&&a| a == 1).count();
        while !temp_dest.is_empty() {
            let src_set = temp_src.clone();
            let dest_set = temp_dest.clone();
            self.SetSrcDest(&src_set, &dest_set)?;
            let temp_single_path = self.dijkstra(grid)?;
            if temp_single_path.is_empty() {
                return Err("Empty path".into());
            }
            MST_path.push(temp_single_path.clone());
            self.RMSrcDest(&src_set, &dest_set)?;
            self.ChangeSrcDest(&mut temp_src, &mut temp_dest, &temp_single_path, &mut pin_access);
            let na = pin_access.iter().filter(|&&a| a == 1).count();
            if na != naccess {
                naccess = na;
                seen.clear();
            }
            if !seen.insert(temp_src.clone()) {
                return Err("GcellGlobalRouter: MST 가 끝나지 않는다 (C++ 은 메모리가 다할 때까지 돈다)".into());
            }
        }
        *WireLength = self.Calculate_Weight(&MST_path)?;
        *temp_path = Self::Get_MST_Edges(&MST_path);
        Ok(())
    }

    /// 이웃한 칸 쌍마다 처음 맞는 변의 무게를 더한다
    pub fn Calculate_Weight(&self, temp_path: &[Vec<i32>]) -> Result<i32, String> {
        let mut sum: i32 = 0;
        for p in temp_path {
            for j in 0..p.len().saturating_sub(1) {
                for e in &self.node(p[j])?.list {
                    if e.dest == p[j + 1] {
                        sum = sum.wrapping_add(e.weight);
                        break;
                    }
                }
            }
        }
        Ok(sum)
    }

    /// 토막마다 이웃 쌍. 칸 하나짜리 토막은 (t, t)
    pub fn Get_MST_Edges(temp_path: &[Vec<i32>]) -> Vec<(i32, i32)> {
        let mut temp_MST_Edges = Vec::new();
        for p in temp_path {
            if p.len() == 1 {
                temp_MST_Edges.push((p[0], p[0]));
            }
            for j in 0..p.len().saturating_sub(1) {
                temp_MST_Edges.push((p[j], p[j + 1]));
            }
        }
        temp_MST_Edges
    }

    /// 칸의 변 목록에서 그래프 마디 하나 (C++ 의 update_node 람다). `new` 면 CreateAdjacentList_New 의 층 거르기를 한다.
    fn update_node(grid: &GlobalGrid, tempNode: &mut Node, p: usize, temp_vector: &[tileEdge], layers: Option<(i32, i32)>) -> Result<(), String> {
        for te in temp_vector {
            if let Some((l_metal, h_metal)) = layers {
                if te.next == -1 {
                    continue;
                }
                let mut active = true;
                for &layer in &tile_at(grid, te.next)?.metal {
                    if layer < l_metal || layer > h_metal {
                        active = false;
                    }
                }
                if !active {
                    continue;
                }
            }
            if te.capacity > 0 && te.next != -1 {
                let (a, b) = (&grid.tiles_total[p], tile_at(grid, te.next)?);
                let weight = abs_sum(a.y.wrapping_sub(b.y), a.x.wrapping_sub(b.x));
                tempNode.list.push(Edge { dest: te.next, weight, capacity: te.capacity });
            }
        }
        Ok(())
    }

    /// 모든 칸으로 그래프 (생성자에서만)
    pub fn CreateAdjacentList(&mut self, grid: &GlobalGrid) -> Result<(), String> {
        let mut tempNode = Node::default();
        for i in 0..grid.tiles_total.len() {
            tempNode.list.clear();
            tempNode.src = i as i32;
            tempNode.metal_layer = grid.tiles_total[i].metal.clone();
            let t = &grid.tiles_total[i];
            for v in [&t.north, &t.south, &t.east, &t.west, &t.up, &t.down] {
                Self::update_node(grid, &mut tempNode, i, v, None)?;
            }
            self.graph.push(tempNode.clone());
        }
        self.push_source_dest();
        Ok(())
    }

    /// 넷마다: 층이 [l_metal, h_metal] 인 칸만 차례로 넣는다 (그래프 번호 = 켜진 칸의 차례, 변의 dest = 칸 번호).
    /// 변 순서 N, S, E, W, 위, 아래. 비아 변의 무게는 0.
    pub fn CreateAdjacentList_New(&mut self, grid: &GlobalGrid, l_metal: i32, h_metal: i32) -> Result<(), String> {
        self.graph.clear();
        let mut tempNode = Node::default();
        for i in 0..grid.tiles_total.len() {
            tempNode.list.clear();
            tempNode.src = i as i32;
            tempNode.metal_layer = grid.tiles_total[i].metal.clone();
            let mut active = true;
            for &layer in &tempNode.metal_layer {
                if layer < l_metal || layer > h_metal {
                    active = false;
                }
            }
            if !active {
                continue;
            }
            let t = &grid.tiles_total[i];
            for v in [&t.north, &t.south, &t.east, &t.west, &t.up, &t.down] {
                Self::update_node(grid, &mut tempNode, i, v, Some((l_metal, h_metal)))?;
            }
            self.graph.push(tempNode.clone());
        }
        self.push_source_dest();
        Ok(())
    }

    fn push_source_dest(&mut self) {
        self.source = self.graph.len() as i32;
        self.dest = self.source + 1;
        self.graph.push(Node { src: self.source, ..Default::default() });
        self.graph.push(Node { src: self.dest, ..Default::default() });
    }

    /// S -> 출발 칸, 출발 칸 -> S, D -> 도착 칸, 도착 칸 -> D (무게 0) 를 목록 끝에 붙인다
    pub fn SetSrcDest(&mut self, temp_src: &[i32], temp_dest: &[i32]) -> Result<(), String> {
        let (source, dest) = (self.source, self.dest);
        for &t in temp_src {
            self.node_mut(source)?.list.push(Edge { dest: t, weight: 0, capacity: 0 });
            self.node_mut(t)?.list.push(Edge { dest: source, weight: 0, capacity: 0 });
        }
        for &t in temp_dest {
            self.node_mut(dest)?.list.push(Edge { dest: t, weight: 0, capacity: 0 });
            self.node_mut(t)?.list.push(Edge { dest, weight: 0, capacity: 0 });
        }
        Ok(())
    }

    /// S, D 의 목록을 비우고, 칸마다 붙였던 수만큼 끝에서 뺀다
    pub fn RMSrcDest(&mut self, temp_src: &[i32], temp_dest: &[i32]) -> Result<(), String> {
        let (source, dest) = (self.source, self.dest);
        self.node_mut(source)?.list.clear();
        self.node_mut(dest)?.list.clear();
        for &t in temp_src.iter().chain(temp_dest) {
            if self.node_mut(t)?.list.pop().is_none() {
                return Err(ub(format!("graph[{t}].list.pop_back() (빈 목록)")));
            }
        }
        Ok(())
    }

    /// S 에서 D 까지. 열린 목록은 multimap<double,int> 그대로: 가장 작은 거리 가운데 먼저 넣은 것을 꺼내고,
    /// 더 짧아지면 지우고 그 거리의 맨 뒤에 다시 넣는다. 길은 S·D 를 뺀 마디들 (못 찾으면 빈 목록).
    pub fn dijkstra(&self, _grid: &GlobalGrid) -> Result<Vec<i32>, String> {
        let n = self.graph.len();
        let mut dist = vec![f64::from(i32::MAX); n];
        let mut parent = vec![-1i32; n];
        let mut status = vec![0i32; n];
        // (거리 키, 넣은 차례) -> 마디, 그리고 마디마다 지금 든 자리
        let mut distMap: BTreeMap<(u64, u64), i32> = BTreeMap::new();
        let mut slot: Vec<(u64, u64)> = vec![(0, 0); n];
        let mut seq: u64 = 0;
        let source = usize::try_from(self.source).map_err(|_| ub("dijkstra: source"))?;
        let dest = usize::try_from(self.dest).map_err(|_| ub("dijkstra: dest"))?;
        if source >= n || dest >= n {
            return Err(ub("dijkstra: source/dest 가 그래프 밖"));
        }
        dist[source] = 0.0;
        status[source] = 1;
        slot[source] = (fkey(0.0), seq);
        distMap.insert(slot[source], self.source);
        seq += 1;
        let mut count: i32 = 0;
        while status[dest] != 2 && count < n as i32 - 1 {
            // minDistancefromMultiMap: 빈 map 이면 (begin() 을 읽는 UB 뒤) 빈 목록 -> 경고하고 빈 길
            let Some((&k, &u)) = distMap.iter().next() else {
                return Ok(Vec::new());
            };
            // RemovefromMultMap(dist[u], u): 같은 거리 구간의 첫 u — 맨 앞 원소 그 자체다
            distMap.remove(&k);
            let u = u as usize;
            status[u] = 2;
            for e in &self.graph[u].list {
                let v = usize::try_from(e.dest).ok().filter(|&v| v < n).ok_or_else(|| ub(format!("dijkstra: dist[{}]", e.dest)))?;
                if v != u {
                    let nd = dist[u] + f64::from(e.weight);
                    if status[v] == 0 {
                        parent[v] = u as i32;
                        dist[v] = nd;
                        status[v] = 1;
                        slot[v] = (fkey(nd), seq);
                        seq += 1;
                        distMap.insert(slot[v], v as i32);
                    } else if status[v] == 1 && dist[v] > nd {
                        parent[v] = u as i32;
                        dist[v] = nd;
                        // UpdateMultMap: 옛 거리의 v 를 지우고 새 거리의 맨 뒤에 넣는다
                        distMap.remove(&slot[v]);
                        slot[v] = (fkey(nd), seq);
                        seq += 1;
                        distMap.insert(slot[v], v as i32);
                    }
                }
            }
            count += 1;
        }
        // printPath(parent, dest): D 에서 부모를 따라 S 까지, 거꾸로 — S·D 는 뺀다
        let mut chain = Vec::new();
        let mut j = self.dest;
        while j != -1 {
            if chain.len() > n {
                return Err(ub("dijkstra: parent 고리"));
            }
            chain.push(j);
            j = parent[j as usize];
        }
        // status[dest] != 2 이면 C++ 은 "feasible path might not be found" 를 남긴다 — D 가 가장 먼 마디라 횟수
        // 제한(마디 수 - 1)에 걸려 꺼내지 못했을 뿐 길은 멀쩡한 때가 흔해서 여기서는 남기지 않는다.
        Ok(chain.into_iter().rev().filter(|&j| !(j == self.source || j == self.dest)).collect())
    }

    pub fn setTerminals(&mut self, t: &[Vec<i32>]) {
        self.Pin_terminals = t.to_vec();
    }

    pub fn setterminals(&mut self, t: &[i32]) {
        self.terminals = t.to_vec();
    }

    pub fn returnPath(&self) -> Vec<Vec<(i32, i32)>> {
        self.Path.clone()
    }
}
