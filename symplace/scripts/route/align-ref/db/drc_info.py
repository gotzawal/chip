#!/usr/bin/env python3
"""Re-implementation of PnRdatabase::ReadPDKJSON (PlaceRouteHierFlow/PnRDB/ReadDesignRuleJson.cpp)
with FinFET_MOCK_PDK defined, to print the concrete PnRDB::Drc_info for a layers.json.

Usage: drc_info.py <layers.json> [out.json]
All integer arithmetic mirrors C++ int semantics (truncating division toward zero).
"""
import json, sys


def cdiv(a, b):
    # C++ integer division truncates toward zero
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b >= 0) else -q


def first(v):
    return v[0] if isinstance(v, list) else v


def read_pdk_json(path):
    j = json.load(open(path))
    times = 2
    SF = j["ScaleFactor"]
    layers = j["Abstraction"]
    D = {"ScaleFactor": SF}

    # 1. metals, keyed by metal_index (2,4,6,... in file order) -> std::map keeps file order
    metal_set = {}
    mi = 0
    for L in layers:
        name = L["Layer"]
        if name[0] != 'M':
            continue
        mi += 2
        pitch = first(L["Pitch"])
        width = first(L["Width"])
        m = {
            "name": name,
            "layerNo": L["GdsLayerNo"],
            "gds_datatype": {k: L["GdsDatatype"].get(k) for k in ("Draw", "Pin", "Label", "Blockage")},
            "direct": 0 if L["Direction"] == "V" else 1,
            "width": cdiv(times * width, SF),
            "dist_ss": cdiv(times * (pitch - width), SF),
            "minL": cdiv(times * L["MinL"], SF),
            "maxL": "UNSET (indeterminate int; MaxL is never read)",
            "dist_ee": cdiv(times * L["EndToEnd"], SF),
            "offset": cdiv(times * L["Offset"], SF),
            "unit_R": (L.get("UnitR", {}).get("Mean") or 0) * 0.0005,
            "unit_C": (L.get("UnitC", {}).get("Mean") or 0) * 0.0005,
            "unit_CC": (L.get("UnitCC", {}).get("Mean") or 0) * 0.0005,
            "lower_via_index": -1,
            "upper_via_index": -1,
        }
        if m["direct"] == 0:
            m["grid_unit_x"], m["grid_unit_y"] = cdiv(times * pitch, SF), -1
        else:
            m["grid_unit_x"], m["grid_unit_y"] = -1, cdiv(times * pitch, SF)
        metal_set[mi] = m
    Metal_info = [metal_set[k] for k in sorted(metal_set)]
    Metalmap = {m["name"]: i for i, m in enumerate(Metal_info)}
    D["MaxLayer"] = len(Metal_info) - 1

    # Outline -> top_boundary
    for L in layers:
        if L["Layer"] == "Outline":
            D["top_boundary"] = {"name": "Boundary", "layerNo": L["GdsLayerNo"], "gds_datatype": {"Draw": L["GdsDatatype"]["Draw"]}}

    # 2. vias: viaSet (lower metal present) first, then viaSet_vt (lower metal null), each in file order
    via_set, via_set_vt = {}, {}
    vi = 0
    for L in layers:
        name = L["Layer"]
        if name[0] != 'V':
            continue
        vi += 2
        st = L["Stack"]
        idx = [Metalmap[s] if isinstance(s, str) else -1 for s in st]
        v = {
            "name": name,
            "layerNo": L["GdsLayerNo"],
            "gds_datatype": {"Draw": L["GdsDatatype"]["Draw"]},
            "width": cdiv(times * L["WidthX"], SF),
            "width_y": cdiv(times * L["WidthY"], SF),
            "cover_l": cdiv(times * L["VencA_L"], SF),
            "cover_l_P": cdiv(times * L["VencP_L"], SF),
            "cover_u": cdiv(times * L["VencA_H"], SF),
            "cover_u_P": cdiv(times * L["VencP_H"], SF),
            "dist_ss": cdiv(times * L["SpaceX"], SF),
            "dist_ss_y": cdiv(times * L["SpaceY"], SF),
            "R": (L.get("R", {}).get("Mean") or 0),
            "lower_metal_index": idx[0],
            "upper_metal_index": idx[1],
        }
        (via_set if idx[0] != -1 else via_set_vt)[vi] = v
    Via_info = []
    Viamap = {}
    for group in (via_set, via_set_vt):
        for k in sorted(group):
            v = group[k]
            Via_info.append(v)
            Viamap[v["name"]] = len(Via_info) - 1
            if v["lower_metal_index"] != -1:
                Metal_info[v["lower_metal_index"]]["upper_via_index"] = len(Via_info) - 1
            if v["upper_metal_index"] != -1:
                Metal_info[v["upper_metal_index"]]["lower_via_index"] = len(Via_info) - 1

    for L in layers:
        if L["Layer"] == "GuardRing":
            D["Guardring_info"] = {"xspace": cdiv(L["XSpace"] * times, SF), "yspace": cdiv(L["YSpace"] * times, SF)}

    D["metal_weight"] = [1] * len(Metal_info)

    # 4. via models
    Via_model = []
    for i, v in enumerate(Via_info):
        vm = {"name": v["name"], "ViaIdx": i, "LowerIdx": v["lower_metal_index"], "UpperIdx": v["upper_metal_index"],
              "ViaRect": [[-cdiv(v["width"], 2), -cdiv(v["width_y"], 2)], [cdiv(v["width"], 2), cdiv(v["width_y"], 2)]],
              "R": v["R"], "LowerRect": [], "UpperRect": []}
        for key, midx, cov, covP in (("LowerRect", v["lower_metal_index"], v["cover_l"], v["cover_l_P"]),
                                     ("UpperRect", v["upper_metal_index"], v["cover_u"], v["cover_u_P"])):
            if midx < 0:
                continue
            m = Metal_info[midx]
            w = m["width"]
            hw, hwy = cdiv(v["width"], 2), cdiv(v["width_y"], 2)
            if m["direct"] == 0:  # vertical metal
                ll = [min(0 - hw - covP, -cdiv(w, 2)), 0 - hwy - cov]
                ur = [max(0 + hw + covP, cdiv(w, 2)), 0 + hwy + cov]
            else:
                ll = [0 - hw - cov, min(0 - hwy - covP, -cdiv(w, 2))]
                ur = [0 + hw + cov, max(0 + hwy + covP, cdiv(w, 2))]
            vm[key] = [ll, ur]
        Via_model.append(vm)

    D["MaskID_Metal"] = [str(m["layerNo"]) for m in Metal_info]
    D["MaskID_Via"] = [str(v["layerNo"]) for v in Via_info]

    # 7. design info
    DI = {"Hspace": 0, "Vspace": 0, "compact_style": "left"}
    for k in (0, 1):
        if Metal_info[k]["direct"] == 1:
            DI["Vspace"] = Metal_info[k]["grid_unit_y"]
        else:
            DI["Hspace"] = Metal_info[k]["grid_unit_x"]
    if "design_info" in j:
        d = j["design_info"]
        DI["Hspace"] = cdiv(d["Hspace"] * times, SF)
        DI["Vspace"] = cdiv(d["Vspace"] * times, SF)
        DI["signal_routing_metal_l"] = Metalmap[d["bottom_signal_routing_layer"]]
        DI["signal_routing_metal_u"] = Metalmap[d["top_signal_routing_layer"]]
        DI["power_routing_metal_l"] = Metalmap[d["bottom_power_routing_layer"]]
        DI["power_routing_metal_u"] = Metalmap[d["top_power_routing_layer"]]
        DI["h_skip_factor"] = d.get("h_skip_factor", 7)
        DI["v_skip_factor"] = d.get("v_skip_factor", 8)
        if "compact_placement" in d:
            DI["compact_style"] = d["compact_placement"]
        DI["power_grid_metal_l"] = Metalmap[d["top_power_routing_layer"]] - 1
        DI["power_grid_metal_u"] = Metalmap[d["top_power_routing_layer"]]
        if "bottom_power_grid_layer" in d:
            DI["power_grid_metal_l"] = Metalmap[d["bottom_power_grid_layer"]]
        if "top_power_grid_layer" in d:
            DI["power_grid_metal_u"] = Metalmap[d["top_power_grid_layer"]]
    D["Design_info"] = DI
    D["Metal_info"] = Metal_info
    D["Metalmap"] = Metalmap
    D["Via_info"] = Via_info
    D["Viamap"] = Viamap
    D["Via_model"] = Via_model
    return D


if __name__ == "__main__":
    D = read_pdk_json(sys.argv[1])
    out = json.dumps(D, indent=1)
    if len(sys.argv) > 2:
        open(sys.argv[2], "w").write(out)
    # compact tables for the report
    print("ScaleFactor", D["ScaleFactor"], "MaxLayer", D["MaxLayer"])
    print("Design_info", D["Design_info"])
    print("top_boundary", D["top_boundary"], "Guardring_info", D["Guardring_info"])
    print("| idx | name | layerNo | Draw/Pin/Label/Blk | dir | grid_x | grid_y | width | dist_ss | minL | dist_ee | offset | unit_R | lower_via | upper_via |")
    for i, m in enumerate(D["Metal_info"]):
        g = m["gds_datatype"]
        print(f'| {i} | {m["name"]} | {m["layerNo"]} | {g["Draw"]}/{g["Pin"]}/{g["Label"]}/{g["Blockage"]} | {"H" if m["direct"] else "V"} ({m["direct"]}) | {m["grid_unit_x"]} | {m["grid_unit_y"]} | {m["width"]} | {m["dist_ss"]} | {m["minL"]} | {m["dist_ee"]} | {m["offset"]} | {m["unit_R"]:g} | {m["lower_via_index"]} | {m["upper_via_index"]} |')
    print("| idx | name | layerNo | Draw | lower | upper | width | width_y | cover_l | cover_l_P | cover_u | cover_u_P | dist_ss | dist_ss_y | R | ViaRect | LowerRect | UpperRect |")
    for i, (v, vm) in enumerate(zip(D["Via_info"], D["Via_model"])):
        print(f'| {i} | {v["name"]} | {v["layerNo"]} | {v["gds_datatype"]["Draw"]} | {v["lower_metal_index"]} | {v["upper_metal_index"]} | {v["width"]} | {v["width_y"]} | {v["cover_l"]} | {v["cover_l_P"]} | {v["cover_u"]} | {v["cover_u_P"]} | {v["dist_ss"]} | {v["dist_ss_y"]} | {v["R"]:g} | {vm["ViaRect"]} | {vm["LowerRect"]} | {vm["UpperRect"]} |')
    print("MaskID_Metal", D["MaskID_Metal"])
    print("MaskID_Via", D["MaskID_Via"])
    print("Viamap", D["Viamap"])
