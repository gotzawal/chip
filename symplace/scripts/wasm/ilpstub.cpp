// ILPSolverIf 스텁.
//
// placer 는 ilpif(ILPSolverInterface)를 링크하는데, 그건 미리 빌드된
// x86-64 솔버 바이너리라 wasm 이 없다. 그런데 우리가 쓰는 경로
// (use_external_placement_info=True -> setPlacementInfoFromJson)는
// ILP 를 풀지 않는다. ILPSolverIf 는 ILP_Place.cpp:313 과
// ILP_solver.cpp:1780 두 곳에서만 쓰이고 둘 다 탐색 경로다.
//
// 그래서 심볼만 채우고, 실제로 풀려 들면 소리 내어 멈춘다.
#include "ILPSolverIf.h"

#include <stdexcept>

ILPSolverIf::ILPSolverIf() : _t(0), _nvar(0), _nrow(0), _solver(nullptr), _sol(nullptr) {}
ILPSolverIf::~ILPSolverIf() {}

double ILPSolverIf::getInfinity() const { return 1e30; }

void ILPSolverIf::loadProblem(const int, const int, const int*, const int*, const double*,
                              const double*, const double*, const double*, const double*,
                              const double*, const int*) {
  throw std::runtime_error(
      "ILP 솔버는 브라우저 빌드에 없다. 배치 탐색 경로를 탄 것 같다 "
      "(외부 배치를 넘겼는지 확인해라).");
}

int ILPSolverIf::solve(const int) {
  throw std::runtime_error("ILP 솔버는 브라우저 빌드에 없다.");
}

void ILPSolverIf::writelp(char*, char**, char**) {}
