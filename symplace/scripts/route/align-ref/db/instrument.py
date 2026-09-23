# Instrumentation injected into the Pyodide ALIGN route flow (pyroute.py) to dump PnRDB state.
# Only monkeypatches module globals in memory; no files of ALIGN or the project are modified.
import json, os
import PnR
import align.pnr.router as R
import align.pnr.placer as PL

HN_OUT = '/work/_hn'
os.makedirs(HN_OUT, exist_ok=True)

def P(p): return [p.x, p.y]
def Bx(b): return [b.LL.x, b.LL.y, b.UR.x, b.UR.y]
def C(c): return {"metal": c.metal, "o": Bx(c.originBox), "p": Bx(c.placedBox), "oc": P(c.originCenter), "pc": P(c.placedCenter)}
def V(v): return {"model": v.model_index, "opos": P(v.originpos), "ppos": P(v.placedpos),
                  "U": C(v.UpperMetalRect), "L": C(v.LowerMetalRect), "V": C(v.ViaRect)}
def PIN(p): return {"name": p.name, "type": p.type, "use": p.use, "netIter": p.netIter,
                    "c": [C(x) for x in p.pinContacts], "v": [V(x) for x in p.pinVias]}
def MET(m): return {"idx": m.MetalIdx, "pts": [P(q) for q in m.LinePoint], "w": m.width, "r": C(m.MetalRect)}
def CN(c): return [int(c.type), c.iter, c.iter2]
def PN(n): return {"name": n.name, "power": int(n.power), "Pins": [PIN(p) for p in n.Pins],
                   "connected": [CN(c) for c in n.connected], "dummy_connected": [CN(c) for c in n.dummy_connected],
                   "path_metal": [MET(m) for m in n.path_metal], "path_via": [V(v) for v in n.path_via]}
def BLK(b): return {"name": b.name, "master": b.master, "lefmaster": b.lefmaster, "type": b.type,
                    "w": b.width, "h": b.height, "isLeaf": bool(b.isLeaf), "originBox": Bx(b.originBox),
                    "originCenter": P(b.originCenter), "gdsFile": b.gdsFile, "orient": int(b.orient),
                    "placedBox": Bx(b.placedBox), "placedCenter": P(b.placedCenter),
                    "pins": [PIN(p) for p in b.blockPins], "interMetals": [C(x) for x in b.interMetals],
                    "interVias": [V(x) for x in b.interVias], "dummy_power_pin": [PIN(p) for p in b.dummy_power_pin],
                    "PowerNets": [PN(x) for x in b.PowerNets]}
def NET(n): return {"name": n.name, "shielding": bool(n.shielding), "sink2Terminal": bool(n.sink2Terminal),
                    "degree": n.degree, "symCounterpart": n.symCounterpart, "iter2SNetLsit": n.iter2SNetLsit,
                    "connected": [CN(c) for c in n.connected], "priority": n.priority, "axis_dir": int(n.axis_dir),
                    "axis_coor": n.axis_coor, "path_metal": [MET(m) for m in n.path_metal],
                    "path_via": [V(v) for v in n.path_via], "n_interVias": len(n.interVias),
                    "n_GcellGlobalRouterPath": len(n.GcellGlobalRouterPath)}
def TERM(t): return {"name": t.name, "type": t.type, "netIter": t.netIter, "termContacts": [C(x) for x in t.termContacts]}
def PG(g): return {"name": g.name, "metals": [MET(m) for m in g.metals], "vias": [V(v) for v in g.vias]}
def HN(h):
    return {"name": h.name, "isTop": bool(h.isTop), "width": h.width, "height": h.height, "LL": P(h.LL), "UR": P(h.UR),
            "abs_orient": int(h.abs_orient), "n_copy": h.n_copy, "numPlacement": h.numPlacement,
            "concrete_name": h.concrete_name, "gdsFile": h.gdsFile, "parent": list(h.parent),
            "Blocks": [{"selectedInstance": bc.selectedInstance, "child": bc.child, "instNum": bc.instNum,
                        "instance": [BLK(b) for b in bc.instance]} for bc in h.Blocks],
            "Nets": [NET(n) for n in h.Nets], "Terminals": [TERM(t) for t in h.Terminals],
            "PowerNets": [PN(n) for n in h.PowerNets], "Vdd": PG(h.Vdd), "Gnd": PG(h.Gnd),
            "blockPins": [PIN(p) for p in h.blockPins], "interMetals": [C(x) for x in h.interMetals],
            "interVias": [V(x) for x in h.interVias],
            "SNets": [{"net1": s.net1.name, "net2": s.net2.name, "iter1": s.iter1, "iter2": s.iter2,
                       "net1_connected": [CN(c) for c in s.net1.connected],
                       "net2_connected": [CN(c) for c in s.net2.connected]} for s in h.SNets],
            "SPBlocks": [{"sympair": [list(x) for x in s.sympair], "selfsym": [[a, int(b)] for a, b in s.selfsym]} for s in h.SPBlocks],
            "Block_name_map": dict(h.Block_name_map), "n_PnRAS": len(h.PnRAS),
            "bias_Hgraph": h.bias_Hgraph, "bias_Vgraph": h.bias_Vgraph, "n_tiles_total": len(h.tiles_total)}
def GD(g): return {"Draw": g.Draw, "Pin": g.Pin, "Label": g.Label, "Blockage": g.Blockage}
def DRC(d):
    return {"MaxLayer": d.MaxLayer, "Metalmap": dict(d.Metalmap), "Viamap": dict(d.Viamap),
            "Metal_info": [{"name": m.name, "layerNo": m.layerNo, "width": m.width, "dist_ss": m.dist_ss,
                            "direct": m.direct, "grid_unit_x": m.grid_unit_x, "grid_unit_y": m.grid_unit_y,
                            "minL": m.minL, "maxL(indeterminate)": m.maxL, "dist_ee": m.dist_ee, "offset": m.offset,
                            "unit_R": m.unit_R, "unit_C": m.unit_C, "unit_CC": m.unit_CC,
                            "gds_datatype": GD(m.gds_datatype), "lower_via_index": m.lower_via_index,
                            "upper_via_index": m.upper_via_index} for m in d.Metal_info],
            "Via_info": [{"name": v.name, "layerNo": v.layerNo, "lower_metal_index": v.lower_metal_index,
                          "upper_metal_index": v.upper_metal_index, "width": v.width, "width_y": v.width_y,
                          "cover_l": v.cover_l, "cover_l_P": v.cover_l_P, "cover_u": v.cover_u, "cover_u_P": v.cover_u_P,
                          "dist_ss": v.dist_ss, "dist_ss_y": v.dist_ss_y, "R": v.R, "gds_datatype": GD(v.gds_datatype)}
                         for v in d.Via_info],
            "Via_model": [{"name": m.name, "ViaIdx": m.ViaIdx, "LowerIdx": m.LowerIdx, "UpperIdx": m.UpperIdx,
                           "ViaRect": [P(p) for p in m.ViaRect], "LowerRect": [P(p) for p in m.LowerRect],
                           "UpperRect": [P(p) for p in m.UpperRect], "R": m.R} for m in d.Via_model],
            "metal_weight": list(d.metal_weight), "MaskID_Metal": list(d.MaskID_Metal), "MaskID_Via": list(d.MaskID_Via),
            "top_boundary": {"name": d.top_boundary.name, "layerNo": d.top_boundary.layerNo,
                             "gds_datatype": GD(d.top_boundary.gds_datatype)},
            "Design_info": {k: getattr(d.Design_info, k) for k in (
                "Hspace", "Vspace", "signal_routing_metal_l", "signal_routing_metal_u", "power_grid_metal_l",
                "power_grid_metal_u", "power_routing_metal_l", "power_routing_metal_u", "h_skip_factor",
                "v_skip_factor", "compact_style")}}
def LEF(m): return {"name": m.name, "master": m.master, "w": m.width, "h": m.height,
                    "pins": [PIN(p) for p in m.macroPins], "interMetals": [C(x) for x in m.interMetals],
                    "interVias": [V(x) for x in m.interVias]}

def dump(name, obj):
    with open(f'{HN_OUT}/{name}.json', 'w') as fp:
        json.dump(obj, fp)

_orig_gen = R.gen_DB_verilog_d
def _gen_wrap(*a, **k):
    res = _orig_gen(*a, **k)
    DB = res[0]
    dump('00_drc_info', DRC(DB.getDrc_info()))
    dump('01_lefData', {name: [LEF(m) for m in v] for name, v in DB.lefData.items()})
    dump('01_gdsData2', {k2: list(v) for k2, v in DB.gdsData2.items()})
    dump('02_tree_after_semantic', {"topidx": DB.topidx, "traverse": list(DB.TraverseHierTree()),
                                    "nodes": [HN(h) for h in DB.hierTree]})
    return res
R.gen_DB_verilog_d = _gen_wrap

_orig_pl = PL.place
_pl_n = [0]
def _pl_wrap(**k):
    DB, idx = k['DB'], k['idx']
    dump(f'04_{_pl_n[0]}_place_input_{DB.hierTree[idx].name}', {"idx": idx, "modules_d": k.get('modules_d'),
                                                               "node_before": HN(DB.CheckoutHierNode(idx, -1))})
    r = _orig_pl(**k)
    # PnRAS[0] is what route_bottom_up checks out later; read it without mutating the base node
    ras = DB.hierTree[idx].PnRAS
    dump(f'05_{_pl_n[0]}_place_output_{DB.hierTree[idx].name}',
         {"idx": idx, "numPlacement": DB.hierTree[idx].numPlacement, "n_PnRAS": len(ras),
          "PnRAS0": {"width": ras[0].width, "height": ras[0].height, "LL": P(ras[0].LL), "UR": P(ras[0].UR),
                     "HPWL": ras[0].HPWL, "HPWL_extend": ras[0].HPWL_extend, "gdsFile": ras[0].gdsFile,
                     "Blocks": [{"selectedInstance": bc.selectedInstance, "child": bc.child, "instNum": bc.instNum,
                                 "instance": [BLK(b) for b in bc.instance]} for bc in ras[0].Blocks],
                     "Nets": [NET(n) for n in ras[0].Nets], "Terminals": [TERM(t) for t in ras[0].Terminals]},
          "base_blockPins": [PIN(p) for p in DB.hierTree[idx].blockPins],
          "base_PowerNets": [PN(n) for n in DB.hierTree[idx].PowerNets]})
    _pl_n[0] += 1
    return r
PL.place = _pl_wrap

_orig_rsv = R.route_single_variant
_rsv_n = [0]
def _rsv_wrap(DB, drcInfo, current_node, lidx, opath, adr_mode, **k):
    DB.ExtractPinsToPowerPins(current_node)  # idempotent; route_single_variant does it first too
    dump(f'10_{_rsv_n[0]}_route_in_{current_node.name}', HN(current_node))
    r = _orig_rsv(DB, drcInfo, current_node, lidx, opath, adr_mode, **k)
    dump(f'11_{_rsv_n[0]}_route_out_{current_node.name}', HN(current_node))
    _rsv_n[0] += 1
    return r
R.route_single_variant = _rsv_wrap
print("instrumentation installed")
