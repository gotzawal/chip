//! 격자와 고정 도형.
//!
//! 배선층(lmin..=lmax)의 노드는 (층, i, j) 이고 좌표는 (xs[i], ys[j]) — 세로층의 트랙 x 와
//! 가로층의 트랙 y 가 만나는 점이다. 이 PDK 에서는 M1/M3 가 x = 80k, M2/M4 가 y = 84k 라
//! 네 층이 같은 격자를 쓴다.
//!
//! 검사기(src/route/check.mjs = ALIGN cell_fabric)는 **같은 트랙(같은 층, 같은 중심선) 위의
//! 도형끼리만** 본다: 다른 넷이 닿으면 SHORT, 틈이 끝단 간격(e2e)보다 작으면 DRC, 합친 길이가
//! 최소 길이(minL)보다 짧으면 DRC. 그래서 트랙마다 구간 목록을 들고 있으면 된다.
//!
//! 노드를 넷 N 이 쓰면, 그 자리 금속은 적어도 [c - ext, c + ext] 이다 (ext = 비아 반 폭 + 둘러싸기).
//! 다른 넷의 고정 도형이 그 금속에서 e2e 안에 있으면 N 은 그 노드를 못 쓴다 (`usable`).

use crate::model::{Problem, VIA_BASE};

#[derive(Clone, Copy, Debug)]
pub struct Iv {
    pub lo: i32,
    pub hi: i32,
    /// 넷 (-1 은 넷 없음, -2 는 트랙 밖에 걸친 도형 — 누구도 못 붙는다)
    pub net: i32,
    pub comp: i32,
}

pub struct Grid {
    /// 첫 배선층의 금속 번호 (M1 = 0)
    pub l0: usize,
    pub nl: usize,
    pub ni: usize,
    pub nj: usize,
    pub xs: Vec<i32>,
    pub ys: Vec<i32>,
    pub vertical: Vec<bool>,
    pub width: Vec<i32>,
    pub ext: Vec<i32>,
    pub e2e: Vec<i32>,
    pub min_l: Vec<i32>,
    /// 층 li 와 li+1 사이 비아의 (wx, wy)
    pub via_size: Vec<(i32, i32)>,
    /// tracks[li][t] — 트랙 위 고정 도형 구간, lo 순
    pub tracks: Vec<Vec<Vec<Iv>>>,
    /// 노드마다: 좌표를 덮는 고정 도형의 넷·덩이 (-1 없음, -2 여러 넷)
    pub cover_net: Vec<i32>,
    pub cover_comp: Vec<i32>,
    /// 덮이지 않은 노드: [c-ext-e2e, c+ext+e2e] 안에 든 고정 도형의 넷 (-1 없음, -2 둘 이상)
    pub near: Vec<i32>,
    /// 덮인 노드: 둘러싸기만큼 금속을 늘리면 다른 넷에 e2e 안으로 붙는가
    pub ext_block: Vec<bool>,
    /// via_fixed[li][j * ni + i] — 층 li 와 li+1 사이 고정 비아의 넷 (-1 없음, -2 여러 넷)
    pub via_fixed: Vec<Vec<i32>>,
}

impl Grid {
    #[inline]
    pub fn node(&self, li: usize, i: usize, j: usize) -> u32 {
        ((li * self.nj + j) * self.ni + i) as u32
    }
    #[inline]
    pub fn split(&self, n: u32) -> (usize, usize, usize) {
        let n = n as usize;
        let i = n % self.ni;
        let r = n / self.ni;
        (r / self.nj, r % self.nj, i)
    }
    pub fn nodes(&self) -> usize {
        self.nl * self.nj * self.ni
    }
    /// 노드가 놓인 트랙 번호와 트랙 방향 좌표
    #[inline]
    pub fn track_pos(&self, li: usize, i: usize, j: usize) -> (usize, i32) {
        if self.vertical[li] { (i, self.ys[j]) } else { (j, self.xs[i]) }
    }
    /// 트랙 방향으로 이웃한 노드 (없으면 None)
    #[inline]
    pub fn along(&self, n: u32, dir: i32) -> Option<u32> {
        let (li, j, i) = self.split(n);
        if self.vertical[li] {
            let j2 = j as i64 + dir as i64;
            if j2 < 0 || j2 >= self.nj as i64 { None } else { Some(self.node(li, i, j2 as usize)) }
        } else {
            let i2 = i as i64 + dir as i64;
            if i2 < 0 || i2 >= self.ni as i64 { None } else { Some(self.node(li, i2 as usize, j)) }
        }
    }
    /// 넷 net 이 노드 n 을 쓸 수 있는가 (고정 도형 기준)
    #[inline]
    pub fn usable(&self, net: i32, n: u32) -> bool {
        let n = n as usize;
        let c = self.cover_net[n];
        if c >= 0 {
            c == net && !self.ext_block[n]
        } else if c == -2 {
            false
        } else {
            self.near[n] == -1 || self.near[n] == net
        }
    }
    #[inline]
    pub fn covered_by(&self, net: i32, n: u32) -> bool {
        self.cover_net[n as usize] == net
    }
    /// 층 li 와 li+1 사이, (i, j) 에 넷 net 의 비아를 둘 수 있는가 (고정 비아 기준)
    #[inline]
    pub fn via_ok(&self, li: usize, i: usize, j: usize, net: i32) -> bool {
        let v = self.via_fixed[li][j * self.ni + i];
        v == -1 || v == net
    }

    pub fn build(p: &Problem) -> Result<Grid, String> {
        let l0 = p.lmin;
        let nl = p.lmax - p.lmin + 1;
        let ls = &p.layers[l0..=p.lmax];
        let vert: Vec<&crate::model::Layer> = ls.iter().filter(|l| l.vertical).collect();
        let horz: Vec<&crate::model::Layer> = ls.iter().filter(|l| !l.vertical).collect();
        if vert.is_empty() || horz.is_empty() {
            return Err("배선층에 가로층과 세로층이 다 있어야 한다".into());
        }
        let (xp, xo) = (vert[0].pitch, vert[0].offset);
        let (yp, yo) = (horz[0].pitch, horz[0].offset);
        if vert.iter().any(|l| l.pitch != xp || l.offset != xo) || horz.iter().any(|l| l.pitch != yp || l.offset != yo) {
            return Err("배선층끼리 트랙 간격이 달라 한 격자에 못 싣는다 (배선층 범위를 줄인다)".into());
        }
        let ceil_div = |a: i32, b: i32| -> i32 { (a as i64).div_euclid(b as i64) as i32 + if (a as i64).rem_euclid(b as i64) != 0 { 1 } else { 0 } };
        let floor_div = |a: i32, b: i32| -> i32 { (a as i64).div_euclid(b as i64) as i32 };
        let [ax0, ay0, ax1, ay1] = p.area;
        let (i0, i1) = (ceil_div(ax0 - xo, xp), floor_div(ax1 - xo, xp));
        let (j0, j1) = (ceil_div(ay0 - yo, yp), floor_div(ay1 - yo, yp));
        if i1 < i0 || j1 < j0 {
            return Err("배선 영역이 비었다".into());
        }
        let xs: Vec<i32> = (i0..=i1).map(|k| xo + xp * k).collect();
        let ys: Vec<i32> = (j0..=j1).map(|k| yo + yp * k).collect();
        let (ni, nj) = (xs.len(), ys.len());

        // 층마다 비아 둘러싸기 반 폭: 이 층을 아래·위로 쓰는 비아 중 큰 것
        let mut ext = vec![0; nl];
        let mut via_size = vec![(0, 0); nl.saturating_sub(1)];
        for v in &p.vias {
            for (m, enc) in [(v.lower, v.enc_l), (v.upper, v.enc_h)] {
                if m >= l0 && m <= p.lmax {
                    let li = m - l0;
                    let half = if ls[li].vertical { v.wy / 2 } else { v.wx / 2 };
                    ext[li] = ext[li].max(half + enc);
                }
            }
            if v.lower >= l0 && v.upper <= p.lmax && v.upper == v.lower + 1 {
                via_size[v.lower - l0] = (v.wx, v.wy);
            }
        }
        for li in 0..nl {
            if ext[li] == 0 {
                ext[li] = ls[li].width / 2;
            }
        }

        let mut g = Grid {
            l0,
            nl,
            ni,
            nj,
            xs,
            ys,
            vertical: ls.iter().map(|l| l.vertical).collect(),
            width: ls.iter().map(|l| l.width).collect(),
            ext,
            e2e: ls.iter().map(|l| l.e2e).collect(),
            min_l: ls.iter().map(|l| l.min_l).collect(),
            via_size,
            tracks: (0..nl).map(|li| vec![Vec::new(); if ls[li].vertical { ni } else { nj }]).collect(),
            cover_net: Vec::new(),
            cover_comp: Vec::new(),
            near: Vec::new(),
            ext_block: Vec::new(),
            via_fixed: vec![vec![-1; ni * nj]; nl.saturating_sub(1)],
        };

        // --- 고정 금속 -> 트랙 구간 ---
        for s in &p.shapes {
            if s.layer < 0 || s.layer >= VIA_BASE {
                continue;
            }
            let m = s.layer as usize;
            if m < l0 || m > p.lmax {
                continue;
            }
            let li = m - l0;
            let [x0, y0, x1, y1] = s.r;
            let (a0, a1, lo, hi, pos) = if g.vertical[li] { (x0, x1, y0, y1, &g.xs) } else { (y0, y1, x0, x1, &g.ys) };
            let w = g.width[li];
            let pitch = if g.vertical[li] { xp } else { yp };
            let space = pitch - w;
            let exact = if a1 - a0 == w { pos.iter().position(|&c| 2 * c == a0 + a1) } else { None };
            if let Some(t) = exact {
                g.tracks[li][t].push(Iv { lo, hi, net: s.net, comp: s.comp });
            } else {
                // 트랙 밖이거나 폭이 다른 도형: 물리적으로 닿거나 간격을 못 지키는 트랙을 다 막는다
                for (t, &c) in pos.iter().enumerate() {
                    if a0 < c + w / 2 + space && a1 > c - w / 2 - space {
                        g.tracks[li][t].push(Iv { lo, hi, net: -2, comp: -1 });
                    }
                }
            }
        }
        for tl in g.tracks.iter_mut() {
            for tr in tl.iter_mut() {
                tr.sort_by_key(|iv| (iv.lo, iv.hi));
            }
        }

        // --- 노드마다 고정 도형과의 관계 ---
        let nn = g.nodes();
        g.cover_net = vec![-1; nn];
        g.cover_comp = vec![-1; nn];
        g.near = vec![-1; nn];
        g.ext_block = vec![false; nn];
        for li in 0..nl {
            let (ext, e2e) = (g.ext[li], g.e2e[li]);
            for j in 0..nj {
                for i in 0..ni {
                    let n = g.node(li, i, j) as usize;
                    let (t, c) = g.track_pos(li, i, j);
                    let tr = &g.tracks[li][t];
                    // 덮는 도형
                    let mut cov: Option<Iv> = None;
                    let mut multi = false;
                    for iv in tr.iter().filter(|iv| iv.lo <= c && c <= iv.hi) {
                        match cov {
                            None => cov = Some(*iv),
                            Some(o) if o.net != iv.net || iv.net < 0 => multi = true,
                            _ => {}
                        }
                    }
                    if multi || cov.map_or(false, |iv| iv.net < 0) {
                        g.cover_net[n] = -2;
                        continue;
                    }
                    if let Some(cv) = cov {
                        g.cover_net[n] = cv.net;
                        g.cover_comp[n] = cv.comp;
                        let (mlo, mhi) = (cv.lo.min(c - ext), cv.hi.max(c + ext));
                        g.ext_block[n] = tr.iter().any(|iv| iv.net != cv.net && iv.lo < mhi + e2e && iv.hi > mlo - e2e);
                        continue;
                    }
                    // 덮이지 않음: 창 안의 넷
                    let (wlo, whi) = (c - ext - e2e, c + ext + e2e);
                    let mut near = -1;
                    for iv in tr.iter().filter(|iv| iv.lo < whi && iv.hi > wlo) {
                        near = if iv.net < 0 { -2 } else if near == -1 || near == iv.net { iv.net } else { -2 };
                        if near == -2 {
                            break;
                        }
                    }
                    g.near[n] = near;
                }
            }
        }

        // --- 고정 비아 ---
        for s in &p.shapes {
            if s.layer < VIA_BASE {
                continue;
            }
            let k = (s.layer - VIA_BASE) as usize;
            let Some(v) = p.vias.get(k) else { continue };
            if v.lower < l0 || v.upper > p.lmax || v.upper != v.lower + 1 {
                continue;
            }
            let li = v.lower - l0;
            let [x0, y0, x1, y1] = s.r;
            let (cx2, cy2) = (x0 + x1, y0 + y1);
            let at = g.xs.iter().position(|&x| 2 * x == cx2).zip(g.ys.iter().position(|&y| 2 * y == cy2));
            match at {
                Some((i, j)) => {
                    let slot = &mut g.via_fixed[li][j * ni + i];
                    *slot = if *slot == -1 || *slot == s.net { s.net } else { -2 };
                }
                None => {
                    // 노드에 안 앉은 비아: 간격 안에 드는 노드를 다 막는다
                    for j in 0..nj {
                        for i in 0..ni {
                            let (x, y) = (g.xs[i], g.ys[j]);
                            if x0 < x + v.wx / 2 + v.space_x && x1 > x - v.wx / 2 - v.space_x
                                && y0 < y + v.wy / 2 + v.space_y && y1 > y - v.wy / 2 - v.space_y
                            {
                                g.via_fixed[li][j * ni + i] = -2;
                            }
                        }
                    }
                }
            }
        }
        Ok(g)
    }
}
