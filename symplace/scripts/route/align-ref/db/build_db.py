#!/usr/bin/env python3
"""Reference re-implementation (no PnR module) of what ALIGN's route step builds for the C++ router:

   gen_DB_verilog_d  (build_pnr_model.py)        -> hierTree after semantic0/1/2
   hierarchical_place(placement_verilog_d=...)   -> PnRAS[0] per node (external placement, bottom-up)
   route_bottom_up bookkeeping (router.py)       -> exact hierNode handed to Router.RouteWork(4)

It is a runnable spec for a JS port. Units: PnRDB units (= 2 x layers.json units for ScaleFactor 1).
Data format = the dict format written by instrument.py (HN/BLK/PIN/C/V ...), so it can be diffed
against dumps of the real run.

Usage: build_db.py <dumpdir> <layers.json>     (dumpdir from dumphn.mjs: inputs_* files + 0x_/1x_ dumps)
"""
import copy, glob, json, os, re, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from drc_info import read_pdk_json
from place_inject import inject          # AddingPowerPins + setPlacementInfoFromJson/UpdateHierNode + Extract_RemovePowerPins
from checkin import checkin              # CheckinChildnodetoBlock

BLOCK, TERMINAL = 0, 1

def contact(metal="", o=(0, 0, 0, 0), oc=(0, 0)):
    return {"metal": metal, "o": list(o), "p": [0, 0, 0, 0], "oc": list(oc), "pc": [0, 0]}

def via_from_model(D, name, center):
    """ReadLEF: via rects come from the via model centred at the LEF rect centre (NOT the LEF rect)."""
    mi = D["Viamap"][name]
    vm = D["Via_model"][mi]
    cx, cy = center
    def r(rect): return [rect[0][0] + cx, rect[0][1] + cy, rect[1][0] + cx, rect[1][1] + cy]
    v = {"model": mi, "opos": [cx, cy], "ppos": [0, 0], "U": contact(), "L": contact(),
         "V": contact(vm["name"], r(vm["ViaRect"]), center)}
    if vm["LowerIdx"] >= 0: v["L"] = contact(D["Metal_info"][vm["LowerIdx"]]["name"], r(vm["LowerRect"]), center)
    if vm["UpperIdx"] >= 0: v["U"] = contact(D["Metal_info"][vm["UpperIdx"]]["name"], r(vm["UpperRect"]), center)
    return v

def read_lef(text, D, unitScale=2000):
    """PnRdatabase::_ReadLEF (PnRDB/ReadLEF.cpp) including its quirks:
       - line based, keyword found anywhere in the line (string::find); tokens split on ' ' only
       - only the FIRST RECT after each 'LAYER' line is used (later RECTs of the same LAYER are dropped)
       - OBS: M* -> interMetals, V* (name not ending in '0') -> interVias built from the via model
       - PORT: M* -> pinContacts, V* -> pinVias; units = unitScale / DATABASE-MICRONS (=2 here), rounded"""
    lef = {}
    units = 2.0
    stage = 0
    tok = lambda s, start: s[start:].split(';')[0].replace('\n', ' ').split()
    sc = lambda s: int(round(float(s) * units))
    prev = []
    for line in text.splitlines():
        if stage == 0:
            if 'MACRO' in line:
                t = tok(line, line.find('MACRO')); name = t[1]; mend = 'END ' + name
                w = h = 0; pins = []; ims = []; ivs = []; stage = 1
        elif stage == 5:
            if 'END UNITS' in line: stage = 1
            elif 'DATABASE' in line:
                t = tok(line, line.find('DATABASE')); units = unitScale / float(t[3])
        elif stage == 1:
            if 'SIZE' in line:
                t = tok(line, line.find('SIZE')); w, h = sc(t[1]), sc(t[3])
            elif 'UNITS' in line: stage = 5
            elif 'PIN' in line:
                t = tok(line, line.find('PIN'))
                pins.append({"name": t[1], "type": "", "use": "", "netIter": -1, "c": [], "v": []}); pend = 'END ' + t[1]; stage = 2
            elif 'OBS' in line: stage = 4
            elif mend in line:
                lef.setdefault(name, []).append({"name": name, "master": name, "w": w, "h": h, "pins": pins,
                                                 "interMetals": ims, "interVias": ivs}); stage = 0
        elif stage == 4:
            if 'LAYER' in line:
                prev = tok(line, line.find('LAYER')); skip = False
                if prev[1][0] == 'M': ims.append(contact(prev[1]))
                elif prev[1][0] == 'V' and prev[1][-1] != '0': ivs.append({"pending": prev[1]})
                else: skip = True
            elif 'RECT' in line:
                kind = prev[1][0] if prev else ''
                t = tok(line, line.find('RECT')); prev = t            # the C++ overwrites 'temp' here
                r = [sc(t[1]), sc(t[2]), sc(t[3]), sc(t[4])]
                if not skip:
                    if kind == 'M': ims[-1].update({"o": r, "oc": [(r[0] + r[2]) // 2, (r[1] + r[3]) // 2]})
                    elif kind == 'V': ivs[-1] = via_from_model(D, ivs[-1].get("pending") or ivs[-1]["V"]["metal"], ((r[0] + r[2]) // 2, (r[1] + r[3]) // 2))
            elif 'END' in line: stage = 1
        elif stage == 2:
            if 'USE' in line: pins[-1]["use"] = tok(line, line.find('USE'))[1]
            elif 'DIRECTION' in line: pins[-1]["type"] = tok(line, line.find('DIRECTION'))[1]
            elif 'PORT' in line: stage = 3; mflag = vflag = False
            elif pend in line: stage = 1
        elif stage == 3:
            if 'LAYER' in line:
                t = tok(line, line.find('LAYER'))
                if t[1][0] == 'M': mflag = True; pins[-1]["c"].append(contact(t[1]))
                elif t[1][0] == 'V': vflag = True; pins[-1]["v"].append({"pending": t[1]})
                else: mflag = vflag = False
            elif 'RECT' in line and mflag:
                mflag = False; t = tok(line, line.find('RECT')); r = [sc(t[1]), sc(t[2]), sc(t[3]), sc(t[4])]
                pins[-1]["c"][-1].update({"o": r, "oc": [(r[0] + r[2]) // 2, (r[1] + r[3]) // 2]})
            elif 'RECT' in line and vflag:
                vflag = False; t = tok(line, line.find('RECT')); r = [sc(t[1]), sc(t[2]), sc(t[3]), sc(t[4])]
                pins[-1]["v"][-1] = via_from_model(D, pins[-1]["v"][-1]["pending"], ((r[0] + r[2]) // 2, (r[1] + r[3]) // 2))
            elif 'END' in line:
                stage = 2
    return lef

def new_block(name, master):
    return {"name": name, "master": master, "lefmaster": "", "type": "", "w": 0, "h": 0, "isLeaf": True,
            "originBox": [0, 0, 0, 0], "originCenter": [0, 0], "gdsFile": "", "orient": 0,
            "placedBox": [0, 0, 0, 0], "placedCenter": [0, 0], "pins": [], "interMetals": [], "interVias": [],
            "dummy_power_pin": [], "PowerNets": []}

def new_net(name):
    return {"name": name, "shielding": False, "sink2Terminal": False, "degree": 0, "symCounterpart": -1,
            "iter2SNetLsit": -1, "connected": [], "priority": "", "axis_dir": 1, "axis_coor": -1,
            "path_metal": [], "path_via": [], "n_interVias": 0, "n_GcellGlobalRouterPath": 0}

def empty_pg(): return {"name": "", "metals": [], "vias": []}

def read_verilog(vd):
    """build_pnr_model._ReadVerilogJson"""
    tree = []
    for m in vd["modules"]:
        node = {"name": m.get("name") or m["abstract_name"], "isTop": False, "width": 0, "height": 0, "LL": [0, 0],
                "UR": [0, 0], "abs_orient": 0, "n_copy": 0, "numPlacement": 0, "concrete_name": "", "gdsFile": "",
                "parent": [], "Blocks": [], "Nets": [], "Terminals": [], "PowerNets": [], "Vdd": empty_pg(),
                "Gnd": empty_pg(), "blockPins": [], "interMetals": [], "interVias": [], "SNets": [], "SPBlocks": [],
                "Block_name_map": {}, "n_PnRAS": 0, "bias_Hgraph": 0, "bias_Vgraph": 0, "n_tiles_total": 0,
                "_constraints": {}}
        node["Terminals"] = [{"name": p, "type": "input", "netIter": -1, "termContacts": []} for p in m["parameters"]]
        net_map = {}
        for inst in m["instances"]:
            b = new_block(inst["instance_name"], inst.get("template_name") or inst["abstract_template_name"])
            node["Block_name_map"][b["name"]] = len(node["Blocks"])
            for i, fa in enumerate(inst["fa_map"]):
                a = fa["actual"]
                if a not in net_map:
                    net_map[a] = len(node["Nets"]); node["Nets"].append(new_net(a))
                n = node["Nets"][net_map[a]]
                n["connected"].append([BLOCK, i, len(node["Blocks"])])
                b["pins"].append({"name": fa["formal"], "type": "", "use": "", "netIter": net_map[a], "c": [], "v": []})
            node["Blocks"].append({"selectedInstance": -1, "child": -1, "instNum": 0, "instance": [b]})
        for n in node["Nets"]: n["degree"] = len(n["connected"])
        tree.append(node)
    gs = [(g["prefix"], g["formal"], g["actual"]) for g in vd["global_signals"]]
    return tree, gs

def read_constraints(node, cj, D):
    """PnRdatabase::ReadConstraint_Json -- only what the router (or its inputs) depends on, plus SymmBlock.
       Runs BEFORE semantic0/1/2 (Nets still contain the power nets)."""
    blk = lambda nm: next((i for i, bc in enumerate(node["Blocks"]) if bc["instance"][-1]["name"] == nm), -1)
    for c in cj["constraints"]:
        cn = c["const_name"]
        if cn == "SymmNet":
            def conn(netd):
                out = []
                for pin in netd["blocks"]:
                    if pin["type"] == "pin":
                        i = blk(pin["name"])
                        if i >= 0:
                            j = next((j for j, p in enumerate(node["Blocks"][i]["instance"][-1]["pins"]) if p["name"] == pin["pin"]), None)
                            if j is not None: out.append([BLOCK, j, i])
                    else:
                        t = next((i for i, t in enumerate(node["Terminals"]) if t["name"] == pin["name"]), None)
                        if t is not None: out.append([TERMINAL, t, -1])
                return out
            c1, c2 = conn(c["net1"]), conn(c["net2"])
            it1 = next(i for i, n in enumerate(node["Nets"]) if n["name"] == c["net1"]["name"])
            it2 = next(i for i, n in enumerate(node["Nets"]) if n["name"] == c["net2"]["name"])
            ax = 0 if c["axis_dir"] == "H" else 1
            for a, b_ in ((it1, it2), (it2, it1)):
                node["Nets"][a].update({"symCounterpart": b_, "axis_dir": ax, "iter2SNetLsit": len(node["SNets"])})
            node["SNets"].append({"net1": c["net1"]["name"], "net2": c["net2"]["name"], "iter1": it1, "iter2": it2,
                                  "net1_connected": c1, "net2_connected": c2})
        elif cn == "SymmBlock":
            sp = {"sympair": [], "selfsym": []}
            ax = 0 if c["axis_dir"] == "H" else 1
            for p in c["pairs"]:
                if p["type"] == "sympair":
                    f = s = -1
                    for k, bc in enumerate(node["Blocks"]):
                        if bc["instance"][-1]["name"] == p["block1"]: f = k
                        if bc["instance"][-1]["name"] == p["block2"]: s = k
                    sp["sympair"].append([min(f, s), max(f, s)])
                else:
                    j = blk(p["block"])
                    if j >= 0: sp["selfsym"].append([j, ax])
            node["SPBlocks"].append(sp)
        elif cn == "bias_graph":  node["bias_Hgraph"] = node["bias_Vgraph"] = c["distance"] * 2 // D["ScaleFactor"]
        elif cn == "bias_Hgraph": node["bias_Hgraph"] = c["distance"] * 2 // D["ScaleFactor"]
        elif cn == "bias_Vgraph": node["bias_Vgraph"] = c["distance"] * 2 // D["ScaleFactor"]
        elif cn == "ShieldNet":
            for n in node["Nets"]:
                if n["name"] == c["net_name"]: n["shielding"] = True; break
        elif cn in ("DoNotRoute", "Route", "Multi_Connection", "CritNet", "R_Const", "C_Const"):
            node["_constraints"].setdefault(cn, []).append(c)   # router-visible, not in the dump format

def semantic0(tree, top, gdsData2, lef):
    for n in tree:
        for bc in n["Blocks"]: bc["child"] = -1
    topidx = None
    for i, ni in enumerate(tree):
        for j, nj in enumerate(tree):
            for bc in nj["Blocks"]:
                if bc["instance"][-1]["master"] == ni["name"]:
                    bc["child"] = i
                    if j not in ni["parent"]: ni["parent"].append(j)
        if ni["name"] == top: topidx = i; ni["isTop"] = True
        for l, net in enumerate(ni["Nets"]):
            for m, t in enumerate(ni["Terminals"]):
                if net["name"] == t["name"]:
                    net["degree"] += 1; net["connected"].append([TERMINAL, m, -1]); net["sink2Terminal"] = True; t["netIter"] = l
    for n in tree:
        for bc in n["Blocks"]: bc["instance"][-1]["isLeaf"] = bc["child"] == -1
    for n in tree:                      # MergeLEFMapData
        for bc in n["Blocks"]:
            atn = bc["instance"][0]["master"]
            if atn not in gdsData2:
                if 'Cap' in atn or 'CAP' in atn or 'cap' in atn or not bc["instance"][-1]["isLeaf"]: continue
            files = gdsData2.get(atn, [])
            base = bc["instance"][0]
            bc["instance"] = [copy.deepcopy(base) for _ in files]; bc["instNum"] = len(files)
            for b, f in zip(bc["instance"], files):
                b["gdsFile"] = f
                m = lef[re.sub(r'\.[^./]*$', '', f.split('/')[-1])][0]
                b.update({"interMetals": copy.deepcopy(m["interMetals"]), "interVias": copy.deepcopy(m["interVias"]),
                          "w": m["w"], "h": m["h"], "lefmaster": m["name"], "originBox": [0, 0, m["w"], m["h"]],
                          "originCenter": [m["w"] // 2, m["h"] // 2]})
                for p in b["pins"]:
                    mp = next((q for q in m["pins"] if q["name"] == p["name"]), None)
                    if mp: p.update({"type": mp["type"], "use": mp["use"], "c": copy.deepcopy(mp["c"]), "v": copy.deepcopy(mp["v"])})
    return topidx

def semantic1(tree, gs):
    for prefix, formal, actual in gs:
        power = {"supply0": 0, "supply1": 1}[formal]
        for n in tree:
            keep, found = [], False
            for net in n["Nets"]:
                if net["name"] in (prefix + "." + actual, actual):
                    found = True
                    n["PowerNets"].append({"name": net["name"], "power": power, "Pins": [], "connected": copy.deepcopy(net["connected"]),
                                           "dummy_connected": [], "path_metal": [], "path_via": []})
                else: keep.append(net)
            if not found:
                n["PowerNets"].append({"name": actual, "power": power, "Pins": [], "connected": [], "dummy_connected": [],
                                       "path_metal": [], "path_via": []})
            n["Nets"] = keep

def semantic2(tree):
    for n in tree:
        for j, net in enumerate(n["Nets"]):
            for typ, it, it2 in net["connected"]:
                if typ == BLOCK:
                    for b in n["Blocks"][it2]["instance"]: b["pins"][it]["netIter"] = j
                else: n["Terminals"][it]["netIter"] = j
        for pn in n["PowerNets"]:
            for typ, it, it2 in pn["connected"]:
                if typ == BLOCK:
                    for b in n["Blocks"][it2]["instance"]: b["pins"][it]["netIter"] = -1
                    pn["Pins"].append(copy.deepcopy(n["Blocks"][it2]["instance"][-1]["pins"][it]))
                else:
                    n["Terminals"][it]["netIter"] = -1
                    pn["Pins"].append({"name": n["Terminals"][it]["name"], "type": "", "use": "", "netIter": -1,
                                       "c": copy.deepcopy(n["Terminals"][it]["termContacts"]), "v": []})
        for nn in tree:                                   # "adjust symmetry net iter" (by name)
            for s in nn["SNets"]:
                i1 = next(k for k, x in enumerate(nn["Nets"]) if x["name"] == s["net1"])
                i2 = next(k for k, x in enumerate(nn["Nets"]) if x["name"] == s["net2"])
                nn["Nets"][i1]["symCounterpart"] = i2; nn["Nets"][i2]["symCounterpart"] = i1

def traverse(tree, topidx):
    order, color = [], ["white"] * len(tree)
    def dfs(i):
        color[i] = "gray"
        for bc in tree[i]["Blocks"]:
            if bc["child"] != -1 and color[bc["child"]] == "white": dfs(bc["child"])
        color[i] = "black"; order.append(i)
    dfs(topidx)
    return order

def update_power_pin(p):
    p = copy.deepcopy(p)
    for c in p["c"]: c["o"], c["oc"] = c["p"][:], c["pc"][:]
    for v in p["v"]:
        v["opos"] = v["ppos"][:]
        for k in "ULV": v[k]["o"], v[k]["oc"] = v[k]["p"][:], v[k]["pc"][:]
    return p

def checkin_hier_node(tree, idx, upd):
    """PnRdatabase::CheckinHierNode (PnRdatabase.cpp:684-1038), single placement."""
    base = tree[idx]
    base.setdefault("_PnRAS", []).append(copy.deepcopy(upd))
    base["gdsFile"] = upd["gdsFile"]
    for i, bc in enumerate(base["Blocks"]):
        ubc = upd["Blocks"][i]; sel = ubc["selectedInstance"]
        if bc["instNum"] < ubc["instNum"]:
            bc["instance"] = copy.deepcopy(ubc["instance"]); bc["instNum"] = ubc["instNum"]
        bc["selectedInstance"] = sel
        for w in range(ubc["instNum"]):
            l, r = bc["instance"][w], ubc["instance"][w]
            l["orient"], l["placedBox"], l["placedCenter"] = r["orient"], r["placedBox"][:], r["placedCenter"][:]
            for j, p in enumerate(l["pins"]):
                for k in range(len(p["c"])): p["c"][k] = copy.deepcopy(r["pins"][j]["c"][k])
                for k in range(len(p["v"])): p["v"][k] = copy.deepcopy(r["pins"][j]["v"][k])
            for j in range(len(l["interMetals"])): l["interMetals"][j] = copy.deepcopy(r["interMetals"][j])
            for j in range(len(l["interVias"])): l["interVias"][j] = copy.deepcopy(r["interVias"][j])
    for i, t in enumerate(base["Terminals"]): t["termContacts"] = copy.deepcopy(upd["Terminals"][i]["termContacts"])
    un = {n["name"]: n for n in upd["Nets"]}
    for n in base["Nets"]:
        if n["name"] in un: n["path_metal"], n["path_via"], n["axis_coor"] = un[n["name"]]["path_metal"], un[n["name"]]["path_via"], un[n["name"]]["axis_coor"]
    for pn in base["PowerNets"]:
        for q in upd["PowerNets"]:
            if q["name"] == pn["name"]:
                for k in ("path_metal", "path_via", "connected", "dummy_connected", "Pins"): pn[k] = copy.deepcopy(q[k])
                break
    base["blockPins"], base["interMetals"], base["interVias"] = copy.deepcopy(upd["blockPins"]), copy.deepcopy(upd["interMetals"]), copy.deepcopy(upd["interVias"])
    for pidx in base["parent"]:
        par = tree[pidx]
        for bc in par["Blocks"]:
            pre = bc["instance"][-1]
            if pre["master"] == upd["name"]:
                if bc["instNum"] > 0: bc["instance"].append(copy.deepcopy(pre))
                b = bc["instance"][-1]; bc["instNum"] += 1
                b["gdsFile"] = upd["gdsFile"]; b["lefmaster"] = b["master"] + "_" + str(bc["instNum"] - 1)
                for p in b["pins"]:
                    q = next((q for q in upd["blockPins"] if q["name"] == p["name"]), None)
                    if q: p["c"], p["v"] = copy.deepcopy(q["c"]), copy.deepcopy(q["v"])
                b["interMetals"], b["interVias"] = copy.deepcopy(upd["interMetals"]), copy.deepcopy(upd["interVias"])
                b["w"], b["h"] = upd["width"], upd["height"]
                b["originCenter"] = [upd["width"] // 2, upd["height"] // 2]; b["originBox"] = [0, 0, upd["width"], upd["height"]]
        for j, bc in enumerate(par["Blocks"]):
            b = bc["instance"][-1]
            if b["master"] != upd["name"]: continue
            b["dummy_power_pin"] = []
            for q in upd["PowerNets"]:
                tgt = next((x for x in b["PowerNets"] if x["name"] == q["name"]), None)
                if tgt is None:
                    tgt = {**copy.deepcopy(q), "connected": [], "dummy_connected": [], "Pins": []}; b["PowerNets"].append(tgt)
                else: tgt["dummy_connected"] = []
                for p in q["Pins"]:
                    tgt["dummy_connected"].append([0, len(b["dummy_power_pin"]), j])   # 'type' is uninitialised in C++
                    b["dummy_power_pin"].append(update_power_pin(p))
        for pn in par["PowerNets"]: pn["dummy_connected"] = []
        for bc in par["Blocks"]:
            b = bc["instance"][-1]
            for bp in b["PowerNets"]:
                tgt = next((x for x in par["PowerNets"] if x["name"] == bp["name"]), None)
                if tgt is not None: tgt["dummy_connected"].extend(copy.deepcopy(bp["dummy_connected"]))
                else: par["PowerNets"].append({**copy.deepcopy(bp), "connected": [], "Pins": []})

def checkout(tree, idx, sel):
    """PnRdatabase::CheckoutHierNode(idx, sel) -- returns a copy with PnRAS[sel] overlaid."""
    h = copy.deepcopy(tree[idx])
    if sel >= 0 and h.get("_PnRAS"):
        p = h["_PnRAS"][sel]
        for k in ("gdsFile", "width", "height", "Blocks", "Terminals", "Nets", "LL", "UR", "PowerNets"): h[k] = copy.deepcopy(p[k])
    return h

def extract_pins_to_power_pins(h):
    for pn in h["PowerNets"]:
        for j, (_, it, it2) in enumerate(pn["connected"]):
            bc = h["Blocks"][it2]; pn["Pins"][j] = copy.deepcopy(bc["instance"][bc["selectedInstance"]]["pins"][it])

def build(dumpdir, layers):
    D = read_pdk_json(layers)
    inp = lambda suffix: glob.glob(f"{dumpdir}/inputs_*{suffix}")
    top = [f for f in inp(".abstract_verilog.json")][0].split("inputs_")[1].split(".")[0]
    lef = read_lef(open(inp(".lef")[0]).read(), D)
    vd = json.load(open(inp(".abstract_verilog.json")[0]))
    spv = json.load(open(inp(".scaled_placement_verilog.json")[0]))
    # router_driver: map_d_in = [(leaf concrete name, <input_dir>/<ctn>.gds)] for leaves with a .json
    gdsData2 = {}
    for leaf in spv["leaves"]:
        gdsData2.setdefault(leaf["concrete_name"], []).append(f"/work/X/3_pnr/inputs/{leaf['concrete_name']}.gds")
    tree, gs = read_verilog(vd)
    for n in tree:
        n["bias_Vgraph"], n["bias_Hgraph"] = D["Design_info"]["Vspace"], D["Design_info"]["Hspace"]
        f = inp(f"{n['name']}.pnr.const.json")
        if f: read_constraints(n, json.load(open(f[0])), D)
    topidx = semantic0(tree, top, gdsData2, lef)
    semantic1(tree, gs)
    semantic2(tree)
    stages = {"semantic": copy.deepcopy(tree)}
    # hierarchical_place with the placement verilog (PDK units -> PnRDB units: oX,oY,bbox * 2 / ScaleFactor)
    mods = {}
    for m in spv["modules"]:
        mm = copy.deepcopy(m)
        mm["bbox"] = [c * 2 // D["ScaleFactor"] for c in mm["bbox"]]
        for i in mm["instances"]:
            for k in ("oX", "oY"): i["transformation"][k] = i["transformation"][k] * 2 // D["ScaleFactor"]
        mods.setdefault(m["abstract_name"], []).append(mm)
    order = traverse(tree, topidx)
    stages["place_in"], stages["place_out"] = {}, {}
    for idx in order:
        node = checkout(tree, idx, -1)
        stages["place_in"][idx] = copy.deepcopy(node)
        placed = inject(node, mods[tree[idx]["name"]])
        stages["place_out"][idx] = copy.deepcopy(placed)
        checkin_hier_node(tree, idx, placed)
        tree[idx]["numPlacement"] = 1
    return D, tree, topidx, order, stages, lef

def route_inputs(tree, order, routed_by_idx):
    """route_bottom_up bookkeeping for one placement per node; routed_by_idx[idx] = routed hN (router output)."""
    res = {}
    for i in order:
        h = checkout(tree, i, 0)
        h["parent"] = []
        h["UR"] = [h["width"], h["height"]]
        for bc in h["Blocks"]:
            if bc["child"] >= 0:
                b = bc["instance"][bc["selectedInstance"]]
                child = routed_by_idx[bc["child"]]
                pins, ims, ivs = checkin(b, child)
                b["pins"], b["interMetals"], b["interVias"] = pins, ims, ivs
                b["gdsFile"] = child["gdsFile"]
        extract_pins_to_power_pins(h)
        res[i] = h
    return res

STRIP = {"_PnRAS", "_constraints", "n_PnRAS", "numPlacement", "n_copy", "gdsFile", "n_tiles_total"}
def canon(x, drop_orient=False):
    if isinstance(x, dict):
        return {k: canon(v, drop_orient) for k, v in x.items() if k not in STRIP and not (drop_orient and k == "orient")}
    if isinstance(x, list): return [canon(v, drop_orient) for v in x]
    return x

def dconn(x):
    """dummy_connected[].type is an uninitialised enum in C++ (CheckinHierNode); compare iter/iter2 only."""
    if isinstance(x, dict):
        return {k: ([c[1:] for c in v] if k == "dummy_connected" else dconn(v)) for k, v in x.items()}
    if isinstance(x, list): return [dconn(v) for v in x]
    return x

def first_diff(a, b, path=""):
    if type(a) != type(b): return f"{path}: {str(a)[:120]} != {str(b)[:120]}"
    if isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a or k not in b: return f"{path}.{k}: missing on one side"
            d = first_diff(a[k], b[k], f"{path}.{k}")
            if d: return d
    elif isinstance(a, list):
        if len(a) != len(b): return f"{path}: len {len(a)} != {len(b)}"
        for i, (x, y) in enumerate(zip(a, b)):
            d = first_diff(x, y, f"{path}[{i}]")
            if d: return d
    elif a != b: return f"{path}: {a} != {b}"
    return None

if __name__ == "__main__":
    dumpdir, layers = sys.argv[1], sys.argv[2]
    D, tree, topidx, order, stages, lef = build(dumpdir, layers)
    ok = True
    # 1. LEF
    real_lef = json.load(open(f"{dumpdir}/01_lefData.json"))
    d = first_diff(canon(lef), canon(real_lef)); ok &= d is None
    print("lefData            ", "OK" if d is None else d)
    # 2. semantic tree (block orient / via model of unplaced instances are don't-care)
    real = json.load(open(f"{dumpdir}/02_tree_after_semantic.json"))
    print("topidx/traverse    ", topidx == real["topidx"] and order == real["traverse"], order)
    for mine, theirs in zip(stages["semantic"], real["nodes"]):
        d = first_diff(canon(mine, True), canon(theirs, True)); ok &= d is None
        print(f"semantic {mine['name']:<26}", "OK" if d is None else d)
    # 3. node handed to the placer (before AddingPowerPins) and the placer's output
    for f in sorted(glob.glob(f"{dumpdir}/04_*")):
        r = json.load(open(f)); idx = r["idx"]
        d = first_diff(dconn(canon(stages["place_in"][idx], True)), dconn(canon(r["node_before"], True))); ok &= d is None
        print(f"place_in {r['node_before']['name']:<26}", "OK" if d is None else d)
    # 4. exact router input (children = real router outputs from the dumps)
    outs = {}
    for f in glob.glob(f"{dumpdir}/11_*"):
        h = json.load(open(f)); outs[next(i for i in order if tree[i]["name"] == h["name"])] = h
    # route_bottom_up appends routed nodes to hierTree; blk.child is re-pointed at them (child idx = len(tree)+k)
    rin = route_inputs(tree, order, outs)
    for k, i in enumerate(order):
        f = glob.glob(f"{dumpdir}/10_*_route_in_{tree[i]['name']}.json")[0]
        real_in = json.load(open(f))
        mine = rin[i]
        for bc in mine["Blocks"]:
            if bc["child"] >= 0: bc["child"] = len(tree) + order.index(bc["child"])
        d = first_diff(dconn(canon(mine)), dconn(canon(real_in))); ok &= d is None
        print(f"route_in {tree[i]['name']:<26}", "OK" if d is None else d)
    print("ALL OK" if ok else "MISMATCH")
