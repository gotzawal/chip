//! lp_solve 5.5.2.11 의 C API — 전역 배선(GcellGlobalRouter::ILPSolveRouting)이 부르는 것만.
//! 빌드는 build.rs (ALIGN 과 같은 C 소스를 같이 링크한다).
#![allow(non_camel_case_types, dead_code)]

use std::os::raw::{c_char, c_double, c_int, c_long, c_uchar, c_void};

pub type lprec = c_void;
pub type MYBOOL = c_uchar;

pub const LE: c_int = 1;
pub const GE: c_int = 2;
pub const EQ: c_int = 3;
pub const PRESOLVE_PROBEFIX: c_int = 2048;
pub const PRESOLVE_ROWDOMINATE: c_int = 8192;
pub const OPTIMAL: c_int = 0;
pub const SUBOPTIMAL: c_int = 1;
pub const INFEASIBLE: c_int = 2;

unsafe extern "C" {
    pub fn make_lp(rows: c_int, columns: c_int) -> *mut lprec;
    pub fn delete_lp(lp: *mut lprec);
    pub fn set_verbose(lp: *mut lprec, verbose: c_int);
    pub fn set_outputfile(lp: *mut lprec, filename: *const c_char) -> MYBOOL;
    pub fn add_constraintex(lp: *mut lprec, count: c_int, row: *const c_double, colno: *const c_int,
                            constr_type: c_int, rh: c_double) -> MYBOOL;
    pub fn set_binary(lp: *mut lprec, column: c_int, must_be_bin: MYBOOL) -> MYBOOL;
    pub fn set_bounds(lp: *mut lprec, column: c_int, lower: c_double, upper: c_double) -> MYBOOL;
    pub fn set_obj_fnex(lp: *mut lprec, count: c_int, row: *const c_double, colno: *const c_int) -> MYBOOL;
    pub fn set_minim(lp: *mut lprec);
    pub fn set_timeout(lp: *mut lprec, sectimeout: c_long);
    pub fn get_presolveloops(lp: *mut lprec) -> c_int;
    pub fn set_presolve(lp: *mut lprec, presolvemode: c_int, maxloops: c_int);
    pub fn solve(lp: *mut lprec) -> c_int;
    pub fn get_variables(lp: *mut lprec, var: *mut c_double) -> MYBOOL;
    pub fn get_objective(lp: *mut lprec) -> c_double;
    pub fn get_Ncolumns(lp: *mut lprec) -> c_int;
    pub fn get_Nrows(lp: *mut lprec) -> c_int;
}
