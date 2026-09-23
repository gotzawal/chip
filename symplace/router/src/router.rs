//! 협상 배선 (PathFinder 식). 넷마다 A* 로 덩이들을 잇고, 다른 넷과 겹친 노드(같은 노드나 트랙 위
//! 이웃 노드)에 값을 올려 겹친 넷만 다시 잇는다. 겹침이 없어지면 사각형으로 펴고(legal.rs),
//! 거기서 못 맞춘 토막이 있으면 그 자리에 값을 올려 또 돈다.

use crate::grid::Grid;
use crate::legal;
use crate::model::{Problem, Solution};
use crate::search::{Astar, Occ, Params, Query};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Default, Debug)]
pub struct Route {
    /// 배선이 쓰는 노드 (정렬, 중복 없음)
    pub nodes: Vec<u32>,
    /// 비아마다 아래층 노드
    pub vias: Vec<u32>,
    pub failed: bool,
}

#[derive(Clone, Debug)]
struct Comp {
    id: i32,
    nodes: Vec<u32>,
    bbox: [i32; 4],
}

const PRES0: i64 = 1000;
const HIST_STEP: i64 = 600;

/// 넷마다 배선층에서 닿을 수 있는 연결 덩이 (고정 도형이 덮고, 쓸 수 있는 노드들)
fn components(p: &Problem, grid: &Grid) -> (Vec<Vec<Comp>>, Vec<bool>) {
    let nn = p.nets.len();
    let mut by: Vec<BTreeMap<i32, Comp>> = vec![BTreeMap::new(); nn];
    for n in 0..grid.nodes() {
        let net = grid.cover_net[n];
        if net < 0 || !grid.usable(net, n as u32) {
            continue;
        }
        let (_, j, i) = grid.split(n as u32);
        let (x, y) = (grid.xs[i], grid.ys[j]);
        let c = by[net as usize].entry(grid.cover_comp[n]).or_insert(Comp { id: grid.cover_comp[n], nodes: Vec::new(), bbox: [x, y, x, y] });
        c.nodes.push(n as u32);
        c.bbox = [c.bbox[0].min(x), c.bbox[1].min(y), c.bbox[2].max(x), c.bbox[3].max(y)];
    }
    // 문제에 있는 덩이 중 배선층에서 안 보이는 것이 있으면 그 넷은 못 끝낸다
    let mut all: Vec<BTreeSet<i32>> = vec![BTreeSet::new(); nn];
    for s in &p.shapes {
        if s.net >= 0 && s.comp >= 0 {
            all[s.net as usize].insert(s.comp);
        }
    }
    let mut blind = vec![false; nn];
    for k in 0..nn {
        blind[k] = all[k].iter().any(|c| !by[k].contains_key(c));
    }
    (by.into_iter().map(|m| m.into_values().collect()).collect(), blind)
}

struct Ctx<'a> {
    grid: &'a Grid,
    occ: Occ,
    hist: Vec<i64>,
    par: Params,
    astar: Astar,
    mark: Vec<u32>,
    stamp: u32,
}

impl Ctx<'_> {
    fn route_net(&mut self, net: usize, comps: &[Comp]) -> Route {
        let mut r = Route::default();
        if comps.len() < 2 {
            return r;
        }
        let grid = self.grid;
        let start = (0..comps.len()).max_by_key(|&k| (comps[k].nodes.len(), std::cmp::Reverse(k))).unwrap();
        self.stamp += 1;
        let st = self.stamp;
        let mut tree: Vec<u32> = comps[start].nodes.clone();
        for &n in &tree {
            self.mark[n as usize] = st;
        }
        let mut remaining: Vec<usize> = (0..comps.len()).filter(|&k| k != start).collect();
        while !remaining.is_empty() {
            let boxes: Vec<[i32; 4]> = remaining.iter().map(|&k| comps[k].bbox).collect();
            let ids: Vec<i32> = remaining.iter().map(|&k| comps[k].id).collect();
            let found = {
                let mark = &self.mark;
                let is_target = |n: u32| grid.cover_net[n as usize] == net as i32 && ids.contains(&grid.cover_comp[n as usize]);
                let in_tree = |n: u32| mark[n as usize] == st;
                let q = Query { net, sources: &tree, in_tree: &in_tree, is_target: &is_target, boxes: &boxes, discount: None };
                self.astar.search(grid, &self.occ, &self.hist, &self.par, &q)
            };
            let Some(path) = found else {
                r.failed = true;
                break;
            };
            for w in path.windows(2) {
                let (la, _, _) = grid.split(w[0]);
                let (lb, _, _) = grid.split(w[1]);
                if la != lb {
                    r.vias.push(if la < lb { w[0] } else { w[1] });
                }
            }
            for &n in &path {
                r.nodes.push(n);
                if self.mark[n as usize] != st {
                    self.mark[n as usize] = st;
                    tree.push(n);
                }
            }
            let cid = grid.cover_comp[*path.last().unwrap() as usize];
            let k = remaining.iter().position(|&k| comps[k].id == cid).expect("목표 덩이");
            let ci = remaining.remove(k);
            for &n in &comps[ci].nodes {
                if self.mark[n as usize] != st {
                    self.mark[n as usize] = st;
                    tree.push(n);
                }
            }
        }
        r.nodes.sort_unstable();
        r.nodes.dedup();
        r.vias.sort_unstable();
        r.vias.dedup();
        r
    }
}

/// 다른 넷과 같은 노드나 트랙 위 이웃 노드를 쓰는 곳
fn conflicts(grid: &Grid, occ: &Occ, routes: &[Route], nets: &[usize]) -> (Vec<u32>, Vec<usize>) {
    let mut nodes = Vec::new();
    let mut bad = BTreeSet::new();
    for &net in nets {
        for &n in &routes[net].nodes {
            let mut hit = occ.other(net, n) > 0;
            for d in [-1, 1] {
                if let Some(a) = grid.along(n, d) {
                    hit |= occ.other(net, a) > 0;
                }
            }
            if hit {
                nodes.push(n);
                bad.insert(net);
            }
        }
    }
    (nodes, bad.into_iter().collect())
}

pub fn solve(p: &Problem) -> Result<Solution, String> {
    let grid = Grid::build(p)?;
    let nn = p.nets.len();
    let nodes = grid.nodes();
    let (comps, blind) = components(p, &grid);

    // 이을 넷: 덩이가 둘 이상. 짧은 넷부터 (덩이 전체 상자의 반둘레)
    let mut order: Vec<usize> = (0..nn).filter(|&k| comps[k].len() >= 2).collect();
    let span = |k: usize| {
        let b = comps[k].iter().fold([i32::MAX, i32::MAX, i32::MIN, i32::MIN], |a, c| {
            [a[0].min(c.bbox[0]), a[1].min(c.bbox[1]), a[2].max(c.bbox[2]), a[3].max(c.bbox[3])]
        });
        (b[2] - b[0]) as i64 + (b[3] - b[1]) as i64
    };
    order.sort_by_key(|&k| (p.nets[k].power, span(k), k));

    let unit = (0..grid.nl).map(|li| if grid.l0 + li == 0 { 30 } else { 10 }).collect();
    let mut cx = Ctx {
        grid: &grid,
        occ: Occ::new(nodes, nn),
        hist: vec![0; nodes],
        par: Params { unit, via: 1600, pres: PRES0 },
        astar: Astar::new(nodes),
        mark: vec![0; nodes],
        stamp: 0,
    };
    let mut routes: Vec<Route> = vec![Route::default(); nn];
    let max_iter = p.max_iter.max(1);
    let mut todo = order.clone();
    let mut sol = Solution::default();
    let mut leg = None;
    for iter in 1..=max_iter {
        sol.iterations = iter;
        for &net in &todo {
            for &n in &routes[net].nodes {
                cx.occ.remove(net, n);
            }
            routes[net] = cx.route_net(net, &comps[net]);
            for &n in &routes[net].nodes {
                cx.occ.add(net, n);
            }
        }
        let (cnodes, cnets) = conflicts(&grid, &cx.occ, &routes, &order);
        if cnets.is_empty() {
            let l = legal::legalize(p, &grid, &routes);
            if l.bad.is_empty() || iter == max_iter {
                leg = Some(l);
                break;
            }
            let mut again = BTreeSet::new();
            for &(n, net) in &l.bad {
                cx.hist[n as usize] += 4 * HIST_STEP;
                again.insert(net);
            }
            todo = again.into_iter().collect();
        } else {
            for n in cnodes {
                cx.hist[n as usize] += HIST_STEP;
            }
            cx.par.pres = (cx.par.pres * 3 / 2).min(PRES0 * 1000);
            todo = cnets;
        }
    }
    // 끝내 못 푼 것은 걷어낸다: 겹친 넷(SHORT 가 된다)과 규칙을 못 맞춘 넷은 배선을 지우고
    // 못 이은 넷으로 알린다. 합선보다 열린 넷이 낫다 — 검사기가 OPEN 으로 정직하게 보여 준다.
    let mut ripped = BTreeSet::new();
    let mut rip = |net: usize, routes: &mut Vec<Route>, occ: &mut Occ| {
        for &n in &routes[net].nodes {
            occ.remove(net, n);
        }
        routes[net] = Route { failed: true, ..Route::default() };
        ripped.insert(net);
    };
    let mut l = match leg {
        Some(l) if l.bad.is_empty() => l,
        _ => {
            loop {
                let (cnodes, _) = conflicts(&grid, &cx.occ, &routes, &order);
                if cnodes.is_empty() {
                    break;
                }
                // 겹친 노드가 가장 많은 넷부터
                let mut cnt: BTreeMap<usize, usize> = BTreeMap::new();
                for &n in &cnodes {
                    for &net in &order {
                        if cx.occ.has(net, n) {
                            *cnt.entry(net).or_default() += 1;
                        }
                    }
                }
                let worst = cnt.iter().max_by_key(|&(&net, &c)| (c, std::cmp::Reverse(net))).map(|(&net, _)| net).unwrap();
                rip(worst, &mut routes, &mut cx.occ);
            }
            loop {
                let l = legal::legalize(p, &grid, &routes);
                if l.bad.is_empty() {
                    break l;
                }
                let nets: BTreeSet<usize> = l.bad.iter().map(|&(_, net)| net).collect();
                for net in nets {
                    rip(net, &mut routes, &mut cx.occ);
                }
            }
        }
    };
    sol.violations = 0;
    sol.wires = std::mem::take(&mut l.wires);
    for k in 0..nn {
        if (comps[k].len() >= 2 && routes[k].failed) || (blind[k] && p.nets[k].parts >= 2) || ripped.contains(&k) {
            sol.failed.push(k as i32);
        }
    }
    sol.failed.sort_unstable();
    sol.failed.dedup();
    Ok(sol)
}
