//! 대칭 넷 — SymmetricNets 쌍의 한쪽(앞선 넷)을 배선한 뒤, 다른 쪽은 그 거울상을 먼저 해 본다.
//!
//! 거울상이 그대로 되려면: 거울로 옮긴 노드가 모두 격자 위에 있고 그 넷이 쓸 수 있으며(고정 도형
//! 기준), 비아 자리가 비었고, 다른 넷과 겹치지 않고, 그 넷의 덩이를 전부 잇고, 비아마다 토막이
//! 두 노드 이상이거나 고정 도형 위여야 한다 (search.rs 의 규칙). 하나라도 어긋나면 거울 노드에
//! 값을 깎아 주는 A* 로 비슷하게 잇는다 — 한 소자 안에서 대칭인 넷(차동쌍의 DA/DB)은 리프 도형이
//! 거울상이 아니어서 보통 이쪽이다.

use crate::grid::Grid;
use crate::model::Problem;
use crate::router::Route;
use crate::search::Occ;

#[derive(Clone, Copy, Debug)]
pub struct Pair {
    pub leader: usize,
    pub follower: usize,
    /// 축 좌표의 2 배 (세로축이면 x, 가로축이면 y)
    pub axis2: i32,
    pub vertical_axis: bool,
}

/// 문제의 대칭 넷 쌍. order 에서 앞선 쪽이 이끈다.
pub fn pairs(p: &Problem, order: &[usize]) -> Vec<Pair> {
    let pos = |k: usize| order.iter().position(|&x| x == k);
    let mut out = Vec::new();
    for (a, net) in p.nets.iter().enumerate() {
        let b = net.sym;
        if b < 0 || (b as usize) <= a || net.sym_dir == 0 {
            continue;
        }
        let b = b as usize;
        let (Some(pa), Some(pb)) = (pos(a), pos(b)) else { continue };
        let (leader, follower) = if pa <= pb { (a, b) } else { (b, a) };
        out.push(Pair { leader, follower, axis2: net.axis2, vertical_axis: net.sym_dir == 1 });
    }
    out
}

/// 노드의 거울상 (격자 밖이면 None)
pub fn mirror(grid: &Grid, pr: &Pair, n: u32) -> Option<u32> {
    let (li, j, i) = grid.split(n);
    let find = |v: &[i32], c: i32| -> Option<usize> {
        let (first, step) = (v[0], if v.len() > 1 { v[1] - v[0] } else { 1 });
        if step <= 0 || (c - first) % step != 0 {
            return None;
        }
        let k = (c - first) / step;
        if k < 0 || k as usize >= v.len() { None } else { Some(k as usize) }
    };
    if pr.vertical_axis {
        Some(grid.node(li, find(&grid.xs, pr.axis2 - grid.xs[i])?, j))
    } else {
        Some(grid.node(li, i, find(&grid.ys, pr.axis2 - grid.ys[j])?))
    }
}

/// 앞선 넷이 이 노드를 쓰면 그 거울상이 자기와 겹치는가 (같은 노드이거나 같은 트랙의 이웃 노드).
/// 축을 가로지르거나 축에 붙은 경로는 거울로 옮길 수 없다 — 앞선 넷은 이런 노드를 피하게 한다.
pub fn self_clash(grid: &Grid, pr: &Pair, n: u32) -> bool {
    let (li, j, i) = grid.split(n);
    let Some(m) = mirror(grid, pr, n) else { return false };
    if m == n {
        return true;
    }
    let (_, j2, i2) = grid.split(m);
    // 같은 트랙 위 이웃이면 겹친다
    if grid.vertical[li] { i2 == i && j2.abs_diff(j) <= 1 } else { j2 == j && i2.abs_diff(i) <= 1 }
}

/// 앞선 넷 경로의 거울상을 넷 net 의 경로로 쓸 수 있으면 돌려준다.
/// comps 는 net 의 덩이마다 (덩이 번호, 노드들).
pub fn try_mirror(grid: &Grid, occ: &Occ, pr: &Pair, lead: &Route, net: usize, comps: &[(i32, Vec<u32>)]) -> Option<Route> {
    let ni = net as i32;
    let mut nodes = Vec::with_capacity(lead.nodes.len());
    for &n in &lead.nodes {
        let m = mirror(grid, pr, n)?;
        if !grid.usable(ni, m) {
            return None;
        }
        nodes.push(m);
    }
    nodes.sort_unstable();
    let has = |n: u32| nodes.binary_search(&n).is_ok();
    let mut vias = Vec::with_capacity(lead.vias.len());
    for &v in &lead.vias {
        let m = mirror(grid, pr, v)?;
        let (li, j, i) = grid.split(m);
        if !grid.via_ok(li, i, j, ni) {
            return None;
        }
        // 비아 양끝 토막: 두 노드 이상이거나 고정 도형 위
        for e in [m, grid.node(li + 1, i, j)] {
            let run = grid.along(e, -1).is_some_and(|a| has(a)) || grid.along(e, 1).is_some_and(|a| has(a));
            if !run && !grid.covered_by(ni, e) {
                return None;
            }
        }
        vias.push(m);
    }
    vias.sort_unstable();
    // 다른 넷과 겹치지 않는다 (같은 노드, 트랙 위 이웃)
    for &n in &nodes {
        if occ.other(net, n) > 0 {
            return None;
        }
        for d in [-1, 1] {
            if grid.along(n, d).is_some_and(|a| occ.other(net, a) > 0) {
                return None;
            }
        }
    }
    // 넷의 덩이를 전부 잇는가 (노드 + 덩이를 한 묶음으로)
    let nc = comps.len();
    let mut dad: Vec<usize> = (0..nodes.len() + nc).collect();
    fn root(d: &mut [usize], mut x: usize) -> usize {
        while d[x] != x {
            d[x] = d[d[x]];
            x = d[x];
        }
        x
    }
    let join = |d: &mut Vec<usize>, a: usize, b: usize| {
        let (ra, rb) = (root(d, a), root(d, b));
        if ra != rb {
            d[ra] = rb;
        }
    };
    let idx = |n: u32| nodes.binary_search(&n).ok();
    for (k, &n) in nodes.iter().enumerate() {
        if let Some(a) = grid.along(n, 1).and_then(idx) {
            join(&mut dad, k, a);
        }
        if grid.cover_net[n as usize] == ni {
            if let Some(c) = comps.iter().position(|(id, _)| *id == grid.cover_comp[n as usize]) {
                join(&mut dad, k, nodes.len() + c);
            }
        }
    }
    for &v in &vias {
        let (li, j, i) = grid.split(v);
        if let (Some(a), Some(b)) = (idx(v), idx(grid.node(li + 1, i, j))) {
            join(&mut dad, a, b);
        }
    }
    let r0 = root(&mut dad, nodes.len());
    if (1..nc).any(|c| root(&mut dad, nodes.len() + c) != r0) {
        return None;
    }
    Some(Route { nodes, vias, failed: false })
}

/// 따르는 넷의 경로가 앞선 넷 경로의 거울상 그대로인가
pub fn is_mirror(grid: &Grid, pr: &Pair, lead: &Route, fol: &Route) -> bool {
    if lead.failed || fol.failed || lead.nodes.is_empty() || lead.nodes.len() != fol.nodes.len() || lead.vias.len() != fol.vias.len() {
        return false;
    }
    let mut m: Vec<u32> = match lead.nodes.iter().map(|&n| mirror(grid, pr, n)).collect() {
        Some(v) => v,
        None => return false,
    };
    m.sort_unstable();
    let mut v: Vec<u32> = match lead.vias.iter().map(|&n| mirror(grid, pr, n)).collect() {
        Some(v) => v,
        None => return false,
    };
    v.sort_unstable();
    m == fol.nodes && v == fol.vias
}
