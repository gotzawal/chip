//! lp_solve 5.5.2.11 을 대상에 맞춰 C 로 빌드해 정적으로 링크한다.
//!
//! 전역 배선(모드 4)의 ILP 는 최적해가 수백~수천 개씩 겹쳐서, 다른 풀이기는 다른 배선을 고른다.
//! 그래서 ALIGN 이 쓰는 lp_solve 를 그대로 쓴다. 파일 목록과 정의는 ALIGN
//! `thirdparty/CMakeLists.lpsolve` 와 기준 휠 빌드(`symplace/scripts/wasm/build-pnr-wasm.sh`)를 따른다.
//!
//! - wasm32 (페이지): clang --target=wasm32-wasi + Debian wasi-libc. long double 이 binary128 이라
//!   기준(emscripten)과 비트까지 같다 (합성 ILP 410/410, `scripts/route/align-ref/ilp/wasi`).
//! - 네이티브 (개발용 CLI): gcc + `-DREALXP=__float128` — 같은 까닭으로 기준과 같다 (450/450).
//!
//! LP 파일 읽기(lp_rlp.c, yacc_read.c)는 뺀다 — setjmp 가 wasm 에 없고 ALIGN 은 부르지 않는다.
//! lp_lib.c 가 찾는 이름은 csrc/lpstubs.c 가 채운다. 소스는 `fetch-lpsolve.sh` 가 받아 둔다.
use std::env;
use std::path::PathBuf;
use std::process::Command;

const FILES: &[&str] = &[
    "lp_MDO.c", "shared/commonlib.c", "shared/mmio.c", "shared/myblas.c", "ini.c", "fortify.c",
    "colamd/colamd.c", "lp_crash.c", "bfp/bfp_LUSOL/lp_LUSOL.c", "bfp/bfp_LUSOL/LUSOL/lusol.c",
    "lp_Hash.c", "lp_lib.c", "lp_wlp.c", "lp_matrix.c", "lp_mipbb.c", "lp_MPS.c", "lp_params.c",
    "lp_presolve.c", "lp_price.c", "lp_pricePSE.c", "lp_report.c", "lp_scale.c", "lp_simplex.c",
    "lp_SOS.c", "lp_utils.c",
];
const DEFS: &[&str] = &[
    "-DYY_NEVER_INTERACTIVE", "-DPARSER_LP", "-DINVERSE_ACTIVE=INVERSE_LUSOL",
    "-DRoleIsExternalInvEngine", "-DLoadInverseLib=0", "-DLoadLanguageLib=0",
];
const INCS: &[&str] = &["", "shared", "bfp", "bfp/bfp_LUSOL", "bfp/bfp_LUSOL/LUSOL", "colamd"];

fn run(mut c: Command) {
    let st = c.status().unwrap_or_else(|e| panic!("{c:?}: {e}"));
    assert!(st.success(), "{c:?} 실패");
}

fn main() {
    let target = env::var("TARGET").unwrap();
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let src = env::var("LPSOLVE_SRC").map(PathBuf::from).unwrap_or_else(|_| {
        PathBuf::from(env::var("HOME").unwrap_or_default()).join(".cache/symplace/lpsolve-wasi/lp_solve_5.5")
    });
    assert!(
        src.join("lp_lib.c").exists(),
        "lp_solve 소스가 없다: {} — symplace/alignroute/fetch-lpsolve.sh 를 먼저 돌린다",
        src.display()
    );
    let wasm = target.starts_with("wasm32");
    let (cc, ar) = if wasm { ("clang", "llvm-ar") } else { ("gcc", "ar") };

    let mut files: Vec<PathBuf> = FILES.iter().map(|f| src.join(f)).collect();
    files.push(manifest.join("csrc/lpstubs.c"));
    let mut objs = Vec::new();
    for f in &files {
        let o = out.join(format!("{}.o", f.file_stem().unwrap().to_str().unwrap()));
        let mut c = Command::new(cc);
        if wasm {
            c.args(["--target=wasm32-wasi", "--sysroot=/usr", "-isystem"])
                .arg(manifest.join("csrc/shim"))
                .args(["-isystem", "/usr/include/wasm32-wasi", "-D_WASI_EMULATED_SIGNAL"]);
        } else {
            c.args(["-DREALXP=__float128", "-fPIC"]);
        }
        c.args(["-O2", "-ffp-contract=off", "-w"]);
        for i in INCS {
            c.arg(format!("-I{}", src.join(i).display()));
        }
        c.args(DEFS).arg("-c").arg(f).arg("-o").arg(&o);
        run(c);
        objs.push(o);
    }
    let lib = out.join("liblpsolve.a");
    let _ = std::fs::remove_file(&lib);
    let mut a = Command::new(ar);
    a.arg("crs").arg(&lib).args(&objs);
    run(a);

    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=lpsolve");
    if wasm {
        println!("cargo:rustc-link-search=native=/usr/lib/wasm32-wasi");
        println!("cargo:rustc-link-lib=static=wasi-emulated-signal");
        println!("cargo:rustc-link-arg=/usr/lib/llvm-18/lib/clang/18/lib/wasi/libclang_rt.builtins-wasm32.a");
    } else {
        println!("cargo:rustc-link-lib=m");
    }
    println!("cargo:rerun-if-env-changed=LPSOLVE_SRC");
    println!("cargo:rerun-if-changed=csrc");
    println!("cargo:rerun-if-changed=build.rs");
}
