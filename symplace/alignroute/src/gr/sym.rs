//! 칸 집합(Tile_Set), 스타이너 후보, 대칭 넷 (GcellGlobalRouter.cpp:641-943).
//!
//! Tile_Set 은 `std::set<tile, tileComp>` — 키가 (x, y, index, metal[0]) 라서 `find` 는 좌표를 바꾼 칸이
//! 제자리 좌표와 같을 때만 그 칸 자신을 찾는다. 그래서:
//! - 스타이너 후보 = 다른 단자 칸과 x 나 y 가 같은 단자 칸들 (정렬, 유일).
//! - 대칭 지도는 축 **위의** 칸만 자기 자신으로 옮기고 나머지는 -1 이다 (축 좌표 axis_coor 는 늘 -1).
//! - MirrorSymSTs 는 축 좌표 자리에 넷 번호(global_sym)를 넘긴다 — 옮겨지는 칸이 없어 global_sym 이 -1 로 돌아간다.
#![allow(non_snake_case)]

use super::grid::GlobalGrid;
use super::{at, ub, GcellGlobalRouter};
use crate::rdb::{tile, SteinerTree};
use std::collections::{BTreeMap, BTreeSet};

/// std::set<RouterDB::tile, RouterDB::tileComp>. tileComp 의 순서는 (x, y, index, metal[0]) 의 사전 순이라
/// 그 넷을 키로 두고 칸 번호(`it->index`)를 값으로 둔다.
#[derive(Clone, Debug, Default)]
pub struct TileSet(BTreeMap<(i32, i32, i32, i32), i32>);

impl TileSet {
    fn key(t: &tile) -> (i32, i32, i32, i32) {
        // 칸의 층 목록은 비지 않는다 (칸 층마다 금속 하나)
        (t.x, t.y, t.index, t.metal[0])
    }

    /// insert: 같은 키가 있으면 먼저 것이 남는다
    pub fn insert(&mut self, t: &tile) {
        self.0.entry(Self::key(t)).or_insert(t.index);
    }

    /// find(t) != end() 이면 그 원소의 index
    pub fn find(&self, t: &tile) -> Option<i32> {
        self.0.get(&Self::key(t)).copied()
    }
}

fn tile_of(grid: &GlobalGrid, idx: i32) -> Result<&tile, String> {
    usize::try_from(idx).ok().and_then(|i| grid.tiles_total.get(i)).ok_or_else(|| ub(format!("tiles_total[{idx}]")))
}

impl GcellGlobalRouter {
    pub fn CreateTileSet(grid: &GlobalGrid) -> TileSet {
        let mut Tile_set = TileSet::default();
        for t in &grid.tiles_total {
            Tile_set.insert(t);
        }
        Tile_set
    }

    /// 단자 칸 둘씩 (i != j): 한쪽 칸에 다른 쪽의 y 또는 x 를 넣은 칸 네 개를 만들어 Tile_Set 에서 찾는다
    pub fn Get_Potential_Steiner_node(t: &[i32], Tile_Set: &TileSet, grid: &GlobalGrid) -> Result<Vec<i32>, String> {
        let mut Temp_tile: Vec<tile> = Vec::new();
        for i in 0..t.len() {
            for j in 0..t.len() {
                if i != j {
                    let ti = tile_of(grid, t[i])?;
                    let tj = tile_of(grid, t[j])?;
                    let mut temp_tile = ti.clone();
                    temp_tile.y = tj.y;
                    Temp_tile.push(temp_tile.clone());
                    temp_tile.y = ti.y;
                    temp_tile.x = tj.x;
                    Temp_tile.push(temp_tile);

                    let mut temp_tile = tj.clone();
                    temp_tile.y = ti.y;
                    Temp_tile.push(temp_tile.clone());
                    temp_tile.y = tj.y;
                    temp_tile.x = ti.x;
                    Temp_tile.push(temp_tile);
                }
            }
        }
        let mut stiner_node_set = BTreeSet::new();
        for tt in &Temp_tile {
            if let Some(idx) = Tile_Set.find(tt) {
                stiner_node_set.insert(idx);
            }
        }
        Ok(stiner_node_set.into_iter().collect())
    }

    /// 중심에 가장 가까운 칸 좌표 (처음 가장 가까운 것). 결과(global_center)는 쓰이지 않는다.
    pub fn transformCenter(H: bool, center: &mut i32, grid: &GlobalGrid) {
        let mut dist = i32::MAX;
        let mut index: i32 = -1;
        for (i, t) in grid.tiles_total.iter().enumerate() {
            let d = if H { center.wrapping_sub(t.y).wrapping_abs() } else { center.wrapping_sub(t.x).wrapping_abs() };
            if d < dist {
                dist = d;
                index = i as i32;
            }
        }
        if index >= 0 && (index as usize) < grid.tiles_total.len() {
            let t = &grid.tiles_total[index as usize];
            *center = if H { t.y } else { t.x };
        }
    }

    /// 대칭 짝 (symCounterpart 가 -1 이 아니고 Nets.size()-1 보다 작을 때 — 마지막 넷은 짝이 못 된다)
    pub fn SymNet(&mut self, Tile_Set: &TileSet) -> Result<(), String> {
        for i in 0..self.Nets.len() {
            let symCounterpart = self.Nets[i].symCounterpart;
            if symCounterpart != -1 && symCounterpart < self.Nets.len() as i32 - 1 {
                // Nets.at(symCounterpart): 음수면 던진다
                at(&self.Nets, symCounterpart, "Nets")?;
                let H = self.Nets[i].sym_H;
                let center = self.Nets[i].center;
                self.Nets[i].global_center = center;
                let mut gc = self.Nets[i].global_center;
                Self::transformCenter(H, &mut gc, &self.Gcell);
                self.Nets[i].global_center = gc;
                let prime_flag = self.SymNetTerminal_PrimeSet(Tile_Set, i, symCounterpart as usize, H, center)?;
                if prime_flag != 0 {
                    self.Nets[i].global_sym = symCounterpart;
                    self.Nets[symCounterpart as usize].global_sym = i as i32;
                }
            }
        }
        Ok(())
    }

    /// 두 넷의 칸 묶음 수가 같을 때만: 서로의 대칭 칸이 있는 칸만 남긴다 (둘 다 비지 않을 때만 바꾼다).
    /// 넷 번호로 받는다 — 짝이 자기 자신이면 C++ 처럼 같은 넷을 두 번 고친다.
    pub fn SymNetTerminal_PrimeSet(&mut self, Tile_Set: &TileSet, temp_net: usize, sym_net: usize, H: bool, center: i32) -> Result<i32, String> {
        if self.Nets[temp_net].connectedTile.len() == self.Nets[sym_net].connectedTile.len() {
            let mut net_sy_map = Self::GenerateSymMap(&self.Gcell, Tile_Set, &self.Nets[temp_net].terminals, H, center)?;
            let mut sym_sy_map = Self::GenerateSymMap(&self.Gcell, Tile_Set, &self.Nets[sym_net].terminals, H, center)?;
            let prime_flag = self.PrimeSetGenerate(temp_net, sym_net, &mut net_sy_map, &mut sym_sy_map);
            Self::Update_terminals(&mut self.Nets[temp_net]);
            Self::Update_terminals(&mut self.Nets[sym_net]);
            Ok(if prime_flag == 1 { 1 } else { 0 })
        } else {
            Ok(0)
        }
    }

    /// 칸 t -> 축으로 뒤집은 칸 (Tile_Set 에서 찾으면 그 칸 = t 자신, 못 찾으면 -1)
    pub fn GenerateSymMap(grid: &GlobalGrid, Tile_Set: &TileSet, terminals: &[i32], H: bool, center: i32) -> Result<BTreeMap<i32, i32>, String> {
        let mut sy_map = BTreeMap::new();
        for &t in terminals {
            let mut temp_tile = tile_of(grid, t)?.clone();
            if H {
                temp_tile.y = center.wrapping_mul(2).wrapping_sub(temp_tile.y);
            } else {
                temp_tile.x = center.wrapping_mul(2).wrapping_sub(temp_tile.x);
            }
            // map::insert — 있는 키는 그대로
            sy_map.entry(t).or_insert(Tile_Set.find(&temp_tile).unwrap_or(-1));
        }
        Ok(sy_map)
    }

    /// 묶음 i 마다: B' = A 의 대칭 칸에 드는 B 의 칸, A' = B' 의 대칭 칸에 드는 A 의 칸. 둘 다 비지 않으면
    /// 바꾸고(뒤 묶음이 실패해도), 아니면 실패로 적는다. `map[x]` 는 없는 키를 0 으로 넣는다.
    pub fn PrimeSetGenerate(&mut self, a: usize, b: usize, net_map: &mut BTreeMap<i32, i32>, sy_net_map: &mut BTreeMap<i32, i32>) -> i32 {
        let mut unmap_flag = 0;
        let mut i = 0;
        while i < self.Nets[a].connectedTile.len() {
            let mut temp_sy_set = BTreeSet::new();
            let mut sy_set = BTreeSet::new();
            let mut sy_prime = Vec::new();
            let mut prime = Vec::new();
            for &x in &self.Nets[a].connectedTile[i] {
                temp_sy_set.insert(*net_map.entry(x).or_insert(0));
            }
            for &x in &self.Nets[b].connectedTile[i] {
                if temp_sy_set.contains(&x) {
                    sy_prime.push(x);
                }
            }
            for &x in &sy_prime {
                sy_set.insert(*sy_net_map.entry(x).or_insert(0));
            }
            for &x in &self.Nets[a].connectedTile[i] {
                if sy_set.contains(&x) {
                    prime.push(x);
                }
            }
            if !sy_prime.is_empty() && !prime.is_empty() {
                self.Nets[a].connectedTile[i] = prime;
                self.Nets[b].connectedTile[i] = sy_prime;
            } else {
                unmap_flag = 1;
            }
            i += 1;
        }
        if unmap_flag == 0 { 1 } else { 0 }
    }

    /// terminals = connectedTile 의 합집합 (정렬, 유일)
    pub fn Update_terminals(temp_net: &mut crate::rdb::Net) {
        let mut temp_set = BTreeSet::new();
        for g in &temp_net.connectedTile {
            temp_set.extend(g.iter().copied());
        }
        temp_net.terminals = temp_set.into_iter().collect();
    }

    /// 후보 트리들에 나오는 칸 (정렬, 유일)
    pub fn GenerateSTsUniqueV(temp_net: &crate::rdb::Net) -> Vec<i32> {
        let mut unique_set = BTreeSet::new();
        for st in &temp_net.STs {
            for &(f, s) in &st.path {
                unique_set.insert(f);
                unique_set.insert(s);
            }
        }
        unique_set.into_iter().collect()
    }

    /// 대칭 짝의 후보 트리를 서로 옮겨 맞춘다. 버릇: 축 좌표 자리에 global_sym (넷 번호) 을 넘긴다.
    pub fn MirrorSymSTs(&mut self, Tile_Set: &TileSet) -> Result<(), String> {
        for i in 0..self.Nets.len() {
            let global_sym = self.Nets[i].global_sym;
            if global_sym != -1 && global_sym < self.Nets.len() as i32 - 1 {
                let gs = usize::try_from(global_sym).map_err(|_| format!("std::out_of_range: vector (Nets[{global_sym}])"))?;
                let temp_vector = Self::GenerateSTsUniqueV(&self.Nets[i]);
                let sy_vector = Self::GenerateSTsUniqueV(&self.Nets[gs]);
                let mut temp_map = Self::GenerateSymMap(&self.Gcell, Tile_Set, &temp_vector, self.Nets[i].sym_H, self.Nets[i].global_sym)?;
                let mut sy_temp_map = Self::GenerateSymMap(&self.Gcell, Tile_Set, &sy_vector, self.Nets[gs].sym_H, self.Nets[gs].global_sym)?;
                self.CopySTs(i, gs, &mut temp_map, &mut sy_temp_map)?;
            }
        }
        Ok(())
    }

    /// 옮길 수 있는 후보만 모아 두 넷의 후보를 바꾼다. 하나도 없으면 두 넷의 global_sym 을 -1 로.
    /// 버릇(:680): 짝의 후보를 옮길 때 짝 쪽 목록에는 짝이 아니라 이 넷의 i 번째 후보를 넣는다.
    pub fn CopySTs(&mut self, temp_net: usize, sy_temp_net: usize, temp_map: &mut BTreeMap<i32, i32>,
                   sy_temp_map: &mut BTreeMap<i32, i32>) -> Result<(), String> {
        let mut path: Vec<Vec<(i32, i32)>> = Vec::new();
        let mut sy_path: Vec<Vec<(i32, i32)>> = Vec::new();
        for i in 0..self.Nets[temp_net].STs.len() {
            let mut temp_sy_path = Vec::new();
            if Self::CopyPath(&self.Nets[temp_net].STs[i].path, temp_map, &mut temp_sy_path) != 0 {
                path.push(self.Nets[temp_net].STs[i].path.clone());
                sy_path.push(temp_sy_path);
            }
        }
        for i in 0..self.Nets[sy_temp_net].STs.len() {
            let mut temp_sy_path = Vec::new();
            if Self::CopyPath(&self.Nets[sy_temp_net].STs[i].path, sy_temp_map, &mut temp_sy_path) != 0 {
                let p = self.Nets[temp_net].STs.get(i).ok_or_else(|| ub(format!("CopySTs: temp_net.STs[{i}]")))?.path.clone();
                sy_path.push(p);
                path.push(temp_sy_path);
            }
        }
        if !path.is_empty() {
            self.Nets[temp_net].STs = path.into_iter().map(|p| SteinerTree { path: p, ..SteinerTree::new() }).collect();
            self.Nets[sy_temp_net].STs = sy_path.into_iter().map(|p| SteinerTree { path: p, ..SteinerTree::new() }).collect();
        } else {
            self.Nets[temp_net].global_sym = -1;
            self.Nets[sy_temp_net].global_sym = -1;
        }
        Ok(())
    }

    /// 경로의 칸을 지도로 옮긴다. 한 칸이라도 없거나 -1 이면 0
    pub fn CopyPath(path: &[(i32, i32)], temp_map: &BTreeMap<i32, i32>, sy_path: &mut Vec<(i32, i32)>) -> i32 {
        for &(f, s) in path {
            let first = match temp_map.get(&f) {
                Some(&v) if v != -1 => v,
                _ => return 0,
            };
            let second = match temp_map.get(&s) {
                Some(&v) if v != -1 => v,
                _ => return 0,
            };
            sy_path.push((first, second));
        }
        1
    }
}
