//! 모드 2 — 전원 격자 (PowerRouter::CreatePowerGrid, PowerRouter.cpp:620-710, 1034-1125, 1238-1276,
//! 1780-1835).
//!
//! [0, max(UR, 격자 한 칸)] 에 M5/M6 망을 치고(PowerGrid_Drc_info: 가로층 x7, 세로층 x8), 장애물 점에서
//! 끊고, 극성마다 가장 큰 덩이만 남겨 금속·비아로 만든다. 장애물 점은 원래 DRC 의 제 층 격자와
//! 늘린 DRC 의 이웃 층 격자로 구한다 (drc_info 를 바꾸는 것이 장애물을 만든 뒤라서).
use super::PowerRouter;
use super::detail::InsertPlistToSet_x;
use super::graph::CreatePower_Grid;
use super::grid::Grid;
use super::util::FxSet;
use crate::db::{DrcInfo, HierNode};
use crate::rdb::{Metal, PowerGrid, point};

impl PowerRouter {
    /// PowerRouter::CreatePowerGrid (PowerRouter.cpp:620-681)
    pub(crate) fn CreatePowerGrid(&mut self, node: &HierNode, drc: &DrcInfo, Lmetal: i32, Hmetal: i32, h_skip_factor: i32, v_skip_factor: i32) {
        self.GetData(node, drc, Lmetal, Hmetal);
        self.CreatePowerGridDrc_info(h_skip_factor, v_skip_factor);
        self.cross_layer_drc_info = self.PowerGrid_Drc_info.clone();
        self.UpdatePowerGridLLUR(Lmetal, Hmetal);
        let mut plist = vec![Vec::new(); self.layerNo as usize];
        self.CreatePlistBlocks(&mut plist);
        self.CreatePlistNets(&mut plist);
        self.CreatePlistTerminals(&mut plist);
        self.CreatePlistPowerNets(&mut plist);
        self.CreatePlistPowerGrid(&mut plist, &self.Vdd_grid);
        self.CreatePlistPowerGrid(&mut plist, &self.Gnd_grid);
        let mut Set_x = FxSet::default();
        InsertPlistToSet_x(&mut Set_x, &plist);
        self.drc_info = self.PowerGrid_Drc_info.clone();

        let pg = self.PowerGrid_Drc_info.clone();
        let mut grid = Grid::new(&pg, self.LL, self.UR, self.lowest_metal, self.highest_metal, self.grid_scale);
        self.InactiveFindsetPlist(&mut grid, &Set_x, self.LL, self.UR);
        grid.PrepareGraphVertices(self.LL.x, self.LL.y, self.UR.x, self.UR.y);
        let (vdd, gnd) = CreatePower_Grid(&mut grid);
        self.Vdd_grid = vdd;
        self.Gnd_grid = gnd;
    }

    /// PowerRouter::CreatePowerGridDrc_info (PowerRouter.cpp:1238-1276) — 가로층은 h_skip, 세로층은
    /// v_skip 배로 grid_unit_x·y 를 둘 다 늘린다 (-1 은 -7, -8 이 되지만 쓰이지 않는다)
    fn CreatePowerGridDrc_info(&mut self, h_skip_factor: i32, v_skip_factor: i32) {
        self.PowerGrid_Drc_info = self.drc_info.clone();
        for mi in self.PowerGrid_Drc_info.Metal_info.iter_mut() {
            // direct 가 0, 1 이 아니면 C++ 은 assert(0) (꺼져 있다) 뒤 초기화 안 된 값을 쓴다 — 1 로 둔다
            let factor = if mi.direct == 1 {
                h_skip_factor
            } else if mi.direct == 0 {
                v_skip_factor
            } else {
                1
            };
            mi.grid_unit_x = mi.grid_unit_x.wrapping_mul(factor);
            mi.grid_unit_y = mi.grid_unit_y.wrapping_mul(factor);
        }
    }

    /// PowerRouter::UpdatePowerGridLLUR (PowerRouter.cpp:683-710) — UR 을 격자 한 칸 이상으로 (멤버만)
    fn UpdatePowerGridLLUR(&mut self, Lmetal: i32, Hmetal: i32) {
        let lower_metal = &self.PowerGrid_Drc_info.Metal_info[Lmetal as usize];
        let higher_metal = &self.PowerGrid_Drc_info.Metal_info[Hmetal as usize];
        let mut x_grid = -1;
        let mut y_grid = -1;
        if higher_metal.direct == 1 {
            y_grid = higher_metal.grid_unit_y;
        } else {
            x_grid = higher_metal.grid_unit_x;
        }
        if lower_metal.direct == 1 {
            y_grid = lower_metal.grid_unit_y;
        } else {
            x_grid = lower_metal.grid_unit_x;
        }
        if y_grid == -1 {
            y_grid = self.PowerGrid_Drc_info.Metal_info[(Hmetal - 1) as usize].grid_unit_y;
        }
        if x_grid == -1 {
            x_grid = self.PowerGrid_Drc_info.Metal_info[(Hmetal - 1) as usize].grid_unit_x;
        }
        if self.UR.x < x_grid {
            self.UR.x = x_grid;
        }
        if self.UR.y < y_grid {
            self.UR.y = y_grid;
        }
    }

    /// PowerRouter::Physical_metal_via_power_grid (PowerRouter.cpp:1034-1125) — 금속·병합 금속은 양끝을
    /// 폭의 반만큼 늘린 사각형, 길이 0 이면 폭 x 폭. 비아는 모형으로.
    pub(crate) fn Physical_metal_via_power_grid(&self, temp_grid: &mut PowerGrid) {
        for m in temp_grid.metals.iter_mut() {
            grid_metal_rect(m);
        }
        for m in temp_grid.merged_metals.iter_mut() {
            grid_metal_rect(m);
        }
        for v in temp_grid.vias.iter_mut() {
            self.UpdateVia(v);
        }
    }

    /// PowerRouter::ReturnPowerGridData (PowerRouter.cpp:1780-1835) — DoNotRoute 가 아니면 금속,
    /// 병합 금속, 비아를 덧붙이고 이름은 늘 쓴다
    pub(crate) fn ReturnPowerGridData(&self, node: &mut HierNode) {
        let return_vdd = !node.DoNotRoute.contains(&self.Vdd_grid.name);
        let return_gnd = !node.DoNotRoute.contains(&self.Gnd_grid.name);
        if return_vdd {
            for m in &self.Vdd_grid.metals {
                node.Vdd.metals.push(self.ConvertToMetalPnRDB_Placed_Placed(m));
            }
            for m in &self.Vdd_grid.merged_metals {
                node.Vdd.merged_metals.push(self.ConvertToMetalPnRDB_Placed_Placed(m));
            }
            for v in &self.Vdd_grid.vias {
                node.Vdd.vias.push(self.ConvertToViaPnRDB_Placed_Placed(v));
            }
        }
        node.Vdd.name = self.Vdd_grid.name.clone();
        if return_gnd {
            for m in &self.Gnd_grid.metals {
                node.Gnd.metals.push(self.ConvertToMetalPnRDB_Placed_Placed(m));
            }
            for m in &self.Gnd_grid.merged_metals {
                node.Gnd.merged_metals.push(self.ConvertToMetalPnRDB_Placed_Placed(m));
            }
            for v in &self.Gnd_grid.vias {
                node.Gnd.vias.push(self.ConvertToViaPnRDB_Placed_Placed(v));
            }
        }
        node.Gnd.name = self.Gnd_grid.name.clone();
    }
}

/// 격자 금속 하나의 사각형 (양끝 +w/2). 점이 없는 금속(빈 벡터의 병합 결과, C++ 은 범위 밖을 읽는다)은 둔다.
fn grid_metal_rect(m: &mut Metal) {
    if m.LinePoint.len() < 2 {
        return;
    }
    let (p0, p1, h) = (m.LinePoint[0], m.LinePoint[1], m.width / 2);
    let r = &mut m.MetalRect;
    r.metal = m.MetalIdx;
    r.placedCenter = point::new((p0.x + p1.x) / 2, (p0.y + p1.y) / 2);
    let (a, b) = if p0.y == p1.y {
        if p0.x < p1.x { (p0, p1) } else { (p1, p0) }
    } else if p0.y < p1.y {
        (p0, p1)
    } else {
        (p1, p0)
    };
    r.placedLL = point::new(a.x - h, a.y - h);
    r.placedUR = point::new(b.x + h, b.y + h);
    if p0.y == p1.y && p0.x == p1.x {
        r.placedLL = point::new(p0.x - h, p0.y - h);
        r.placedUR = point::new(p1.x + h, p1.y + h);
    }
}
