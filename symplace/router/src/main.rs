//! 네이티브로 돌려 보기 — wasm 과 같은 입력 파일(i32 리틀 엔디언)을 읽고 결과를 쓴다.
//!
//!   cargo run --release -- <문제.bin> [결과.bin]
//!
//! 문제 파일은 symplace/scripts/route/node/newroute.mjs --bin=<파일> 이 쓴다.

use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("쓰기: symroute <문제.bin> [결과.bin]");
        std::process::exit(2);
    }
    let raw = std::fs::read(&args[1]).expect("문제 파일을 못 읽었다");
    let input: Vec<i32> = raw.chunks_exact(4).map(|c| i32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect();
    let t0 = Instant::now();
    let out = symroute::route_buf(&input);
    let ms = t0.elapsed().as_secs_f64() * 1e3;
    if out[0] < 0 {
        let msg: Vec<u8> = out[8..].iter().map(|&c| c as u8).collect();
        eprintln!("오류: {}", String::from_utf8_lossy(&msg));
        std::process::exit(1);
    }
    println!("{:.1} ms  상태 {}  사각형 {}  못 이은 넷 {}  반복 {}  규칙 위반 {}", ms, out[0], out[1], out[2], out[3], out[4]);
    if let Some(dst) = args.get(2) {
        let bytes: Vec<u8> = out.iter().flat_map(|v| v.to_le_bytes()).collect();
        std::fs::write(dst, bytes).expect("결과를 못 썼다");
    }
}
