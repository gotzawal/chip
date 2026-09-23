//! A* — 넷의 트리(이미 이은 고정 도형 + 배선)에서 아직 안 이은 덩이까지.
//!
//! 상태는 (노드, k). k = 0 은 "비아로 막 내려앉아 이 층의 토막이 노드 하나뿐", k = 1 은 "토막이
//! 두 노드 이상이거나 같은 넷의 고정 도형 위". 비아는 k = 1 에서만 뜬다 — 한 노드짜리 토막은
//! 최소 길이까지 늘릴 자리가 보장되지 않아서다 (두 노드면 이웃 넷과 한 노드씩 띄우는 규칙만으로
//! 늘릴 자리가 늘 있다 — legal.rs).

use crate::grid::Grid;
use std::cmp::Reverse;
use std::collections::BinaryHeap;

/// 노드를 쓰는 넷 수와 넷마다 쓰는 노드.
pub struct Occ {
    pub count: Vec<u16>,
    words: usize,
    mine: Vec<Vec<u64>>,
}

impl Occ {
    pub fn new(nodes: usize, nets: usize) -> Occ {
        let words = nodes.div_ceil(64);
        Occ { count: vec![0; nodes], words, mine: vec![Vec::new(); nets] }
    }
    #[inline]
    pub fn has(&self, net: usize, n: u32) -> bool {
        let m = &self.mine[net];
        !m.is_empty() && (m[n as usize >> 6] >> (n & 63)) & 1 == 1
    }
    pub fn add(&mut self, net: usize, n: u32) {
        if self.mine[net].is_empty() {
            self.mine[net] = vec![0; self.words];
        }
        if !self.has(net, n) {
            self.mine[net][n as usize >> 6] |= 1 << (n & 63);
            self.count[n as usize] += 1;
        }
    }
    pub fn remove(&mut self, net: usize, n: u32) {
        if self.has(net, n) {
            self.mine[net][n as usize >> 6] &= !(1 << (n & 63));
            self.count[n as usize] -= 1;
        }
    }
    /// 이 넷 말고 노드를 쓰는 넷 수
    #[inline]
    pub fn other(&self, net: usize, n: u32) -> i64 {
        self.count[n as usize] as i64 - self.has(net, n) as i64
    }
}

pub struct Params {
    /// 층마다 길이 1 당 비용
    pub unit: Vec<i64>,
    pub via: i64,
    /// 다른 넷과 겹칠 때 (같은 노드 또는 트랙 위 이웃 노드) 한 넷당 비용
    pub pres: i64,
}

const NONE: u32 = u32::MAX;

pub struct Astar {
    g: Vec<i64>,
    prev: Vec<u32>,
    seen: Vec<u32>,
    closed: Vec<u32>,
    stamp: u32,
    heap: BinaryHeap<Reverse<(i64, i64, u32)>>,
}

/// 겹침 비용: 노드와 트랙 위 두 이웃을 다른 넷이 쓰는 만큼 + 역사 비용
#[inline]
pub fn congestion(grid: &Grid, occ: &Occ, hist: &[i64], net: usize, pres: i64, n: u32) -> i64 {
    let mut c = occ.other(net, n);
    if let Some(a) = grid.along(n, -1) {
        c += occ.other(net, a);
    }
    if let Some(b) = grid.along(n, 1) {
        c += occ.other(net, b);
    }
    c * pres + hist[n as usize]
}

pub struct Query<'a> {
    pub net: usize,
    pub sources: &'a [u32],
    /// 트리 위의 노드인가 (비아로 내려앉아도 토막이 짧지 않다)
    pub in_tree: &'a dyn Fn(u32) -> bool,
    pub is_target: &'a dyn Fn(u32) -> bool,
    /// 목표 덩이들의 좌표 상자 (추정 거리)
    pub boxes: &'a [[i32; 4]],
    /// 노드마다 덤 비용 (대칭 경로를 권할 때 음수 아닌 값으로 깎는다) — 없으면 0
    pub discount: Option<&'a dyn Fn(u32) -> i64>,
}

impl Astar {
    pub fn new(nodes: usize) -> Astar {
        let s = nodes * 2;
        Astar { g: vec![0; s], prev: vec![NONE; s], seen: vec![0; s], closed: vec![0; s], stamp: 0, heap: BinaryHeap::new() }
    }

    /// 찾으면 노드 경로 (출발 노드 .. 목표 노드)
    pub fn search(&mut self, grid: &Grid, occ: &Occ, hist: &[i64], par: &Params, q: &Query) -> Option<Vec<u32>> {
        self.stamp = self.stamp.wrapping_add(1);
        if self.stamp == 0 {
            self.seen.fill(0);
            self.closed.fill(0);
            self.stamp = 1;
        }
        let st = self.stamp;
        self.heap.clear();
        let net = q.net as i32;
        let min_unit = *par.unit.iter().min().unwrap();
        let h = |n: u32| -> i64 {
            let (_, j, i) = grid.split(n);
            let (x, y) = (grid.xs[i], grid.ys[j]);
            let mut best = i64::MAX;
            for b in q.boxes {
                let dx = if x < b[0] { b[0] - x } else if x > b[2] { x - b[2] } else { 0 };
                let dy = if y < b[1] { b[1] - y } else if y > b[3] { y - b[3] } else { 0 };
                best = best.min((dx + dy) as i64);
            }
            if best == i64::MAX { 0 } else { best * min_unit }
        };
        for &n in q.sources {
            let s = n * 2 + 1;
            if self.seen[s as usize] == st {
                continue;
            }
            self.seen[s as usize] = st;
            self.g[s as usize] = 0;
            self.prev[s as usize] = NONE;
            let hv = h(n);
            self.heap.push(Reverse((hv, hv, s)));
        }
        while let Some(Reverse((_, _, s))) = self.heap.pop() {
            let su = s as usize;
            if self.closed[su] == st {
                continue;
            }
            self.closed[su] = st;
            let n = s / 2;
            let k = s % 2;
            let g0 = self.g[su];
            if self.prev[su] != NONE && (q.is_target)(n) {
                let mut path = vec![n];
                let mut c = self.prev[su];
                while c != NONE {
                    let cn = c / 2;
                    if *path.last().unwrap() != cn {
                        path.push(cn);
                    }
                    c = self.prev[c as usize];
                }
                path.reverse();
                return Some(path);
            }
            let (li, j, i) = grid.split(n);
            let mut relax = |s2: u32, cost: i64, heap: &mut BinaryHeap<Reverse<(i64, i64, u32)>>| {
                let s2u = s2 as usize;
                let g2 = g0 + cost;
                if self.closed[s2u] == st {
                    return;
                }
                if self.seen[s2u] != st || g2 < self.g[s2u] {
                    self.seen[s2u] = st;
                    self.g[s2u] = g2;
                    self.prev[s2u] = s;
                    let hv = h(s2 / 2);
                    heap.push(Reverse((g2 + hv, hv, s2)));
                }
            };
            // 트랙을 따라
            for d in [-1, 1] {
                if let Some(n2) = grid.along(n, d) {
                    if !grid.usable(net, n2) {
                        continue;
                    }
                    let (_, j2, i2) = grid.split(n2);
                    let dist = if grid.vertical[li] { (grid.ys[j2] - grid.ys[j]).abs() } else { (grid.xs[i2] - grid.xs[i]).abs() } as i64;
                    let mut cost = dist * par.unit[li] + congestion(grid, occ, hist, q.net, par.pres, n2);
                    if let Some(dc) = q.discount {
                        cost = (cost - dc(n2)).max(1);
                    }
                    relax(n2 * 2 + 1, cost, &mut self.heap);
                }
            }
            // 비아 (토막이 두 노드 이상일 때만)
            if k == 1 {
                for dl in [-1i32, 1] {
                    let l2 = li as i32 + dl;
                    if l2 < 0 || l2 >= grid.nl as i32 {
                        continue;
                    }
                    let l2 = l2 as usize;
                    if !grid.via_ok(li.min(l2), i, j, net) {
                        continue;
                    }
                    let n2 = grid.node(l2, i, j);
                    if !grid.usable(net, n2) {
                        continue;
                    }
                    let k2 = if grid.covered_by(net, n2) || (q.in_tree)(n2) { 1 } else { 0 };
                    let mut cost = par.via + congestion(grid, occ, hist, q.net, par.pres, n2);
                    if let Some(dc) = q.discount {
                        cost = (cost - dc(n2)).max(1);
                    }
                    relax(n2 * 2 + k2, cost, &mut self.heap);
                }
            }
        }
        None
    }
}
