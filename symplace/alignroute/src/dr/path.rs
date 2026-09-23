//! 경로 -> 금속·비아 (GcellDetailRouter.cpp:516-679, 1540-1600, 3039-3627, 4094-4125).
//!
//! 연결 하나가 찾아지면 (returnPath_new, InsertRoutingContact):
//! - 넷의 path_metal 전체의 사각형을 다시 구하고 (길이 0 이면 비아 둘러싸기), 비아를 **다시 전부** 뽑아
//!   path_via 에 덧붙인다 — 연결마다 두 번씩, 비우지 않는다 (중복이 그대로 나간다).
//! - label 로 짧은 토막을 늘리는 것(ExtendMetals)도 넷 전체에 거듭 걸린다 (LinePoint 를 고친다).
//! - 이번 연결의 경로(physical_path)는 따로 방향대로 사각형을 구하고 비아를 뽑아 한 번 늘린다 — 다음
//!   연결의 출발에 들어간다.
use super::GcellDetailRouter;
use super::rect::{C5, P3};
use crate::rdb::{Metal, Via, contact, point};
use std::collections::BTreeSet;

fn vm_pt(r: &[crate::db::Point], i: usize) -> Result<point, String> {
    r.get(i).map(|p| point::new(p.x, p.y)).ok_or_else(|| "GcellDetailRouter: 비아 모형 사각형이 비었다 (C++ 은 범위 밖을 읽는다)".to_string())
}

/// UpdateMetalContact — 두 점의 y 가 같으면 가로로 보고 (폭의 반만큼 위아래), 아니면 세로로. 끝은 늘리지 않는다.
pub(crate) fn UpdateMetalContact(m: &mut Metal) {
    let (p0, p1, h) = (m.LinePoint[0], m.LinePoint[1], m.width / 2);
    let r = &mut m.MetalRect;
    r.metal = m.MetalIdx;
    r.placedCenter = point::new(p0.x.wrapping_add(p1.x) / 2, p0.y.wrapping_add(p1.y) / 2);
    if p0.y == p1.y {
        if p0.x < p1.x {
            (r.placedLL, r.placedUR) = (point::new(p0.x, p0.y.wrapping_sub(h)), point::new(p1.x, p1.y.wrapping_add(h)));
        } else {
            (r.placedLL, r.placedUR) = (point::new(p1.x, p1.y.wrapping_sub(h)), point::new(p0.x, p0.y.wrapping_add(h)));
        }
    } else if p0.y < p1.y {
        (r.placedLL, r.placedUR) = (point::new(p0.x.wrapping_sub(h), p0.y), point::new(p1.x.wrapping_add(h), p1.y));
    } else {
        (r.placedLL, r.placedUR) = (point::new(p1.x.wrapping_sub(h), p1.y), point::new(p0.x.wrapping_add(h), p0.y));
    }
}

/// ExtendX — 양끝을 d 씩
fn ExtendX(m: &mut Metal, d: i32) {
    if m.LinePoint[0].x < m.LinePoint[1].x {
        m.LinePoint[0].x = m.LinePoint[0].x.wrapping_sub(d);
        m.LinePoint[1].x = m.LinePoint[1].x.wrapping_add(d);
    } else {
        m.LinePoint[0].x = m.LinePoint[0].x.wrapping_add(d);
        m.LinePoint[1].x = m.LinePoint[1].x.wrapping_sub(d);
    }
    UpdateMetalContact(m);
}

/// ExtendY — 양끝을 d 씩
fn ExtendY(m: &mut Metal, d: i32) {
    if m.LinePoint[0].y < m.LinePoint[1].y {
        m.LinePoint[0].y = m.LinePoint[0].y.wrapping_sub(d);
        m.LinePoint[1].y = m.LinePoint[1].y.wrapping_add(d);
    } else {
        m.LinePoint[0].y = m.LinePoint[0].y.wrapping_add(d);
        m.LinePoint[1].y = m.LinePoint[1].y.wrapping_sub(d);
    }
    UpdateMetalContact(m);
}

/// ExtendX_PN — P 면 x 가 큰 쪽 끝을 늘리고, 아니면 작은 쪽 끝을 늘린다
fn ExtendX_PN(m: &mut Metal, d: i32, P: bool) {
    if P {
        if m.LinePoint[0].x < m.LinePoint[1].x {
            m.LinePoint[1].x = m.LinePoint[1].x.wrapping_add(d);
        } else {
            m.LinePoint[0].x = m.LinePoint[0].x.wrapping_add(d);
        }
    } else if m.LinePoint[0].x < m.LinePoint[1].x {
        m.LinePoint[0].x = m.LinePoint[0].x.wrapping_sub(d);
    } else {
        m.LinePoint[1].x = m.LinePoint[1].x.wrapping_sub(d);
    }
    UpdateMetalContact(m);
}

/// ExtendY_PN — P 면 y 가 큰 쪽 끝을 늘리고, 아니면 작은 쪽 끝을 늘린다
fn ExtendY_PN(m: &mut Metal, d: i32, P: bool) {
    if P {
        if m.LinePoint[0].y < m.LinePoint[1].y {
            m.LinePoint[1].y = m.LinePoint[1].y.wrapping_add(d);
        } else {
            m.LinePoint[0].y = m.LinePoint[0].y.wrapping_add(d);
        }
    } else if m.LinePoint[0].y < m.LinePoint[1].y {
        m.LinePoint[0].y = m.LinePoint[0].y.wrapping_sub(d);
    } else {
        m.LinePoint[1].y = m.LinePoint[1].y.wrapping_sub(d);
    }
    UpdateMetalContact(m);
}

impl GcellDetailRouter<'_> {
    fn direct_minL(&self, m: i32) -> Result<(i32, i32), String> {
        usize::try_from(m)
            .ok()
            .and_then(|u| self.drc_info.Metal_info.get(u))
            .map(|mi| (mi.direct, mi.minL))
            .ok_or_else(|| format!("GcellDetailRouter: 층 {m} 이 없다 (C++ 은 Metal_info[{m}] 을 읽는다)"))
    }

    /// ExtendMetals / ExtendMetalsPhysicalPath 의 몸통: label 1 은 양쪽으로 (int)(ceil(minL - len) / 2), 2 는
    /// 큰 쪽 끝, 3 은 작은 쪽 끝으로 minL - len. 4 는 기록만 ("Extend Error").
    pub(crate) fn ExtendByLabel(&self, m: &mut Metal, label: i32) -> Result<(), String> {
        if label == 0 {
            return Ok(());
        }
        let (direction, minL) = self.direct_minL(m.MetalIdx)?;
        let current_length = m.LinePoint[0]
            .x
            .wrapping_sub(m.LinePoint[1].x)
            .wrapping_abs()
            .wrapping_add(m.LinePoint[0].y.wrapping_sub(m.LinePoint[1].y).wrapping_abs());
        if current_length < minL && label == 1 {
            let extend_dis = super::util::f2i((minL.wrapping_sub(current_length) as f64).ceil() / 2.0);
            if direction == 1 {
                ExtendX(m, extend_dis);
            } else {
                ExtendY(m, extend_dis);
            }
        } else if current_length < minL && label == 2 {
            let extend_dis = minL.wrapping_sub(current_length);
            if direction == 1 {
                ExtendX_PN(m, extend_dis, true);
            } else {
                ExtendY_PN(m, extend_dis, true);
            }
        } else if current_length < minL && label == 3 {
            let extend_dis = minL.wrapping_sub(current_length);
            if direction == 1 {
                ExtendX_PN(m, extend_dis, false);
            } else {
                ExtendY_PN(m, extend_dis, false);
            }
        }
        Ok(())
    }

    /// GcellDetailRouter::ExtendMetals — 넷의 path_metal 전체에 label 대로 (연결마다 거듭 걸린다)
    pub(crate) fn ExtendMetals(&mut self, i: usize) -> Result<(), String> {
        // path_metal 과 extend_label 의 길이가 다르면 assert(0) (꺼져 있다) — 이 흐름에서는 늘 같다
        let mut metals = std::mem::take(&mut self.Nets[i].path_metal);
        let labels = self.Nets[i].extend_label.clone();
        let mut r = Ok(());
        for (j, m) in metals.iter_mut().enumerate() {
            let label = labels.get(j).copied().unwrap_or(0);
            if let Err(e) = self.ExtendByLabel(m, label) {
                r = Err(e);
                break;
            }
        }
        self.Nets[i].path_metal = metals;
        r
    }

    /// GcellDetailRouter::UpdateVia — 비아 모형으로 세 사각형을 채운다 (origin 은 그대로)
    pub(crate) fn UpdateVia(&self, v: &mut Via) -> Result<(), String> {
        let vm = usize::try_from(v.model_index)
            .ok()
            .and_then(|u| self.drc_info.Via_model.get(u))
            .ok_or_else(|| format!("GcellDetailRouter: Via_model[{}] 이 없다", v.model_index))?;
        let at = |r: &[crate::db::Point], k: usize| -> Result<point, String> {
            let p = vm_pt(r, k)?;
            Ok(point::new(p.x.wrapping_add(v.position.x), p.y.wrapping_add(v.position.y)))
        };
        let (vl, vu) = (at(&vm.ViaRect, 0)?, at(&vm.ViaRect, 1)?);
        let (ll, lu) = (at(&vm.LowerRect, 0)?, at(&vm.LowerRect, 1)?);
        let (ul, uu) = (at(&vm.UpperRect, 0)?, at(&vm.UpperRect, 1)?);
        v.ViaRect = contact { metal: v.model_index, placedCenter: v.position, placedLL: vl, placedUR: vu, ..v.ViaRect };
        v.LowerMetalRect = contact { metal: vm.LowerIdx, placedCenter: v.position, placedLL: ll, placedUR: lu, ..v.LowerMetalRect };
        v.UpperMetalRect = contact { metal: vm.UpperIdx, placedCenter: v.position, placedLL: ul, placedUR: uu, ..v.UpperMetalRect };
        Ok(())
    }

    /// 금속 목록에서 층이 하나 차이 나고 끝점이 겹치는 쌍마다 비아 (ViaComp 순, 같은 것은 하나)
    fn vias_of(&self, path: &[&Metal]) -> Result<Vec<Via>, String> {
        let mut set_via: BTreeSet<(i32, i32, i32)> = BTreeSet::new();
        for (h, a) in path.iter().enumerate() {
            for (l, b) in path.iter().enumerate() {
                if l == h || a.MetalIdx != b.MetalIdx.wrapping_sub(1) {
                    continue;
                }
                for pa in [a.LinePoint[0], a.LinePoint[1]] {
                    for pb in [b.LinePoint[0], b.LinePoint[1]] {
                        if pa.x == pb.x && pa.y == pb.y {
                            set_via.insert((a.MetalIdx, pa.x, pa.y));
                        }
                    }
                }
            }
        }
        let mut out = Vec::new();
        for (mi, x, y) in set_via {
            let mut v = Via { model_index: mi, position: point::new(x, y), ..Via::default() };
            self.UpdateVia(&mut v)?;
            out.push(v);
        }
        Ok(out)
    }

    /// GcellDetailRouter::GetPhsical_Metal_Via (GcellDetailRouter.cpp:3505-3627) — 넷의 path_metal 전체의
    /// 사각형을 다시 구하고(길이 0 이면 그 층을 아래층으로 하는 비아 모형의 둘러싸기), 비아를 전부 뽑아
    /// path_via 에 덧붙인다
    pub(crate) fn GetPhsical_Metal_Via(&mut self, i: usize) -> Result<(), String> {
        let nvm = self.drc_info.Via_model.len() as i32;
        for h in 0..self.Nets[i].path_metal.len() {
            let mut m = self.Nets[i].path_metal[h].clone();
            let (p0, p1, w2) = (m.LinePoint[0], m.LinePoint[1], m.width / 2);
            m.MetalRect.metal = m.MetalIdx;
            m.MetalRect.placedCenter = point::new(p0.x.wrapping_add(p1.x) / 2, p0.y.wrapping_add(p1.y) / 2);
            let r = &mut m.MetalRect;
            if p0.y == p1.y {
                if p0.x < p1.x {
                    (r.placedLL, r.placedUR) = (point::new(p0.x, p0.y.wrapping_sub(w2)), point::new(p1.x, p1.y.wrapping_add(w2)));
                } else {
                    (r.placedLL, r.placedUR) = (point::new(p1.x, p1.y.wrapping_sub(w2)), point::new(p0.x, p0.y.wrapping_add(w2)));
                }
            } else if p0.y < p1.y {
                (r.placedLL, r.placedUR) = (point::new(p0.x.wrapping_sub(w2), p0.y), point::new(p1.x.wrapping_add(w2), p1.y));
            } else {
                (r.placedLL, r.placedUR) = (point::new(p1.x.wrapping_sub(w2), p1.y), point::new(p0.x.wrapping_add(w2), p0.y));
            }
            if p0.y == p1.y && p0.x == p1.x {
                let k = m.MetalRect.metal;
                let rect = if k >= 0 && k < nvm {
                    let v = &self.drc_info.Via_model[k as usize];
                    Some((vm_pt(&v.LowerRect, 0)?, vm_pt(&v.LowerRect, 1)?))
                } else if k == nvm {
                    let v = &self.drc_info.Via_model[(k - 1) as usize];
                    Some((vm_pt(&v.UpperRect, 0)?, vm_pt(&v.UpperRect, 1)?))
                } else {
                    None
                };
                if let Some((a, b)) = rect {
                    m.MetalRect.placedLL = point::new(p0.x.wrapping_add(a.x), p0.y.wrapping_add(a.y));
                    m.MetalRect.placedUR = point::new(p1.x.wrapping_add(b.x), p1.y.wrapping_add(b.y));
                }
            }
            self.Nets[i].path_metal[h] = m;
        }
        let vias = {
            let refs: Vec<&Metal> = self.Nets[i].path_metal.iter().collect();
            self.vias_of(&refs)?
        };
        self.Nets[i].path_via.extend(vias);
        Ok(())
    }

    /// GcellDetailRouter::GetPhsical_Metal (GcellDetailRouter.cpp:4094-4125) — 층 방향대로 (폭의 반만큼 옆으로,
    /// 끝은 늘리지 않는다). MetalRect.metal 은 건드리지 않는다.
    pub(crate) fn GetPhsical_Metal(&self, physical_path: &mut [Vec<Metal>]) -> Result<(), String> {
        for path in physical_path.iter_mut() {
            for m in path.iter_mut() {
                let (direct, _) = self.direct_minL(m.MetalIdx)?;
                let (p0, p1, h) = (m.LinePoint[0], m.LinePoint[1], m.width / 2);
                let r = &mut m.MetalRect;
                if direct == 1 {
                    if p0.x <= p1.x {
                        (r.placedLL, r.placedUR) = (point::new(p0.x, p0.y.wrapping_sub(h)), point::new(p1.x, p1.y.wrapping_add(h)));
                    } else {
                        (r.placedLL, r.placedUR) = (point::new(p1.x, p1.y.wrapping_sub(h)), point::new(p0.x, p0.y.wrapping_add(h)));
                    }
                } else if p0.y <= p1.y {
                    (r.placedLL, r.placedUR) = (point::new(p0.x.wrapping_sub(h), p0.y), point::new(p1.x.wrapping_add(h), p1.y));
                } else {
                    (r.placedLL, r.placedUR) = (point::new(p1.x.wrapping_sub(h), p1.y), point::new(p0.x.wrapping_add(h), p0.y));
                }
            }
        }
        Ok(())
    }

    /// GcellDetailRouter::returnPath_new (GcellDetailRouter.cpp:516-535)
    pub(crate) fn returnPath_new(&mut self, temp_path: &mut [Vec<Metal>], net_index: usize, extend_labels: &[Vec<i32>],
                                 temp_via: &mut Vec<Via>) -> Result<(), String> {
        for (i, p) in temp_path.iter().enumerate() {
            for (j, m) in p.iter().enumerate() {
                self.Nets[net_index].path_metal.push(m.clone());
                let label = extend_labels
                    .get(i)
                    .and_then(|l| l.get(j))
                    .copied()
                    .ok_or_else(|| "returnPath_new: extend_labels 가 경로보다 짧다 (C++ 은 범위 밖을 읽는다)".to_string())?;
                self.Nets[net_index].extend_label.push(label);
            }
        }
        self.GetPhsical_Metal_Via(net_index)?;
        self.ExtendMetals(net_index)?;
        self.GetPhsical_Metal(temp_path)?;
        // Obtain_vias: 이번 경로의 비아 (평평하게 펴서)
        let vias = {
            let flat: Vec<&Metal> = temp_path.iter().flatten().collect();
            self.vias_of(&flat)?
        };
        temp_via.extend(vias);
        // ExtendMetalsPhysicalPath
        for (i, p) in temp_path.iter_mut().enumerate() {
            for (j, m) in p.iter_mut().enumerate() {
                self.ExtendByLabel(m, extend_labels[i][j])?;
            }
        }
        Ok(())
    }

    /// GcellDetailRouter::InsertRoutingVia — 경로에서 같은 자리의 층 바꿈마다 (아래층, x, y)
    pub(crate) fn InsertRoutingVia(path: &[Vec<i32>], grid: &super::grid::Grid, Pset_via: &mut BTreeSet<P3>) {
        let vt = &grid.vertices_total;
        for p in path {
            for w in p.windows(2) {
                let (a, b) = (&vt[w[0] as usize], &vt[w[1] as usize]);
                if a.metal == b.metal {
                    continue;
                }
                if a.x != b.x || a.y != b.y {
                    continue;
                }
                Pset_via.insert((a.metal.min(b.metal), a.x, a.y));
            }
        }
    }

    /// GcellDetailRouter::InsertRoutingContact (GcellDetailRouter.cpp:1561-1600) — 넷 전체의 사각형을 다시
    /// 구하고(비아를 한 번 더 덧붙인다) 늘린 뒤, 금속 사각형과 이 넷 비아(지금까지 전부)의 위·아래 사각형을 넣는다
    pub(crate) fn InsertRoutingContact(&mut self, Pset_via: &BTreeSet<P3>, contacts: &mut BTreeSet<C5>, net_num: usize) -> Result<(), String> {
        self.GetPhsical_Metal_Via(net_num)?;
        self.ExtendMetals(net_num)?;
        for m in &self.Nets[net_num].path_metal {
            let (ll, ur) = (m.MetalRect.placedLL, m.MetalRect.placedUR);
            contacts.insert((ll.x, ll.y, m.MetalIdx, ur.x, ur.y));
        }
        for &(k, x, y) in Pset_via {
            let v = usize::try_from(k)
                .ok()
                .and_then(|u| self.drc_info.Via_model.get(u))
                .ok_or_else(|| format!("GcellDetailRouter: Via_model[{k}] 이 없다"))?;
            let (l0, l1) = (vm_pt(&v.LowerRect, 0)?, vm_pt(&v.LowerRect, 1)?);
            contacts.insert((x.wrapping_add(l0.x), y.wrapping_add(l0.y), k, x.wrapping_add(l1.x), y.wrapping_add(l1.y)));
            let (u0, u1) = (vm_pt(&v.UpperRect, 0)?, vm_pt(&v.UpperRect, 1)?);
            contacts.insert((x.wrapping_add(u0.x), y.wrapping_add(u0.y), k + 1, x.wrapping_add(u1.x), y.wrapping_add(u1.y)));
        }
        Ok(())
    }
}
