//! 배선 문제 — JS(src/route/router.mjs)가 Int32Array 로 넘기는 것을 읽는다.
//!
//! ```text
//! 머리      [MAGIC, nLayers, nVias, nNets, nShapes, area x0 y0 x1 y1, lmin, lmax, maxIter, flags, 0, 0, 0]
//! 층        nLayers x [dir(0 가로 / 1 세로), pitch, offset, width, minL, e2e]        M1, M2, ...
//! 비아      nVias   x [lower, upper, wx, wy, encL, encH, spaceX, spaceY]             V1, V2, ...
//! 넷        nNets   x [power, sym, axis2, symDir(0 없음 / 1 세로축 / 2 가로축), parts]
//! 도형      nShapes x [layer, net, comp, pin, x0, y0, x1, y1]
//!           layer 는 금속이면 0.. (M1 = 0), 비아면 VIA_BASE + k (V1 = VIA_BASE)
//! ```

pub const MAGIC: i32 = 0x5254_4531; // "RTE1"
pub const VIA_BASE: i32 = 16;
const HEAD: usize = 16;

#[derive(Clone, Debug)]
pub struct Layer {
    pub vertical: bool,
    pub pitch: i32,
    pub offset: i32,
    pub width: i32,
    pub min_l: i32,
    pub e2e: i32,
}

#[derive(Clone, Debug)]
pub struct Via {
    pub lower: usize,
    pub upper: usize,
    pub wx: i32,
    pub wy: i32,
    pub enc_l: i32,
    pub enc_h: i32,
    pub space_x: i32,
    pub space_y: i32,
}

#[derive(Clone, Debug)]
pub struct Net {
    pub power: bool,
    pub sym: i32,
    pub axis2: i32,
    pub sym_dir: i32,
    pub parts: i32,
}

#[derive(Clone, Debug)]
pub struct Shape {
    pub layer: i32,
    pub net: i32,
    pub comp: i32,
    pub pin: bool,
    pub r: [i32; 4],
}

#[derive(Clone, Debug)]
pub struct Problem {
    pub layers: Vec<Layer>,
    pub vias: Vec<Via>,
    pub nets: Vec<Net>,
    pub shapes: Vec<Shape>,
    pub area: [i32; 4],
    /// 배선에 쓰는 금속 범위 (M1 = 0), 양끝 포함
    pub lmin: usize,
    pub lmax: usize,
    pub max_iter: i32,
    pub flags: i32,
}

pub fn decode(b: &[i32]) -> Result<Problem, String> {
    if b.len() < HEAD || b[0] != MAGIC {
        return Err("배선 문제 머리가 틀렸다".into());
    }
    let (nl, nv, nn, ns) = (b[1] as usize, b[2] as usize, b[3] as usize, b[4] as usize);
    let need = HEAD + nl * 6 + nv * 8 + nn * 5 + ns * 8;
    if b.len() != need {
        return Err(format!("배선 문제 길이가 {} 이어야 하는데 {} 이다", need, b.len()));
    }
    let mut p = HEAD;
    let mut take = |k: usize| {
        let s = &b[p..p + k];
        p += k;
        s
    };
    let layers = (0..nl)
        .map(|_| {
            let s = take(6);
            Layer { vertical: s[0] == 1, pitch: s[1], offset: s[2], width: s[3], min_l: s[4], e2e: s[5] }
        })
        .collect();
    let vias = (0..nv)
        .map(|_| {
            let s = take(8);
            Via {
                lower: s[0] as usize,
                upper: s[1] as usize,
                wx: s[2],
                wy: s[3],
                enc_l: s[4],
                enc_h: s[5],
                space_x: s[6],
                space_y: s[7],
            }
        })
        .collect();
    let nets = (0..nn)
        .map(|_| {
            let s = take(5);
            Net { power: s[0] != 0, sym: s[1], axis2: s[2], sym_dir: s[3], parts: s[4] }
        })
        .collect();
    let shapes = (0..ns)
        .map(|_| {
            let s = take(8);
            Shape { layer: s[0], net: s[1], comp: s[2], pin: s[3] != 0, r: [s[4], s[5], s[6], s[7]] }
        })
        .collect();
    let prob = Problem {
        layers,
        vias,
        nets,
        shapes,
        area: [b[5], b[6], b[7], b[8]],
        lmin: b[9] as usize,
        lmax: b[10] as usize,
        max_iter: b[11],
        flags: b[12],
    };
    if prob.lmin > prob.lmax || prob.lmax >= prob.layers.len() {
        return Err(format!("배선층 범위가 틀렸다: {}..{}", prob.lmin, prob.lmax));
    }
    Ok(prob)
}

/// 배선 결과.
#[derive(Default, Debug)]
pub struct Solution {
    /// [layer, net, x0, y0, x1, y1] — layer 는 도형과 같은 부호 (금속 0.., 비아 VIA_BASE + k)
    pub wires: Vec<[i32; 6]>,
    /// 끝내 잇지 못한 넷
    pub failed: Vec<i32>,
    /// 규칙을 다 못 지킨 곳의 수 (최소 길이를 못 늘린 토막 등)
    pub violations: i32,
    pub iterations: i32,
    /// 대칭 넷 쌍 중 거울 경로를 그대로 쓴 것의 수 / 쌍의 수
    pub mirrored: i32,
    pub pairs: i32,
}

pub fn encode(s: &Solution) -> Vec<i32> {
    let mut out = vec![0; 8];
    out[0] = if s.failed.is_empty() && s.violations == 0 { 0 } else { 1 };
    out[1] = s.wires.len() as i32;
    out[2] = s.failed.len() as i32;
    out[3] = s.iterations;
    out[4] = s.violations;
    out[5] = s.mirrored;
    out[6] = s.pairs;
    for w in &s.wires {
        out.extend_from_slice(w);
    }
    out.extend_from_slice(&s.failed);
    out
}
