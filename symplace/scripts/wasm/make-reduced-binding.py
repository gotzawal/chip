"""배선에 필요한 것만 남긴 PnR 바인딩을 만든다.

원본 PnR-pybind11.cpp 는 placer / cap_placer / guard_ring / MNA / hanan_router
까지 전부 묶는다. 그중 placer 는 ilpif(ILPSolverInterface)를 링크하는데,
그건 **미리 빌드된 x86-64 바이너리**라 wasm 이 없다. MNA 는 superlu 를 쓴다.

브라우저에서는 배치를 우리 것으로 하므로 ALIGN 배치기가 필요 없다.
배선(Router)과 데이터베이스(PnRdatabase)만 남긴다.

사용법:  python3 make-reduced-binding.py <원본.cpp> <출력.cpp>
"""
import io
import re
import sys

src, dst = sys.argv[1], sys.argv[2]
s = io.open(src, encoding="utf8").read()

# 1) 빼는 모듈의 include
# placer 는 남긴다. router.py 가 hierarchical_place -> place() -> PlacerIfc 로
# **우리가 준 배치를 DB 에 채워 넣기** 때문이다 (use_external_placement_info=True).
# 그 경로는 ILP 를 풀지 않으므로 ILPSolverIf 는 스텁으로 때운다.
drop_inc = ["cap_placer/CapPlacerIfc.h",
            "guard_ring/GuardRingIfc.h", "hanan_router/HananRouter.h",
            "MNA/MNASimulationIfc.h"]
for h in drop_inc:
    s = re.sub(r'^#include "%s"\n' % re.escape(h), "", s, flags=re.M)

# 2) 빼는 바인딩 블록. py::class_<X>( m, "...") 부터 그 문장을 끝내는 ';' 까지.
drop_cls = ["Placer_Router_Cap_Ifc",
            "GuardRingIfc", "MNASimulationIfc", "HananRouter"]
for c in drop_cls:
    start = s.find("py::class_<%s>" % c)
    if start < 0:
        print("  ! 못 찾음: %s" % c)
        continue
    # 문장 끝(세미콜론)까지. 문자열 안의 ';' 는 이 파일에 없다.
    end = s.find(";", start)
    while end > 0 and s[start:end].count("(") != s[start:end].count(")"):
        end = s.find(";", end + 1)
    # 앞쪽 공백/줄바꿈도 같이 걷어낸다
    line_start = s.rfind("\n", 0, start) + 1
    s = s[:line_start] + s[end + 1:]
    print("  뺌: %s" % c)

io.open(dst, "w", encoding="utf8").write(s)

left = [c for c in drop_cls if ("py::class_<%s>" % c) in s]
print("  남은 것: %s" % (", ".join(left) if left else "없음"))
kept = ["PnRdatabase", "Router", "hierNode", "bbox", "point",
        "PlacerIfc", "PlacerHyperparameters"]
print("  유지 확인: %s" % ", ".join(
    "%s %s" % (k, "O" if ('py::class_<%s>' % k) in s else "X") for k in kept))
print("  %d -> %d 줄" % (io.open(src, encoding='utf8').read().count("\n"), s.count("\n")))
