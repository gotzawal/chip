//! symroute — 격자 배선기. src/route/problem.mjs 가 만든 배선 문제를 푼다.
//!
//! wasm 으로 페이지와 node 에서 같은 파일(src/route/router.wasm)이 돈다. 주고받는 것은 i32 배열
//! 하나씩이다 (model.rs). 내보내는 함수:
//!
//!   alloc(n)   -> 입력을 쓸 자리 (i32 n 개)
//!   route(n)   -> 결과 i32 배열의 자리 (길이는 out_len())
//!   out_len()
//!
//! 오류면 결과의 첫 값이 -1 이고, [1] 은 글자 수, [8..] 에 UTF-8 바이트가 하나씩 들어 있다.

pub mod grid;
pub mod legal;
pub mod model;
pub mod router;
pub mod search;

use std::cell::RefCell;

pub fn route_buf(input: &[i32]) -> Vec<i32> {
    match model::decode(input).and_then(|p| router::solve(&p)) {
        Ok(sol) => model::encode(&sol),
        Err(e) => {
            let b = e.as_bytes();
            let mut v = vec![-1, b.len() as i32, 0, 0, 0, 0, 0, 0];
            v.extend(b.iter().map(|&c| c as i32));
            v
        }
    }
}

thread_local! {
    static INPUT: RefCell<Vec<i32>> = const { RefCell::new(Vec::new()) };
    static OUTPUT: RefCell<Vec<i32>> = const { RefCell::new(Vec::new()) };
}

#[unsafe(no_mangle)]
pub extern "C" fn alloc(n: usize) -> *mut i32 {
    INPUT.with(|b| {
        let mut b = b.borrow_mut();
        *b = vec![0; n];
        b.as_mut_ptr()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn route(n: usize) -> *const i32 {
    let out = INPUT.with(|b| {
        let b = b.borrow();
        route_buf(&b[..n.min(b.len())])
    });
    OUTPUT.with(|o| {
        *o.borrow_mut() = out;
        o.borrow().as_ptr()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn out_len() -> usize {
    OUTPUT.with(|o| o.borrow().len())
}
