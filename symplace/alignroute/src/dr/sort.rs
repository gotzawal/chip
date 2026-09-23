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
                if first >= last || self.cv(&pivot, first)? {
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

    /// libc++ 18 std::sort 가 낸 순서 (scripts/route/align-ref/dr/sortcheck/ref.cpp 로 뽑았다): (종류, first, 키, 특수, 결과 번호 — 빈 것은 벡터 밖)
    const CASES: &[(u8, usize, &str, &str, &str)] = &[
        (1, 0, "1 0 1 1 0 1 1 0 0 2 0 2 0 2 2 0 1 2 2 0",
         "00000000000000000000",
         "1 4 7 8 10 12 15 19 0 2 3 5 6 16 9 11 13 14 17 18"),
        (1, 0, "0 2 1 1 3 3 0 3 1 1 2 1 3 1 0 1 0 3 2 2 0 2 2 1 0 3 0 2 3 3 0 0 0 0 0 2 2 0 3 3",
         "0000000000000000000000000000000000000000",
         "0 6 31 16 20 24 30 37 14 34 33 26 32 2 3 8 9 11 13 15 23 1 10 19 21 22 36 35 27 18 5 29 28 25 17 12 7 4 38 39"),
        (1, 0, "0 5 0 3 1 4 0 1 5 1 5 0 2 1 3 3 4 3 2 0 1 0 4 0 4 3 4 2 2 0 5 5 1 1 0 1 2 0 2 4 0 3 2 3 0 2 1 4 2 2 4 2 1 4 4 5 4 2 1 4 3 2 5 3 0 4 2 3 1 1 2 3 4 2 0 2 0 0 0 3 4 5 3 5 5 2 2 5 3 4 4 5 5 0 4 2 5 3 2 4 2 1 1 3 3 2 1 1 1 3 5 3 0 3 1 5 3 0 1 1 3 1 5 2 0 0 3 0 5 1 4 1 1 4 1 2 2 0 1 2",
         "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
         "29 127 2 125 124 117 6 112 93 78 77 11 76 74 0 137 64 44 40 19 37 21 34 23 138 119 13 68 101 102 134 132 32 33 131 35 106 20 107 129 58 69 108 4 7 114 46 121 118 52 9 51 139 48 45 123 42 57 18 38 36 61 105 135 28 100 66 98 27 95 86 70 85 73 136 75 12 49 82 63 25 71 41 126 3 43 14 17 88 120 116 113 111 109 60 15 104 97 67 103 79 16 47 99 94 59 56 54 90 5 53 50 80 26 24 133 22 130 39 72 89 65 122 87 115 84 83 10 128 91 55 92 31 110 30 8 62 81 1 96"),
        (2, 0, "17 46 20 6 45 33 15 10 10 16 42 9 15 41 10 29 20 6 6 6 48 24 30 49 2 15 38 42 12 46",
         "000000000010000111100000011000",
         ""),
        (2, 0, "146 286 462 238 594 665 442 776 938 807 251 516 423 801 16 703 328 993 889 774 641 312 288 368 433 771 154 656 393 164 783 628 861 8 223 545 656 170 362 697 102 876 27 433 163 461 8 694 984 804 30 639 515 470 209 572 150 54 328 531 166 643 728 210 785 954 628 864 818 6 827 343 576 763 900 859 818 53 944 608 441 196 883 195 750 887 97 742 375 387 180 723 825 826 562 419 538 361 404 310 521 614 754 555 303 540 930 119 917 442 795 184 449 132 207 441 171 272 951 134 988 341 806 90 913 596 480 236 871 747 654 520 77 190 165 141 514 654 503 891 379 41 553 935 53 928 28 717 308 430",
         "000000000000000100011011000000100001000010000000000000000000010000000110100000010000010000001000000000000000100000100000000000000000100000000001000000",
         "108 20 19 23 61 92 15 132 85 79 30 114 69 46 33 14 143 35 70 40 72 22 42 146 50 141 77 144 57 123 86 107 113 119 135 0 56 26 44 29 134 60 37 116 90 111 133 83 81 54 63 34 127 3 10 117 1 104 148 99 21 16 58 121 71 97 38 88 140 89 28 98 95 12 149 43 24 115 80 109 6 112 45 2 53 126 138 136 52 11 131 100 59 96 105 142 103 94 55 4 125 101 66 31 51 137 130 36 27 5 47 39 147 91 62 87 129 84 102 73 25 7 64 110 13 49 122 9 76 68 93 75 32 67 128 41 82 18 139 74 124 145 106 8 78 118 65 48 120 17"),
        (4, 9, "29 30 31 6 16 23 10 31 13 20 5 0 22 9 12 0 39 12 3 28 22 34 2 7 36 29 33 39 15 37 10 1 34 15 1 3 28 21 7 23 6 22 32 37 4 9 12 25 3 18 14 24 38 14 20 34 34 15 9 19",
         "000000000000000100000011000000000000000000000000000010000000",
         "0 1 2 3 4 5 6 7 8 22 15 23 40 39 30 25 52 42 36 19 20 17 57 14 51 13 41 50 28 10 12 58 46 33 45 38 53 37 44 47 49 26 59 35 9 32 48 21 18 54 55 56 31 24 34 43 29 11 27 16"),
    ];

    /// 같은 키의 순서와 어긋난 비교 함수(2: 특수면 늘 참, 4: 구간 앞쪽과의 가장 가까운 거리)까지 libc++ 와 같다
    #[test]
    fn matches_libcxx() {
        for &(kind, first, keys, sp, want) in CASES {
            let mut v: Vec<(i32, bool, usize)> =
                keys.split(' ').zip(sp.bytes()).enumerate().map(|(i, (k, s))| (k.parse().unwrap(), s == b'1', i)).collect();
            let mut less = |w: &[(i32, bool, usize)], a: &(i32, bool, usize), b: &(i32, bool, usize)| -> bool {
                match kind {
                    1 => a.0 < b.0,
                    2 => a.1 || b.1 || a.0 < b.0,
                    _ => {
                        if a.1 || b.1 {
                            return true;
                        }
                        let d = |x: i32| w[..first].iter().filter(|p| !p.1).map(|p| (x - p.0).abs()).min();
                        match (d(a.0), d(b.0)) {
                            (Some(x), Some(y)) => x < y,
                            _ => true,
                        }
                    }
                }
            };
            let r = sort(&mut v, first, &mut less);
            if want.is_empty() {
                assert!(r.is_err());
            } else {
                r.unwrap();
                let got: Vec<String> = v.iter().map(|x| x.2.to_string()).collect();
                assert_eq!(got.join(" "), want);
            }
        }
    }
}
