//! ILPSolveRouting — 넷마다 후보 트리 하나를 고르는 0-1 ILP (GcellGlobalRouter.cpp:1410-1744).
//!
//! 변수 x_1..x_N (넷, 후보 순서) 과 혼잡 비율 s = x_{N+1}. lp_solve 는 최적해가 수없이 겹치는 이 문제에서
//! 대개 처음 찾은 정수해를 내므로 행 순서·계수 순서·호출 순서를 C++ 그대로 둔다. 버릇:
//! - 변 행: 변을 처음 쓴 후보는 적히지 않고, 적히는 값이 (후보 번호 + 1) 이라 계수가 **다음** 후보의 열에
//!   붙는다 (마지막 후보는 어디에도 안 붙는다). 한 번만 쓰인 변은 `-cap*s <= 0` 만 남는다.
//! - 변의 용량은 **마지막 넷**의 그래프에서 처음 맞는 변의 것. 제자리 변 (t, t) 은 등록되지 않는다.
//! - `get_variables` 는 N+1 칸을 쓴다 (C++ 은 N 칸 배열) — N+1 칸을 잡는다.
//! - 해가 정확히 1.0 인 변수만 고른다. 못 고른 넷은 STindex = 0 (기본값) 그대로.
#![allow(non_snake_case)]

use super::graph::GlobalGraph;
use super::{ub, valInfo, GcellGlobalRouter};
use crate::lp;

/// lprec 을 반드시 delete_lp 하도록
struct Lp(*mut lp::lprec);

impl Drop for Lp {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { lp::delete_lp(self.0) }
        }
    }
}

impl Lp {
    fn add(&self, row: &[f64], col: &[i32], constr_type: i32, rh: f64) {
        // C++ 은 add_constraintex 가 실패하면 로그만 남긴다
        let ok = unsafe { lp::add_constraintex(self.0, row.len() as i32, row.as_ptr(), col.as_ptr(), constr_type, rh) };
        if ok == 0 {
            crate::route::warn("GcellGlobalRouter ILP: add_constraintex 실패");
        }
    }
}

const IMPORTANT: i32 = 3;
const TRUE: lp::MYBOOL = 1;

impl GcellGlobalRouter {
    pub fn ILPSolveRouting(&mut self, graph: &GlobalGraph) -> Result<i32, String> {
        // 1. 후보마다 변수 하나
        let mut NumberOfSTs: i32 = 0;
        let mut NumberOfNets: i32 = 0;
        let mut vi = valInfo::default();
        for h in 0..self.Nets.len() {
            vi.netIter = h as i32;
            for i in 0..self.Nets[h].STs.len() {
                vi.STIter = i as i32;
                vi.candIter = -1;
                vi.segIter = -1;
                vi.valIter = NumberOfSTs;
                self.Nets[h].STs[i].valIdx = NumberOfSTs;
                NumberOfSTs += 1;
                self.ValArray.push(vi);
            }
            NumberOfNets += 1;
        }
        self.NumOfVar = NumberOfSTs;

        let lp = Lp(unsafe { lp::make_lp(0, self.NumOfVar + 1) });
        if lp.0.is_null() {
            return Err("GcellGlobalRouter ILP: make_lp 실패".into());
        }
        unsafe {
            lp::set_verbose(lp.0, IMPORTANT);
            // put_logfunc(lpsolve_logger) 는 로그만 옮긴다 — 뺀다
            lp::set_outputfile(lp.0, c"/dev/null".as_ptr());
        }

        // 2. 넷마다 sum x = 1
        for CurNet in 0..NumberOfNets {
            let mut temp_row = Vec::new();
            let mut temp_index = Vec::new();
            for (j, n) in self.Nets.iter().enumerate() {
                for st in &n.STs {
                    if j as i32 == CurNet {
                        temp_index.push(st.valIdx + 1);
                        temp_row.push(1.0);
                    }
                }
            }
            if temp_row.is_empty() {
                continue;
            }
            lp.add(&temp_row, &temp_index, lp::EQ, 1.0);
        }

        // 3. 대칭: x(짝, j) - x(넷, j) = 0 (MirrorSymSTs 가 global_sym 을 -1 로 돌려 놓아 실제로는 안 생긴다)
        for i in 0..self.Nets.len() {
            let global_sym = self.Nets[i].global_sym;
            if global_sym != -1 && global_sym < self.Nets.len() as i32 - 1 {
                let gs = usize::try_from(global_sym).map_err(|_| format!("std::out_of_range: vector (Nets[{global_sym}])"))?;
                for j in 0..self.Nets[i].STs.len() {
                    let sy = self.Nets[gs].STs.get(j).ok_or_else(|| ub(format!("ILP: Nets[{gs}].STs[{j}]")))?.valIdx;
                    let me = self.Nets[i].STs[j].valIdx;
                    let mut temp_row = Vec::new();
                    let mut temp_index = Vec::new();
                    for val_number in 0..NumberOfSTs {
                        if val_number == sy {
                            temp_index.push(sy + 1);
                            temp_row.push(1.0);
                        } else if val_number == me {
                            temp_index.push(me + 1);
                            temp_row.push(-1.0);
                        }
                    }
                    if temp_row.is_empty() {
                        return Err(ub("ILP: 빈 대칭 행 (&temp_row[0])"));
                    }
                    lp.add(&temp_row, &temp_index, lp::EQ, 0.0);
                }
            }
        }

        // 4. 변 용량: 변마다 sum x - cap * s <= 0
        let mut Edges: Vec<(i32, i32)> = Vec::new();
        let mut Capacities: Vec<i32> = Vec::new();
        let mut Edges_To_Var: Vec<Vec<i32>> = Vec::new();
        NumberOfSTs = 0;
        for i in 0..self.Nets.len() {
            for j in 0..self.Nets[i].STs.len() {
                NumberOfSTs += 1;
                for &(a, b) in &self.Nets[i].STs[j].path {
                    let mut found = false;
                    let mut index = 0;
                    for (l, e) in Edges.iter().enumerate() {
                        if (a == e.0 && b == e.1) || (a == e.1 && b == e.0) {
                            found = true;
                            index = l;
                            break;
                        }
                    }
                    if found {
                        Edges_To_Var[index].push(NumberOfSTs);
                    } else {
                        let node = usize::try_from(a)
                            .ok()
                            .and_then(|a| graph.graph.get(a))
                            .ok_or_else(|| ub(format!("ILP: graph.graph[{a}] (크기 {})", graph.graph.len())))?;
                        for e in &node.list {
                            if e.dest == b {
                                Capacities.push(e.capacity);
                                Edges.push((a, b));
                                Edges_To_Var.push(Vec::new());
                                break;
                            }
                        }
                    }
                }
            }
        }
        for i in 0..Edges_To_Var.len() {
            let mut temp_row = Vec::new();
            let mut temp_index = Vec::new();
            for j in 0..NumberOfSTs {
                if Edges_To_Var[i].contains(&j) {
                    temp_index.push(j + 1);
                    temp_row.push(1.0);
                }
            }
            temp_index.push(NumberOfSTs + 1);
            temp_row.push(f64::from(Capacities[i].wrapping_neg()));
            lp.add(&temp_row, &temp_index, lp::LE, 0.0);
        }

        // 5. 이진 변수, s 는 [0, 1], 목적 = min s
        unsafe {
            for i in 1..=self.NumOfVar {
                lp::set_binary(lp.0, i, TRUE);
            }
            lp::set_bounds(lp.0, self.NumOfVar + 1, 0.0, 1.0);
            let row = [1.0f64];
            let col = [self.NumOfVar + 1];
            if lp::set_obj_fnex(lp.0, 1, row.as_ptr(), col.as_ptr()) == 0 {
                crate::route::warn("GcellGlobalRouter ILP: Objective insertion Error");
            }
            lp::set_minim(lp.0);
            lp::set_timeout(lp.0, 60);
            let loops = lp::get_presolveloops(lp.0);
            lp::set_presolve(lp.0, lp::PRESOLVE_PROBEFIX | lp::PRESOLVE_ROWDOMINATE, loops);
        }
        let ret = unsafe { lp::solve(lp.0) };
        if ret != lp::OPTIMAL {
            let what = match ret {
                lp::INFEASIBLE => "Model is Infeasible",
                lp::SUBOPTIMAL => "Suboptimal Solution Found",
                -2 => "Out of memory",
                7 => "Timeout",
                _ => "기타",
            };
            crate::route::warn(format!("GcellGlobalRouter ILP ({}): solve = {ret} ({what})", self.topName));
        }

        // 6. 해가 정확히 1 인 변수의 후보를 고른다
        let n = usize::try_from(self.NumOfVar).unwrap_or(0);
        let mut Vars = vec![0.0f64; n + 1];
        let ncol = unsafe { lp::get_Ncolumns(lp.0) };
        if (ncol as usize) > n + 1 {
            return Err(ub(format!("ILP: get_variables 가 {ncol} 칸을 쓴다")));
        }
        if (ncol as usize) < n + 1 {
            // presolve 가 열을 지우면 C++ 은 뒤쪽을 초기화 안 된 채로 읽는다 (여기서는 0)
            crate::route::warn(format!("GcellGlobalRouter ILP ({}): presolve 뒤 열 {ncol} < {}", self.topName, n + 1));
        }
        unsafe {
            lp::get_variables(lp.0, Vars.as_mut_ptr());
        }
        for i in 0..n {
            if Vars[i] == 1.0 {
                let v = self.ValArray[i];
                let net = super::at_mut(&mut self.Nets, v.netIter, "Nets")?;
                net.STindex = v.STIter;
            }
        }
        drop(lp);
        Ok(ret)
    }
}
