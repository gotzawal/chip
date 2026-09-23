//! 작은 도우미 — C++ 의 실수 -> 정수 버릇, 빠른 해시 표 (pr/util.rs 와 같은 것을 따로 둔다).
use std::collections::{HashMap, HashSet};
use std::hash::{BuildHasherDefault, Hasher};

/// `(int)x` (double -> int). 기준 빌드(emscripten wasm32, nontrapping-fptoint 없음)는 범위 밖·NaN 이면
/// INT_MIN 을 낸다.
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

/// `int(ceil(double(v) / u)) * u + off` (Grid.cpp 의 트랙 첫 줄)
#[inline]
pub fn ceil_off(v: i32, u: i32, off: i32) -> i32 {
    f2i((v as f64 / u as f64).ceil()).wrapping_mul(u).wrapping_add(off)
}

/// FxHash — 조회만 하고 돌지 않는 표에 쓴다
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
