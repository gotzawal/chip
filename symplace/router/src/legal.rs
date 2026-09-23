//! 노드 경로 -> 사각형. 트랙마다 토막(같은 넷이 이어 쓴 노드들)을 구간으로 펴고, 검사기의
//! 규칙을 맞춘다:
//!
//!   - 비아 둘러싸기    토막 끝을 노드에서 ext 만큼 넘긴다 (ext = 비아 반 폭 + 둘러싸기)
//!   - 끝단 간격        같은 넷끼리 e2e 보다 가까우면 메워 붙인다 (다른 넷은 경로 단계에서 이미 떨어져 있다)
//!   - 최소 길이        붙은 덩이(토막 + 닿은 같은 넷 고정 도형)가 짧으면 빈 쪽으로 늘린다
//!
//! 끝까지 못 맞춘 곳은 `bad` 로 돌려준다 — 협상 단계가 그 노드에 역사 비용을 얹고 다시 배선한다.

use crate::grid::Grid;
use crate::model::{Problem, VIA_BASE};
use crate::router::Route;

#[derive(Clone, Copy, Debug)]
struct Item {
    lo: i32,
    hi: i32,
    net: i32,
    /// 토막이면 그 토막의 노드 하나 (벌점 줄 자리), 고정 도형이면 None
    node: Option<u32>,
}

pub struct Legal {
    pub wires: Vec<[i32; 6]>,
    /// (노드, 넷) — 규칙을 못 맞춘 토막
    pub bad: Vec<(u32, usize)>,
}

pub fn legalize(p: &Problem, grid: &Grid, routes: &[Route]) -> Legal {
    let mut wires = Vec::new();
    let mut bad = Vec::new();
    // 트랙마다 (넷, 트랙 위 번호, 노드)
    let mut on_track: Vec<Vec<Vec<(i32, usize, u32)>>> =
        (0..grid.nl).map(|li| vec![Vec::new(); grid.tracks[li].len()]).collect();
    for (net, r) in routes.iter().enumerate() {
        for &n in &r.nodes {
            let (li, j, i) = grid.split(n);
            let (t, k) = if grid.vertical[li] { (i, j) } else { (j, i) };
            on_track[li][t].push((net as i32, k, n));
        }
    }
    for li in 0..grid.nl {
        let (ext, e2e, min_l, w) = (grid.ext[li], grid.e2e[li], grid.min_l[li], grid.width[li]);
        for t in 0..grid.tracks[li].len() {
            let mut rs = std::mem::take(&mut on_track[li][t]);
            if rs.is_empty() {
                continue;
            }
            rs.sort();
            let pos = |k: usize| if grid.vertical[li] { grid.ys[k] } else { grid.xs[k] };
            // 토막
            let mut items: Vec<Item> = grid.tracks[li][t].iter().map(|iv| Item { lo: iv.lo, hi: iv.hi, net: iv.net, node: None }).collect();
            let first_run = items.len();
            let mut a = 0;
            while a < rs.len() {
                let mut b = a;
                while b + 1 < rs.len() && rs[b + 1].0 == rs[a].0 && rs[b + 1].1 == rs[b].1 + 1 {
                    b += 1;
                }
                items.push(Item { lo: pos(rs[a].1) - ext, hi: pos(rs[b].1) + ext, net: rs[a].0, node: Some(rs[a].2) });
                a = b + 1;
            }
            // 같은 넷끼리 e2e 안이면 메운다 (토막을 늘려서). 넷마다 lo 순으로 보며 지금까지의 끝과 비교한다.
            let mut order: Vec<usize> = (0..items.len()).collect();
            order.sort_by_key(|&k| (items[k].net, items[k].lo, items[k].hi));
            let mut k0 = 0;
            while k0 < order.len() {
                let net = items[order[k0]].net;
                let mut k1 = k0;
                while k1 < order.len() && items[order[k1]].net == net {
                    k1 += 1;
                }
                if net >= 0 {
                    let mut end_at = order[k0];
                    for &y in &order[k0 + 1..k1] {
                        let (end, ylo) = (items[end_at].hi, items[y].lo);
                        if ylo > end && ylo - end < e2e {
                            if items[y].node.is_some() {
                                items[y].lo = end;
                            } else if items[end_at].node.is_some() {
                                items[end_at].hi = ylo;
                            }
                        }
                        if items[y].hi > items[end_at].hi {
                            end_at = y;
                        }
                    }
                }
                k0 = k1;
            }
            // 덩이(같은 넷이 겹치거나 닿은 것들)마다 최소 길이
            let mut order: Vec<usize> = (0..items.len()).collect();
            order.sort_by_key(|&k| (items[k].lo, items[k].hi));
            let mut clusters: Vec<Vec<usize>> = Vec::new();
            for &k in &order {
                let hit = clusters.iter_mut().rev().find(|c| {
                    let net = items[c[0]].net;
                    let hi = c.iter().map(|&q| items[q].hi).max().unwrap();
                    net == items[k].net && items[k].lo <= hi
                });
                match hit {
                    Some(c) => c.push(k),
                    None => clusters.push(vec![k]),
                }
            }
            for c in &clusters {
                let Some(&run) = c.iter().find(|&&k| items[k].node.is_some()) else { continue };
                let net = items[run].net;
                let lo = c.iter().map(|&k| items[k].lo).min().unwrap();
                let hi = c.iter().map(|&k| items[k].hi).max().unwrap();
                if hi - lo >= min_l {
                    continue;
                }
                let need = min_l - (hi - lo);
                // 다른 넷까지 남은 자리
                let left_lim = items.iter().filter(|it| it.net != net && it.hi <= lo).map(|it| it.hi + e2e).max().unwrap_or(i32::MIN / 2);
                let right_lim = items.iter().filter(|it| it.net != net && it.lo >= hi).map(|it| it.lo - e2e).min().unwrap_or(i32::MAX / 2);
                let (room_l, room_r) = ((lo - left_lim).max(0), (right_lim - hi).max(0));
                if room_l + room_r < need {
                    bad.push((items[run].node.unwrap(), net as usize));
                    continue;
                }
                let mut el = (need / 2).min(room_l);
                let mut er = need - el;
                if er > room_r {
                    er = room_r;
                    el = need - er;
                }
                items[run].lo = items[run].lo.min(lo - el);
                items[run].hi = items[run].hi.max(hi + er);
            }
            // 마지막 확인: 지금까지 가장 멀리 간 도형과 다른 넷이 e2e 안이면 벌점
            let mut order: Vec<usize> = (0..items.len()).collect();
            order.sort_by_key(|&k| (items[k].lo, items[k].hi));
            let mut far: Option<usize> = None;
            for &k in &order {
                if let Some(f) = far {
                    let (x, y) = (items[f], items[k]);
                    if x.net != y.net && y.lo - x.hi < e2e {
                        for it in [x, y] {
                            if let Some(n) = it.node {
                                bad.push((n, it.net as usize));
                            }
                        }
                    }
                }
                if far.map_or(true, |f| items[k].hi > items[f].hi) {
                    far = Some(k);
                }
            }
            // 사각형
            let layer = (grid.l0 + li) as i32;
            for it in &items[first_run..] {
                let r = if grid.vertical[li] {
                    let x = grid.xs[t];
                    [x - w / 2, it.lo, x + w / 2, it.hi]
                } else {
                    let y = grid.ys[t];
                    [it.lo, y - w / 2, it.hi, y + w / 2]
                };
                wires.push([layer, it.net, r[0], r[1], r[2], r[3]]);
            }
        }
    }
    // 비아
    for (net, r) in routes.iter().enumerate() {
        for &n in &r.vias {
            let (li, j, i) = grid.split(n);
            let lower = grid.l0 + li;
            let Some(k) = p.vias.iter().position(|v| v.lower == lower && v.upper == lower + 1) else { continue };
            let (wx, wy) = (p.vias[k].wx, p.vias[k].wy);
            let (x, y) = (grid.xs[i], grid.ys[j]);
            wires.push([VIA_BASE + k as i32, net as i32, x - wx / 2, y - wy / 2, x + wx / 2, y + wy / 2]);
        }
    }
    bad.sort();
    bad.dedup();
    Legal { wires, bad }
}
