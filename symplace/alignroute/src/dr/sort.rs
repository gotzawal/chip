//! libc++ 18 의 `std::sort` (`__introsort`) 를 그대로 — SortPinsOrder 의 비교 함수는 단자·접점 없는 핀에서
//! 늘 참을 돌려줘 어긋나므로, 같은 입력에서 같은 순서가 나오려면 알고리즘이 같아야 한다.
//!
//! 기준은 emscripten 3.1.58 의 libc++ 18 (`__algorithm/sort.h`, 사용자 비교 함수라 branchless·bitset 분할은
//! 안 쓰는 길). 2~5 개는 `__sort3/4/5`, 24 개 미만은 삽입 정렬(맨 왼쪽 구간만 가드), 그 위는 가운데 셋
//! (128 개 넘으면 ninther) 로 피벗을 고르고 같은 것을 오른쪽에 모으는 분할, 깊이 2·log2(n) 에서 힙 정렬.
//!
//! 정렬 구간 [first, last) 는 벡터 v 전체 안의 번호다. 비교 함수는 벡터의 지금 모습도 받는다 (두 번째
//! 정렬의 비교 함수가 구간 앞쪽 원소를 읽는다). 어긋난 비교 함수로 가드 없는 걸음이 구간 밖으로 나가도
//! 벡터 안이면 C++ 처럼 읽고 쓴다. 벡터 밖으로 나가면 C++ 은 정의되지 않은 동작 — Err 로 돌려준다.

pub type Less<'a, T> = dyn FnMut(&[T], &T, &T) -> bool + 'a;

struct Sorter<'a, 'b, T: Clone> {
    v: &'a mut [T],
    less: &'a mut Less<'b, T>,
}

fn oob(i: isize, n: usize) -> String {
    format!("std::sort 가 벡터 밖(원소 {i}, 크기 {n})을 읽는다 — 어긋난 비교 함수의 정의되지 않은 동작")
}

impl<T: Clone> Sorter<'_, '_, T> {
    fn get(&self, i: isize) -> Result<T, String> {
        if i < 0 || i as usize >= self.v.len() {
            return Err(oob(i, self.v.len()));
        }
        Ok(self.v[i as usize].clone())
    }

    fn set(&mut self, i: isize, x: T) -> Result<(), String> {
        if i < 0 || i as usize >= self.v.len() {
            return Err(oob(i, self.v.len()));
        }
        self.v[i as usize] = x;
        Ok(())
    }

    /// comp(*i, *j)
    fn c(&mut self, i: isize, j: isize) -> Result<bool, String> {
        let (a, b) = (self.get(i)?, self.get(j)?);
        Ok((self.less)(self.v, &a, &b))
    }

    /// comp(a, *j)
    fn cv(&mut self, a: &T, j: isize) -> Result<bool, String> {
        let b = self.get(j)?;
        Ok((self.less)(self.v, a, &b))
    }

    /// comp(*i, b)
    fn vc(&mut self, i: isize, b: &T) -> Result<bool, String> {
        let a = self.get(i)?;
        Ok((self.less)(self.v, &a, b))
    }

    fn swap(&mut self, i: isize, j: isize) -> Result<(), String> {
        let (a, b) = (self.get(i)?, self.get(j)?);
        self.set(i, b)?;
        self.set(j, a)
    }

    fn sort3(&mut self, x: isize, y: isize, z: isize) -> Result<(), String> {
        if !self.c(y, x)? {
            if !self.c(z, y)? {
                return Ok(());
            }
            self.swap(y, z)?;
            if self.c(y, x)? {
                self.swap(x, y)?;
            }
            return Ok(());
        }
        if self.c(z, y)? {
            self.swap(x, z)?;
            return Ok(());
        }
        self.swap(x, y)?;
        if self.c(z, y)? {
            self.swap(y, z)?;
        }
        Ok(())
    }

    fn sort4(&mut self, x1: isize, x2: isize, x3: isize, x4: isize) -> Result<(), String> {
        self.sort3(x1, x2, x3)?;
        if self.c(x4, x3)? {
            self.swap(x3, x4)?;
            if self.c(x3, x2)? {
                self.swap(x2, x3)?;
                if self.c(x2, x1)? {
                    self.swap(x1, x2)?;
                }
            }
        }
        Ok(())
    }

    fn sort5(&mut self, x1: isize, x2: isize, x3: isize, x4: isize, x5: isize) -> Result<(), String> {
        self.sort4(x1, x2, x3, x4)?;
        if self.c(x5, x4)? {
            self.swap(x4, x5)?;
            if self.c(x4, x3)? {
                self.swap(x3, x4)?;
                if self.c(x3, x2)? {
                    self.swap(x2, x3)?;
                    if self.c(x2, x1)? {
                        self.swap(x1, x2)?;
                    }
                }
            }
        }
        Ok(())
    }

    /// __insertion_sort (가드 있음)
    fn insertion_sort(&mut self, first: isize, last: isize) -> Result<(), String> {
        if first == last {
            return Ok(());
        }
        let mut i = first + 1;
        while i != last {
            let mut j = i - 1;
            if self.c(i, j)? {
                let t = self.get(i)?;
                let mut k = j;
                j = i;
                loop {
                    let x = self.get(k)?;
                    self.set(j, x)?;
                    j = k;
                    if j == first {
                        break;
                    }
                    k -= 1;
                    if !self.cv(&t, k)? {
                        break;
                    }
                }
                self.set(j, t)?;
            }
            i += 1;
        }
        Ok(())
    }

    /// __insertion_sort_unguarded — 안쪽 걸음에 가드가 없다 (first-1 이 구간의 모든 것 이하라고 가정)
    fn insertion_sort_unguarded(&mut self, first: isize, last: isize) -> Result<(), String> {
        if first == last {
            return Ok(());
        }
        let mut i = first + 1;
        while i != last {
            let mut j = i - 1;
            if self.c(i, j)? {
                let t = self.get(i)?;
                let mut k = j;
                j = i;
                loop {
                    let x = self.get(k)?;
                    self.set(j, x)?;
                    j = k;
                    k -= 1;
                    if !self.cv(&t, k)? {
                        break;
                    }
                }
                self.set(j, t)?;
            }
            i += 1;
        }
        Ok(())
    }

    /// __insertion_sort_incomplete — 8 번 옮기면 멈추고 끝까지 갔는지를 돌려준다
    fn insertion_sort_incomplete(&mut self, first: isize, last: isize) -> Result<bool, String> {
        match last - first {
            0 | 1 => return Ok(true),
            2 => {
                if self.c(last - 1, first)? {
                    self.swap(first, last - 1)?;
                }
                return Ok(true);
            }
            3 => {
                self.sort3(first, first + 1, last - 1)?;
                return Ok(true);
            }
            4 => {
                self.sort4(first, first + 1, first + 2, last - 1)?;
                return Ok(true);
            }
            5 => {
                self.sort5(first, first + 1, first + 2, first + 3, last - 1)?;
                return Ok(true);
            }
            _ => {}
        }
        let mut j = first + 2;
        self.sort3(first, first + 1, j)?;
        let limit = 8;
        let mut count = 0;
        let mut i = j + 1;
        while i != last {
            if self.c(i, j)? {
                let t = self.get(i)?;
                let mut k = j;
                j = i;
                loop {
                    let x = self.get(k)?;
                    self.set(j, x)?;
                    j = k;
                    if j == first {
                        break;
                    }
                    k -= 1;
                    if !self.cv(&t, k)? {
                        break;
                    }
                }
                self.set(j, t)?;
                count += 1;
                if count == limit {
                    return Ok(i + 1 == last);
                }
            }
            j = i;
            i += 1;
        }
        Ok(true)
    }

    /// __partition_with_equals_on_right — (피벗 자리, 이미 나뉘어 있었나)
    fn partition_with_equals_on_right(&mut self, first0: isize, last0: isize) -> Result<(isize, bool), String> {
        let begin = first0;
        let (mut first, mut last) = (first0, last0);
        let pivot = self.get(first)?;
        loop {
            first += 1;
            if !self.vc(first, &pivot)? {
                break;
            }
        }
        if begin == first - 1 {
            while first < last {
                last -= 1;
                if self.vc(last, &pivot)? {
                    break;
                }
            }
        } else {
            loop {
                last -= 1;
                if self.vc(last, &pivot)? {
                    break;
                }
            }
        }
        let already = first >= last;
        while first < last {
            self.swap(first, last)?;
            loop {
                first += 1;
                if !self.vc(first, &pivot)? {
                    break;
                }
            }
            loop {
                last -= 1;
                if self.vc(last, &pivot)? {
                    break;
                }
            }
        }
        let pivot_pos = first - 1;
        if begin != pivot_pos {
            let x = self.get(pivot_pos)?;
            self.set(begin, x)?;
        }
        self.set(pivot_pos, pivot)?;
        Ok((pivot_pos, already))
    }

    /// __partition_with_equals_on_left — 새 first 를 돌려준다
    fn partition_with_equals_on_left(&mut self, first0: isize, last0: isize) -> Result<isize, String> {
        let begin = first0;
        let (mut first, mut last) = (first0, last0);
        let pivot = self.get(first)?;
        if self.cv(&pivot, last - 1)? {
            loop {
                first += 1;
                if self.cv(&pivot, first)? {
                    break;
                }
            }
        } else {
            loop {
                first += 1;
                if !(first < last) || self.cv(&pivot, first)? {
                    break;
                }
            }
        }
        if first < last {
            loop {
                last -= 1;
                if !self.cv(&pivot, last)? {
                    break;
                }
            }
        }
        while first < last {
            self.swap(first, last)?;
            loop {
                first += 1;
                if self.cv(&pivot, first)? {
                    break;
                }
            }
            loop {
                last -= 1;
                if !self.cv(&pivot, last)? {
                    break;
                }
            }
        }
        let pivot_pos = first - 1;
        if begin != pivot_pos {
            let x = self.get(pivot_pos)?;
            self.set(begin, x)?;
        }
        self.set(pivot_pos, pivot)?;
        Ok(first)
    }

    // ---------------------------------------------------------------- 힙 정렬 (__partial_sort(first, last, last))

    fn sift_down(&mut self, first: isize, len: isize, start0: isize) -> Result<(), String> {
        let mut start = start0;
        let mut child = start - first;
        if len < 2 || (len - 2) / 2 < child {
            return Ok(());
        }
        child = 2 * child + 1;
        let mut child_i = first + child;
        if child + 1 < len && self.c(child_i, child_i + 1)? {
            child_i += 1;
            child += 1;
        }
        if self.c(child_i, start)? {
            return Ok(());
        }
        let top = self.get(start)?;
        loop {
            let x = self.get(child_i)?;
            self.set(start, x)?;
            start = child_i;
            if (len - 2) / 2 < child {
                break;
            }
            child = 2 * child + 1;
            child_i = first + child;
            if child + 1 < len && self.c(child_i, child_i + 1)? {
                child_i += 1;
                child += 1;
            }
            if self.vc(child_i, &top)? {
                break;
            }
        }
        self.set(start, top)
    }

    fn floyd_sift_down(&mut self, first: isize, len: isize) -> Result<isize, String> {
        let mut hole = first;
        let mut child_i = first;
        let mut child: isize = 0;
        loop {
            child_i += child + 1;
            child = 2 * child + 1;
            if child + 1 < len && self.c(child_i, child_i + 1)? {
                child_i += 1;
                child += 1;
            }
            let x = self.get(child_i)?;
            self.set(hole, x)?;
            hole = child_i;
            if child > (len - 2) / 2 {
                return Ok(hole);
            }
        }
    }

    fn sift_up(&mut self, first: isize, last0: isize, len0: isize) -> Result<(), String> {
        let mut last = last0;
        let mut len = len0;
        if len > 1 {
            len = (len - 2) / 2;
            let mut ptr = first + len;
            last -= 1;
            if self.c(ptr, last)? {
                let t = self.get(last)?;
                loop {
                    let x = self.get(ptr)?;
                    self.set(last, x)?;
                    last = ptr;
                    if len == 0 {
                        break;
                    }
                    len = (len - 1) / 2;
                    ptr = first + len;
                    if !self.vc(ptr, &t)? {
                        break;
                    }
                }
                self.set(last, t)?;
            }
        }
        Ok(())
    }

    fn pop_heap(&mut self, first: isize, last0: isize, len: isize) -> Result<(), String> {
        let mut last = last0;
        if len > 1 {
            let top = self.get(first)?;
            let mut hole = self.floyd_sift_down(first, len)?;
            last -= 1;
            if hole == last {
                self.set(hole, top)?;
            } else {
                let x = self.get(last)?;
                self.set(hole, x)?;
                hole += 1;
                self.set(last, top)?;
                self.sift_up(first, hole, hole - first)?;
            }
        }
        Ok(())
    }

    fn heap_sort(&mut self, first: isize, last0: isize) -> Result<(), String> {
        if first == last0 {
            return Ok(());
        }
        let n = last0 - first;
        if n > 1 {
            let mut start = (n - 2) / 2;
            while start >= 0 {
                self.sift_down(first, n, first + start)?;
                start -= 1;
            }
        }
        // __partial_sort_impl: middle == last 라 가운데 고리는 돌지 않는다. 그 다음 __sort_heap
        let mut last = last0;
        let mut n = last - first;
        while n > 1 {
            self.pop_heap(first, last, n)?;
            last -= 1;
            n -= 1;
        }
        Ok(())
    }

    fn introsort(&mut self, first0: isize, last0: isize, depth0: isize, leftmost0: bool) -> Result<(), String> {
        const LIMIT: isize = 24;
        const NINTHER: isize = 128;
        let (mut first, mut last, mut depth, mut leftmost) = (first0, last0, depth0, leftmost0);
        loop {
            let len = last - first;
            match len {
                0 | 1 => return Ok(()),
                2 => {
                    if self.c(last - 1, first)? {
                        self.swap(first, last - 1)?;
                    }
                    return Ok(());
                }
                3 => return self.sort3(first, first + 1, last - 1),
                4 => return self.sort4(first, first + 1, first + 2, last - 1),
                5 => return self.sort5(first, first + 1, first + 2, first + 3, last - 1),
                _ => {}
            }
            if len < LIMIT {
                return if leftmost { self.insertion_sort(first, last) } else { self.insertion_sort_unguarded(first, last) };
            }
            if depth == 0 {
                return self.heap_sort(first, last);
            }
            depth -= 1;
            let half = len / 2;
            if len > NINTHER {
                self.sort3(first, first + half, last - 1)?;
                self.sort3(first + 1, first + (half - 1), last - 2)?;
                self.sort3(first + 2, first + (half + 1), last - 3)?;
                self.sort3(first + (half - 1), first + half, first + (half + 1))?;
                self.swap(first, first + half)?;
            } else {
                self.sort3(first + half, first, last - 1)?;
            }
            if !leftmost && !self.c(first - 1, first)? {
                first = self.partition_with_equals_on_left(first, last)?;
                continue;
            }
            let (i, already) = self.partition_with_equals_on_right(first, last)?;
            if already {
                let fs = self.insertion_sort_incomplete(first, i)?;
                if self.insertion_sort_incomplete(i + 1, last)? {
                    if fs {
                        return Ok(());
                    }
                    last = i;
                    continue;
                } else if fs {
                    first = i + 1;
                    continue;
                }
            }
            self.introsort(first, i, depth, leftmost)?;
            leftmost = false;
            first = i + 1;
        }
    }
}

/// `__log2i` (wasm32 의 ptrdiff_t 는 32 비트) — floor(log2 n), n = 0 이면 0
fn log2i(n: isize) -> isize {
    if n <= 0 { 0 } else { 31 - (n as u32).leading_zeros() as isize }
}

/// `std::sort(v.begin() + first, v.end(), less)` — 비교 함수는 (벡터의 지금 모습, a, b) 를 받는다
pub fn sort<T: Clone>(v: &mut [T], first: usize, less: &mut Less<'_, T>) -> Result<(), String> {
    let last = v.len() as isize;
    let first = first as isize;
    let depth = 2 * log2i(last - first);
    let mut s = Sorter { v, less };
    s.introsort(first, last, depth, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lcg(seed: &mut u64) -> u64 {
        *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        *seed >> 33
    }

    #[test]
    fn sorts_like_a_sort() {
        let mut seed = 7u64;
        for n in [0usize, 1, 2, 3, 4, 5, 6, 10, 23, 24, 25, 60, 129, 200, 1000] {
            for _ in 0..20 {
                let mut v: Vec<(u32, usize)> = (0..n).map(|i| ((lcg(&mut seed) % 17) as u32, i)).collect();
                let mut w = v.clone();
                sort(&mut v, 0, &mut |_: &[(u32, usize)], a: &(u32, usize), b: &(u32, usize)| a.0 < b.0).unwrap();
                w.sort_by_key(|x| x.0);
                assert_eq!(v.iter().map(|x| x.0).collect::<Vec<_>>(), w.iter().map(|x| x.0).collect::<Vec<_>>());
            }
        }
    }
}
