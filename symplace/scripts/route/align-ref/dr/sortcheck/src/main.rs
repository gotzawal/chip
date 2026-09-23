// alignroute/src/dr/sort.rs 를 그대로 들여와 ref.cpp 와 같은 사례를 정렬한다 (벡터 밖이면 "UB")
#[allow(dead_code)]
#[path = "../../../../../../alignroute/src/dr/sort.rs"]
mod sort;

use std::io::Read;

#[derive(Clone, Copy)]
struct E {
    key: i32,
    special: bool,
    id: i32,
}

fn h(a: u32, b: u32) -> u32 {
    let mut x = a.wrapping_mul(2654435761) ^ (b.wrapping_add(0x9e3779b9).wrapping_add(a << 6).wrapping_add(a >> 2));
    x ^= x >> 13;
    x = x.wrapping_mul(0x5bd1e995);
    x ^= x >> 15;
    x
}

fn main() {
    let mut s = String::new();
    std::io::stdin().read_to_string(&mut s).unwrap();
    let mut it = s.split_ascii_whitespace().map(|t| t.parse::<i64>().unwrap());
    let t = it.next().unwrap();
    let mut out = String::new();
    for _ in 0..t {
        let n = it.next().unwrap() as usize;
        let first = it.next().unwrap() as usize;
        let kind = it.next().unwrap();
        let mut v: Vec<E> = (0..n)
            .map(|i| {
                let key = it.next().unwrap() as i32;
                let sp = it.next().unwrap() != 0;
                E { key, special: sp, id: i as i32 }
            })
            .collect();
        let mut less = |w: &[E], a: &E, b: &E| -> bool {
            match kind {
                1 => a.key < b.key,
                2 => a.special || b.special || a.key < b.key,
                3 => h(a.id as u32, b.id as u32) & 1 == 1,
                _ => {
                    if a.special || b.special {
                        return true;
                    }
                    let (mut da, mut db): (Option<i32>, Option<i32>) = (None, None);
                    for p in &w[..first] {
                        if p.special {
                            continue;
                        }
                        let x = a.key.wrapping_sub(p.key).wrapping_abs();
                        let y = b.key.wrapping_sub(p.key).wrapping_abs();
                        da = Some(da.map_or(x, |d| d.min(x)));
                        db = Some(db.map_or(y, |d| d.min(y)));
                    }
                    match (da, db) {
                        (Some(x), Some(y)) => x < y,
                        _ => true,
                    }
                }
            }
        };
        match sort::sort(&mut v, first, &mut less) {
            Ok(()) => {
                for e in &v {
                    out.push_str(&format!("{} ", e.id));
                }
                out.push('\n');
            }
            Err(_) => out.push_str("UB\n"),
        }
    }
    print!("{out}");
}
