//! 모드 3 — 전원 배선 (PowerRouter::PowerNetRouter, PowerRouter.cpp:112-618, 783-1002, 1127-1236,
//! 1837-1908).
//!
//! 전원 넷의 핀마다 따로: 자기 극성 격자의 가장 낮은 층(M5) 토막 가운데 가까운 7 개(거리 키 std::map 이라
//! 같은 거리는 하나로)를 도착으로, 그 둘레 창에 M1~M6 격자를 쳐 A* 로 잇는다. 핀마다 넷 전체의
//! 사각형·비아를 다시 구해 비아를 덧붙이고(중복이 그대로 남는다), 끝나면 한 번 더 덧붙인다.
use super::PowerRouter;
use super::astar::A_star;
use super::detail::{C5, InsertPlistToSet_x, P3, c5};
use super::grid::{Grid, Sink};
use super::util::FxSet;
use crate::db::{DrcInfo, HierNode};
use crate::rdb::{ByVia, Metal, PowerGrid, Via, point};
use std::collections::{BTreeMap, BTreeSet};

impl PowerRouter {
    /// PowerRouter::PowerNetRouter (PowerRouter.cpp:509-618)
    pub(crate) fn PowerNetRouter(&mut self, node: &HierNode, drc: &DrcInfo, Lmetal: i32, Hmetal: i32) -> Result<(), String> {
        self.GetData(node, drc, Lmetal, Hmetal);
        let layerNo = self.layerNo as usize;
        // calculate_extension_length 의 결과는 이 길에서 읽히지 않는다

        let mut plist = vec![Vec::new(); layerNo];
        self.CreatePlistBlocks(&mut plist);
        self.CreatePlistTerminals(&mut plist);
        self.CreatePlistPowerGrid(&mut plist, &self.Vdd_grid);
        self.CreatePlistPowerGrid(&mut plist, &self.Gnd_grid);
        let mut Set_x: FxSet<P3> = FxSet::default();
        let mut Set_x_contact: BTreeSet<C5> = BTreeSet::new();
        InsertPlistToSet_x(&mut Set_x, &plist);

        let mut netplist = vec![Vec::new(); layerNo];
        self.CreatePlistPowerNets(&mut netplist);
        self.CreatePlistNets(&mut netplist);
        let mut Set_net: FxSet<P3> = FxSet::default();
        let mut Set_net_contact: BTreeSet<C5> = BTreeSet::new();
        InsertPlistToSet_x(&mut Set_net, &netplist);

        let mut Pset_via: BTreeSet<P3> = BTreeSet::new();
        // InsertInternalVia (블록마다 내부 비아, 핀 비아), InsertInternalVia_PowerGrid(Vdd, Gnd), InsertInternalVia_Net
        for b in &self.Blocks {
            for v in &b.InternalVia {
                Pset_via.insert((v.model_index, v.position.x, v.position.y));
            }
            for p in &b.pins {
                for v in &p.pinVias {
                    Pset_via.insert((v.model_index, v.position.x, v.position.y));
                }
            }
        }
        for g in [&self.Vdd_grid, &self.Gnd_grid] {
            for v in &g.vias {
                Pset_via.insert((v.model_index, v.position.x, v.position.y));
            }
        }
        for n in &self.Nets {
            for v in &n.path_via {
                Pset_via.insert((v.model_index, v.position.x, v.position.y));
            }
        }

        let drc_local = self.drc_info.clone();
        for i in 0..self.PowerNets.len() {
            if self.PowerNets[i].DoNotRoute {
                continue;
            }
            let multi_number = self.FindMulti_Connection_Number(i, node);
            for _multi_index in 0..multi_number {
                let mut Pset_current_net_via: BTreeSet<P3> = BTreeSet::new();
                let mut Set_current_net_contact: BTreeSet<C5> = BTreeSet::new();
                self.ReturnInternalMetalContact(&mut Set_x_contact, i);
                for j in 0..self.PowerNets[i].pins.len() {
                    let mut add_plist = vec![Vec::new(); layerNo];
                    if self.Vdd_grid.metals.is_empty() || self.Gnd_grid.metals.is_empty() {
                        // assert(0) 는 꺼져 있다 — 그대로 간다
                        crate::route::warn("Placement Area is too small, no space to create power grid");
                    }
                    let temp_pin_contacts: Vec<Sink> = self.PowerNets[i].pins[j]
                        .pinContacts
                        .iter()
                        .map(|c| Sink { metalIdx: c.metal, LL: c.placedLL, UR: c.placedUR })
                        .collect();
                    let (temp_source, temp_dest) = if self.PowerNets[i].power {
                        let g = std::mem::take(&mut self.Vdd_grid);
                        let r = self.SetSrcDest(&temp_pin_contacts, &g);
                        self.Vdd_grid = g;
                        r
                    } else {
                        let g = std::mem::take(&mut self.Gnd_grid);
                        let r = self.SetSrcDest(&temp_pin_contacts, &g);
                        self.Gnd_grid = g;
                        r
                    };
                    let (LL, UR) = (self.LL, self.UR);
                    let mut grid = Grid::new(&drc_local, LL, UR, self.lowest_metal, self.highest_metal, self.grid_scale);
                    // grid.Full_Connected_Vertex() — 평행 배선에서만 읽힌다 (grid.rs)
                    self.InactiveFindsetPlist(&mut grid, &Set_x, LL, UR);
                    grid.setSrcDest(&temp_source, &temp_dest, false);
                    grid.ActivateSourceDest();
                    self.InactiveFindsetPlist(&mut grid, &Set_net, LL, UR);
                    grid.setSrcDest(&temp_source, &temp_dest, true);
                    self.AddViaEnclosure(&mut grid, &Set_x_contact, &Set_net_contact, LL, UR, &temp_source, &temp_dest);
                    self.AddViaSpacing(&Pset_via, &mut grid, LL, UR);
                    let mut a_star = A_star::new(&grid, false);
                    let pathMark = a_star.FindFeasiblePath(&mut grid, self.path_number, 0, 0);
                    if let Some(why) = a_star.stuck.take() {
                        return Err(format!("모드 3 ({} 핀 {j}): {why}", self.PowerNets[i].netName));
                    }

                    let mut physical_path: Vec<Vec<Metal>> = Vec::new();
                    let mut extend_labels: Vec<Vec<i32>> = Vec::new();
                    if pathMark {
                        physical_path = a_star.ConvertPathintoPhysical(&grid);
                        extend_labels = a_star.GetExtendLabel();
                        let added_s = self.lastmile_source_new(&mut physical_path, &temp_source);
                        let added_d = self.lastmile_dest_new(&mut physical_path, &temp_dest);
                        if added_s || added_d {
                            // label 없이 금속이 늘었다 — C++ 은 extend_labels 를 범위 밖에서 읽는다
                            crate::route::warn(format!("power net {}: lastmile 금속이 덧붙었다 (label 없음)", self.PowerNets[i].netName));
                        }
                        self.returnPath(&physical_path, i, &extend_labels);
                        let path = a_star.GetPath();
                        InsertRoutingVia(&path, &grid, &mut Pset_current_net_via);
                        InsertRoutingVia(&path, &grid, &mut Pset_via);
                        self.InsertRoutingContact(&Pset_current_net_via, &mut Set_current_net_contact, i);
                    } else {
                        crate::route::warn(format!("Router-Warning: feasible path might not be found. net name {}", self.PowerNets[i].netName));
                    }
                    self.UpdatePlistNets(&mut physical_path, &mut add_plist, &extend_labels);
                    InsertPlistToSet_x(&mut Set_net, &add_plist);
                    Set_net_contact.extend(Set_current_net_contact.iter().copied());
                }
            }
        }
        Ok(())
    }

    /// PowerRouter::FindMulti_Connection_Number — MultiConnection 제약 (없으면 1)
    fn FindMulti_Connection_Number(&self, j: usize, node: &HierNode) -> i32 {
        node.Multi_connections.iter().find(|m| m.net_name == self.PowerNets[j].netName).map(|m| m.multi_number).unwrap_or(1)
    }

    /// PowerRouter::ReturnInternalMetalContact (PowerRouter.cpp:415-462) — 블록 내부 금속, 핀 접점, 핀 비아의
    /// 위·아래, 신호 넷 금속과 비아의 위·아래. 이 넷의 핀 접점·핀 비아는 뺀다. (내부 비아는 넣지 않는다)
    fn ReturnInternalMetalContact(&self, Set_x_contact: &mut BTreeSet<C5>, net_num: usize) {
        Set_x_contact.clear();
        for b in &self.Blocks {
            for c in &b.InternalMetal {
                Set_x_contact.insert(c5(c));
            }
            for p in &b.pins {
                for c in &p.pinContacts {
                    Set_x_contact.insert(c5(c));
                }
                for v in &p.pinVias {
                    Set_x_contact.insert(c5(&v.UpperMetalRect));
                    Set_x_contact.insert(c5(&v.LowerMetalRect));
                }
            }
        }
        for n in &self.Nets {
            for m in &n.path_metal {
                Set_x_contact.insert(c5(&m.MetalRect));
            }
            for v in &n.path_via {
                Set_x_contact.insert(c5(&v.UpperMetalRect));
                Set_x_contact.insert(c5(&v.LowerMetalRect));
            }
        }
        for p in &self.PowerNets[net_num].pins {
            for c in &p.pinContacts {
                Set_x_contact.remove(&c5(c));
            }
            for v in &p.pinVias {
                Set_x_contact.remove(&c5(&v.UpperMetalRect));
                Set_x_contact.remove(&c5(&v.LowerMetalRect));
            }
        }
    }

    /// PowerRouter::SetSrcDest (PowerRouter.cpp:867-1002) — 출발은 핀 접점들, 도착은 격자에서 가장 낮은
    /// 층 금속 가운데 핀 중심과의 맨해튼 거리 순 7 개 (거리가 같으면 먼저 나온 하나만). 창(LL, UR 멤버)은
    /// 둘을 다 품는 상자를 10 칸씩 넓혀 [0, width] x [0, height] 로 자른 것.
    fn SetSrcDest(&mut self, pinContacts: &[Sink], Vdd_grid: &PowerGrid) -> (Vec<Sink>, Vec<Sink>) {
        let expand_scale = 10;
        let temp_source: Vec<Sink> = pinContacts.to_vec();
        let mut lowest_metal_index = i32::MAX;
        for m in &Vdd_grid.metals {
            if m.MetalIdx < lowest_metal_index {
                lowest_metal_index = m.MetalIdx;
            }
        }
        let mut dist_pair: BTreeMap<i32, usize> = BTreeMap::new();
        for s in &temp_source {
            let sp = point::new((s.LL.x + s.UR.x) / 2, (s.LL.y + s.UR.y) / 2);
            for (j, m) in Vdd_grid.metals.iter().enumerate() {
                let dp = point::new((m.LinePoint[0].x + m.LinePoint[1].x) / 2, (m.LinePoint[0].y + m.LinePoint[1].y) / 2);
                if m.MetalIdx == lowest_metal_index {
                    let dis = (sp.x - dp.x).abs() + (sp.y - dp.y).abs();
                    dist_pair.entry(dis).or_insert(j);
                }
            }
        }
        let src_index_number = 7;
        let temp_dest: Vec<Sink> = dist_pair
            .values()
            .take(src_index_number)
            .map(|&index| {
                let m = &Vdd_grid.metals[index];
                Sink { metalIdx: m.MetalIdx, LL: m.MetalRect.placedLL, UR: m.MetalRect.placedUR }
            })
            .collect();

        let mut temp_ll = point::new(i32::MAX, i32::MAX);
        let mut temp_ur = point::new(i32::MIN, i32::MIN);
        for s in temp_dest.iter().chain(temp_source.iter()) {
            for c in [s.LL, s.UR] {
                temp_ll.x = temp_ll.x.min(c.x);
                temp_ll.y = temp_ll.y.min(c.y);
                temp_ur.x = temp_ur.x.max(c.x);
                temp_ur.y = temp_ur.y.max(c.y);
            }
        }
        let MI = &self.drc_info.Metal_info;
        let hm = self.highest_metal as usize;
        let (xMar, yMar) = if MI[hm].direct == 0 {
            (MI[hm].grid_unit_x * self.grid_scale, MI[hm - 1].grid_unit_y * self.grid_scale)
        } else {
            (MI[hm - 1].grid_unit_x * self.grid_scale, MI[hm].grid_unit_y * self.grid_scale)
        };
        let ex = expand_scale * xMar;
        let ey = expand_scale * yMar;
        self.LL.x = if temp_ll.x.wrapping_sub(ex) < 0 { 0 } else { temp_ll.x.wrapping_sub(ex) };
        self.LL.y = if temp_ll.y.wrapping_sub(ey) < 0 { 0 } else { temp_ll.y.wrapping_sub(ey) };
        self.UR.x = if temp_ur.x.wrapping_add(ex) > self.width { self.width } else { temp_ur.x.wrapping_add(ex) };
        self.UR.y = if temp_ur.y.wrapping_add(ey) > self.height { self.height } else { temp_ur.y.wrapping_add(ey) };
        (temp_source, temp_dest)
    }

    /// PowerRouter::returnPath — 경로 금속과 늘리기 label 을 넷에 덧붙인다
    fn returnPath(&mut self, temp_path: &[Vec<Metal>], net: usize, extend_labels: &[Vec<i32>]) {
        for (i, path) in temp_path.iter().enumerate() {
            for (j, m) in path.iter().enumerate() {
                self.PowerNets[net].path_metal.push(m.clone());
                // lastmile 이 금속을 덧대면 label 이 모자란다 (C++ 은 범위 밖을 읽는다)
                let label = extend_labels.get(i).and_then(|l| l.get(j)).copied().unwrap_or(0);
                self.PowerNets[net].extend_label.push(label);
            }
        }
    }

    /// PowerRouter::InsertRoutingContact (PowerRouter.cpp:112-155) — 넷 전체의 사각형·비아를 다시 구하고
    /// (비아는 덧붙는다) 늘린 뒤, 금속 사각형과 이 넷 비아의 아래·위 사각형을 접점으로. 아래 접점은
    /// VDD, 위 접점은 GND 병합 금속 안에 들면 뺀다 (넷의 극성과 상관없이).
    fn InsertRoutingContact(&mut self, Pset_via: &BTreeSet<P3>, contacts: &mut BTreeSet<C5>, net_num: usize) {
        self.GetPhsical_Metal_Via(net_num);
        self.ExtendMetals(net_num);
        for m in &self.PowerNets[net_num].path_metal {
            contacts.insert((m.MetalRect.placedLL.x, m.MetalRect.placedLL.y, m.MetalIdx, m.MetalRect.placedUR.x, m.MetalRect.placedUR.y));
        }
        for &(vi, x, y) in Pset_via {
            let vm = &self.drc_info.Via_model[vi as usize];
            let lower = (x + vm.LowerRect[0].x, y + vm.LowerRect[0].y, vi, x + vm.LowerRect[1].x, y + vm.LowerRect[1].y);
            if !self.RedundantContact(&lower, true) {
                contacts.insert(lower);
            }
            let upper = (x + vm.UpperRect[0].x, y + vm.UpperRect[0].y, vi + 1, x + vm.UpperRect[1].x, y + vm.UpperRect[1].y);
            if !self.RedundantContact(&upper, false) {
                contacts.insert(upper);
            }
        }
    }

    /// PowerRouter::RedundantContact — 같은 층 병합 격자 금속이 접점을 품나 (true 면 VDD, 아니면 GND)
    fn RedundantContact(&self, c: &C5, power_flag: bool) -> bool {
        let g = if power_flag { &self.Vdd_grid } else { &self.Gnd_grid };
        g.merged_metals.iter().any(|m| {
            m.MetalIdx == c.2
                && m.MetalRect.placedLL.x <= c.0
                && m.MetalRect.placedLL.y <= c.1
                && m.MetalRect.placedUR.x >= c.3
                && m.MetalRect.placedUR.y >= c.4
        })
    }

    /// PowerRouter::GetPhsical_Metal_Via (PowerRouter.cpp:1127-1236) — 금속 사각형(두 점의 y 가 같으면
    /// 가로로, 길이 0 이면 폭 x 폭)을 다시 구하고, 층이 하나 차이 나며 끝점이 겹치는 모든 쌍의 비아를
    /// ViaComp 순으로 path_via 에 덧붙인다
    fn GetPhsical_Metal_Via(&mut self, i: usize) {
        for m in self.PowerNets[i].path_metal.iter_mut() {
            let (p0, p1, h) = (m.LinePoint[0], m.LinePoint[1], m.width / 2);
            let r = &mut m.MetalRect;
            r.metal = m.MetalIdx;
            r.placedCenter = point::new((p0.x + p1.x) / 2, (p0.y + p1.y) / 2);
            if p0.y == p1.y {
                if p0.x < p1.x {
                    (r.placedLL, r.placedUR) = (point::new(p0.x, p0.y - h), point::new(p1.x, p1.y + h));
                } else {
                    (r.placedLL, r.placedUR) = (point::new(p1.x, p1.y - h), point::new(p0.x, p0.y + h));
                }
            } else if p0.y < p1.y {
                (r.placedLL, r.placedUR) = (point::new(p0.x - h, p0.y), point::new(p1.x + h, p1.y));
            } else {
                (r.placedLL, r.placedUR) = (point::new(p1.x - h, p1.y), point::new(p0.x + h, p0.y));
            }
            if p0.y == p1.y && p0.x == p1.x {
                (r.placedLL, r.placedUR) = (point::new(p0.x - h, p0.y - h), point::new(p1.x + h, p1.y + h));
            }
        }
        let mut set_via: BTreeSet<ByVia> = BTreeSet::new();
        let pm = &self.PowerNets[i].path_metal;
        for (h, a) in pm.iter().enumerate() {
            for (l, b) in pm.iter().enumerate() {
                if l == h || a.MetalIdx != b.MetalIdx - 1 {
                    continue;
                }
                for pa in [a.LinePoint[0], a.LinePoint[1]] {
                    for pb in [b.LinePoint[0], b.LinePoint[1]] {
                        if pa.x == pb.x && pa.y == pb.y {
                            let mut v = Via { model_index: a.MetalIdx, position: pa, ..Via::default() };
                            self.UpdateVia(&mut v);
                            set_via.insert(ByVia(v));
                        }
                    }
                }
            }
        }
        for v in set_via {
            self.PowerNets[i].path_via.push(v.0);
        }
    }

    /// PowerRouter::ExtendMetals — 넷의 모든 금속을 label 대로 (이미 늘린 것은 그대로다)
    fn ExtendMetals(&mut self, i: usize) {
        let mut pm = std::mem::take(&mut self.PowerNets[i].path_metal);
        for (j, m) in pm.iter_mut().enumerate() {
            // path_metal 과 extend_label 의 길이가 다르면 C++ 은 assert(0) (꺼져 있다) 뒤 범위 밖을 읽는다
            let label = self.PowerNets[i].extend_label.get(j).copied().unwrap_or(0);
            self.ExtendByLabel(m, label);
        }
        self.PowerNets[i].path_metal = pm;
    }

    /// PowerRouter::Physical_metal_via — 모든 넷의 비아를 한 번 더 덧붙인다
    pub(crate) fn Physical_metal_via(&mut self) {
        for i in 0..self.PowerNets.len() {
            self.GetPhsical_Metal_Via(i);
        }
    }

    /// PowerRouter::ExtendMetal
    pub(crate) fn ExtendMetal(&mut self) {
        for i in 0..self.PowerNets.len() {
            self.ExtendMetals(i);
        }
    }

    /// PowerRouter::ReturnPowerNetData (PowerRouter.cpp:1837-1908) — 이름이 처음 맞는 node.PowerNets 에
    /// 덧붙이고, 모듈 LL/UR 을 격자 금속·격자 비아(위·아래)·새 금속·새 비아까지 넓힌다
    pub(crate) fn ReturnPowerNetData(&self, node: &mut HierNode) {
        let mut minX = i32::MAX;
        let mut minY = i32::MAX;
        let mut maxX = i32::MIN;
        let mut maxY = i32::MIN;
        let mut grow = |c: &crate::db::Contact| {
            minX = minX.min(c.placedBox.LL.x);
            minY = minY.min(c.placedBox.LL.y);
            maxX = maxX.max(c.placedBox.UR.x);
            maxY = maxY.max(c.placedBox.UR.y);
        };
        for g in [&node.Vdd, &node.Gnd] {
            for m in &g.metals {
                grow(&m.MetalRect);
            }
            for v in &g.vias {
                grow(&v.LowerMetalRect);
                grow(&v.UpperMetalRect);
            }
        }
        for pn in &self.PowerNets {
            let Some(index) = node.PowerNets.iter().position(|p| p.name == pn.netName) else { continue };
            for m in &pn.path_metal {
                let temp_metal = self.ConvertToMetalPnRDB_Placed_Placed(m);
                grow(&temp_metal.MetalRect);
                node.PowerNets[index].path_metal.push(temp_metal);
            }
            for v in &pn.path_via {
                let temp_via = self.ConvertToViaPnRDB_Placed_Placed(v);
                grow(&temp_via.LowerMetalRect);
                grow(&temp_via.UpperMetalRect);
                node.PowerNets[index].path_via.push(temp_via);
            }
        }
        if minX < node.LL.x {
            node.LL.x = minX;
        }
        if minY < node.LL.y {
            node.LL.y = minY;
        }
        if maxX > node.UR.x {
            node.UR.x = maxX;
        }
        if maxY > node.UR.y {
            node.UR.y = maxY;
        }
        node.width = node.UR.x.wrapping_sub(node.LL.x);
        node.height = node.UR.y.wrapping_sub(node.LL.y);
    }
}

/// GcellDetailRouter::InsertRoutingVia — 경로에서 같은 (x, y) 로 층을 바꾸는 곳마다 (낮은 층, x, y)
fn InsertRoutingVia(path: &[Vec<i32>], grid: &Grid, Pset_via: &mut BTreeSet<P3>) {
    for p in path {
        for k in 1..p.len() {
            let (a, b) = (&grid.vertices_total[p[k - 1] as usize], &grid.vertices_total[p[k] as usize]);
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
