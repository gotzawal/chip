//! 작은 도우미 — C++ 의 정수 나눗셈·실수 변환 버릇, 빠른 해시 표.
//!
//! i32 의 `/`, `%` 는 C 와 같이 0 쪽으로 자른다. double -> int 는 기준 빌드의 버릇(범위 밖이면 INT_MIN)을 따른다.
use std::collections::{HashMap, HashSet};
use std::hash::{BuildHasherDefault, Hasher};

/// `(int)x` (double -> int). 기준 빌드(emscripten wasm32, nontrapping-fptoint 없음)는 범위 밖·NaN 이면
/// INT_MIN 을 낸다 (`(int)(DBL_MAX + M)` = INT_MIN).
#[inline]
pub fn f2i(x: f64) -> i32 {
    if x.abs() < 2147483648.0 { x as i32 } else { i32::MIN }
}

/// `(int)(ceil((double)v / u) * u)`
#[inline]
pub fn ceil_mul(v: i32, u: i32) -> i32 {
    f2i((v as f64 / u as f64).ceil() * u as f64)
}

/// `(int)(floor((double)v / u) * u)`
#[inline]
pub fn floor_mul(v: i32, u: i32) -> i32 {
    f2i((v as f64 / u as f64).floor() * u as f64)
}

/// Grid.cpp 의 삼항식 `(v % u == 0) ? v : ((v / u) * u < v ? (v / u + 1) * u : (v / u) * u)`
#[inline]
pub fn ceil_to(v: i32, u: i32) -> i32 {
    if v % u == 0 {
        v
    } else if (v / u) * u < v {
        (v / u + 1) * u
    } else {
        (v / u) * u
    }
}

/// Grid::gcd — 재귀를 반복문으로 (C++ % 그대로)
pub fn gcd(a: i32, b: i32) -> i32 {
    let (mut a, mut b) = (a, b);
    while b != 0 {
        let t = a % b;
        a = b;
        b = t;
    }
    a
}

/// FxHash — 조회만 하고 돌지 않는 표에 쓴다 (돌 때는 늘 정렬해서 돈다)
#[derive(Default, Clone, Copy)]
pub struct Fx(u64);

impl Fx {
    #[inline]
    fn add(&mut self, n: u64) {
        self.0 = (self.0.rotate_left(5) ^ n).wrapping_mul(0x517c_c1b7_2722_0a95);
    }
}

impl Hasher for Fx {
    #[inline]
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.add(b as u64);
        }
    }
    #[inline]
    fn write_u32(&mut self, n: u32) {
        self.add(n as u64);
    }
    #[inline]
    fn write_i32(&mut self, n: i32) {
        self.add(n as u32 as u64);
    }
    #[inline]
    fn write_u64(&mut self, n: u64) {
        self.add(n);
    }
    #[inline]
    fn write_usize(&mut self, n: usize) {
        self.add(n as u64);
    }
}

pub type FxMap<K, V> = HashMap<K, V, BuildHasherDefault<Fx>>;
pub type FxSet<K> = HashSet<K, BuildHasherDefault<Fx>>;
