"""배선 단계 안에서 시간이 어디에 쓰이는지 잰다 (route.mjs --prof).

frontworker.mjs 의 route() 는 ALIGN 의 schematic2layout 을 두 번 부른다
(3_pnr:prep, 3_pnr:route). 그 안의 주요 함수와 C++ 호출을 감싸 누적 시간을 센다.
감싸기만 하고 동작은 바꾸지 않는다.
"""
import collections
import functools
import importlib
import time

T = collections.OrderedDict()
N = collections.Counter()


def _add(label, t):
    T[label] = T.get(label, 0.0) + time.perf_counter() - t
    N[label] += 1


def _wrap(modname, attr, label):
    m = importlib.import_module(modname)
    f = getattr(m, attr)
    if getattr(f, "_timed", False):
        return

    @functools.wraps(f)
    def g(*a, **k):
        t = time.perf_counter()
        try:
            return f(*a, **k)
        finally:
            _add(label, t)
    g._timed = True
    setattr(m, attr, g)


# 모듈 전역 이름으로 부르는 것들이라 쓰는 쪽 모듈에서 바꿔 끼운다
_wrap("align.main", "read_lib_json", "공통  read_lib_json (pydantic)")
_wrap("align.pnr.main", "manipulate_hierarchy", "prep  manipulate_hierarchy")
_wrap("align.pnr.main", "gen_constraint_files", "prep  gen_constraint_files")
_wrap("align.pnr.router", "change_concrete_names_for_routing", "route change_concrete_names")
_wrap("align.pnr.router", "gen_abstract_verilog_d", "route gen_abstract_verilog_d (deepcopy)")
_wrap("align.pnr.router", "gen_DB_verilog_d", "route PnRDB 구축 (PDK/LEF/verilog/제약)")
_wrap("align.pnr.router", "hierarchical_place", "route 배치 주입 (PlacerIfc)")
_wrap("align.pnr.router", "route", "route C++ 배선 합계 (bottom_up)")
_wrap("align.pnr.main", "gen_viewer_json", "post  gen_viewer_json (도형 합성 + DRC/LVS)")
_wrap("align.cell_fabric.gen_gds_json", "translate", "post  gen_gds_json.translate (파이썬 gds.json)")
_wrap("align.pnr.main", "_generate_json", "post  _generate_json 합계")
_wrap("align.main", "convert_GDSjson_GDS", "post  gds.json -> .gds (python-gdsii)")

import PnR  # noqa: E402

_MODES = {4: "C++   RouteWork 4 전역 배선", 5: "C++   RouteWork 5 상세 배선",
          2: "C++   RouteWork 2 전원 격자", 3: "C++   RouteWork 3 전원 배선"}
_route_work = PnR.Router.RouteWork


def _rw(self, mode, *a, **k):
    t = time.perf_counter()
    try:
        return _route_work(self, mode, *a, **k)
    finally:
        _add(_MODES.get(mode, "C++   RouteWork %d" % mode), t)


PnR.Router.RouteWork = _rw

for _meth in ("WriteJSON", "WriteGcellGlobalRoute", "WriteLef", "Write_Router_Report"):
    def _mk(orig, meth):
        def w(self, *a, **k):
            t = time.perf_counter()
            try:
                return orig(self, *a, **k)
            finally:
                _add("C++   DB.%s (파일 덤프)" % meth, t)
        return w
    setattr(PnR.PnRdatabase, _meth, _mk(getattr(PnR.PnRdatabase, _meth), _meth))

import align.main as _am  # noqa: E402

_s2l = _am.schematic2layout


def _schematic2layout(*a, **k):
    t = time.perf_counter()
    try:
        return _s2l(*a, **k)
    finally:
        _add("합계  schematic2layout %s" % k.get("flow_start"), t)


# route() 는 호출할 때 from align.main import schematic2layout 를 한다
_am.schematic2layout = _schematic2layout


def report():
    out = ["%9.2fs  x%-3d %s" % (v, N[k], k) for k, v in T.items()]
    T.clear()
    N.clear()
    return "\n".join(out)
