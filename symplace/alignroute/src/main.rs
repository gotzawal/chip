//! 네이티브로 돌려 보는 창구 — `alignroute <일감.json> [결과.json]`.
//! 페이지와 node 시험은 wasm(src/route/alignroute.wasm)을 쓴다. 이것은 개발할 때 빨리 돌려 보는 용도다.
use std::io::Write;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("사용법: alignroute <일감.json> [결과.json]");
        std::process::exit(2);
    }
    let input = std::fs::read(&args[1]).unwrap_or_else(|e| panic!("{}: {e}", args[1]));
    let out = alignroute::route::run_json(&input);
    if let Some(p) = args.get(2) {
        std::fs::write(p, &out).unwrap_or_else(|e| panic!("{p}: {e}"));
    } else {
        std::io::stdout().write_all(&out).unwrap();
    }
}
