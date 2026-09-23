//! ALIGN PnR 배선기를 그대로 옮긴 것 — 모듈 하나를 배선한다.
//!
//! ALIGN-public (`8d3cc2e`) `PlaceRouteHierFlow/router` 의 RouteWork 4·5·2·3 과 거기서 닿는 코드를
//! 같은 순서·같은 버릇으로 옮긴다. 합격선은 기준(축소 PnR 휠, emscripten 3.1.58) 과 **같은 도형**이다
//! (symplace/PLAN-route-align.md). 계층 부기와 입력 만들기는 JS 가 한다 (src/route/align/).
//!
//! wasm 으로 내보내는 것: alloc / dealloc / route_json / out_len. JSON 일감(db::Job)을 받아
//! JSON 결과(route::Output)를 돌려준다. JS 쪽은 src/route/alignroute.mjs.
pub mod db;
pub mod dr;
pub mod gr;
pub mod lp;
pub mod pr;
pub mod rdb;
pub mod route;

use std::cell::RefCell;

thread_local! {
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

#[unsafe(no_mangle)]
pub extern "C" fn alloc(n: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(n.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `p` 는 같은 `n` 으로 받은 alloc 의 결과여야 한다.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(p: *mut u8, n: usize) {
    unsafe { drop(Vec::from_raw_parts(p, 0, n.max(1))) }
}

/// # Safety
/// `p..p+n` 은 alloc 으로 받은 메모리의 JSON 이어야 한다. 결과는 다음 호출까지 유효하다 (길이는 out_len).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn route_json(p: *const u8, n: usize) -> *const u8 {
    let input = unsafe { std::slice::from_raw_parts(p, n) };
    let out = route::run_json(input);
    OUT.with(|o| {
        *o.borrow_mut() = out;
        o.borrow().as_ptr()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn out_len() -> usize {
    OUT.with(|o| o.borrow().len())
}
