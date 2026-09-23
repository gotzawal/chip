// ALIGN 원본 C++ 의 RouteWork 4, 5 (GcellGlobalRouter -> GcellDetailRouter(node, GR, 1, 1)) 를 네이티브로 돌려
// 모드 5 기록(넷 경로, 모듈 핀, 내부 금속·비아, 단자)을 JSON 으로 낸다 — symplace/alignroute/src/dr 의 차분 시험 기준.
//
//   oracle5 <토큰 파일>     (토큰은 common.py 의 tokens(): drc, hierNode, 신호 층 범위)
//
// 출력: 기록 JSON 한 줄, 또는 {"error": "m4: ..."} / {"error": "m5: ..."} (C++ 예외).
// 기준(emscripten wasm32)과 맞추려고: libc++ (std::sort 가 같다), -ffp-contract=off, NDEBUG, 0 번지 쪽을 0 으로
// 깐다 (아래 main). get_variables 는 원본이 N 칸 VLA 에 N+1 칸을 쓰므로 앞 N 칸만 받는 것으로 바꿔 끼운다.
#include <algorithm>
#include <climits>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>
#include <memory>
#include <iterator>
#include <bitset>
#include <cctype>
#include <cstdlib>
#include <tuple>
#include <cfloat>
#include <unistd.h>
#include <sys/mman.h>
#include <assert.h>
#include <limits.h>
#include "spdlog/spdlog.h"
#include "nlohmann/json.hpp"
extern "C" {
#include "lp_lib.h"
}
#define private public
#define protected public
#include "GcellGlobalRouter.h"
#include "GcellDetailRouter.h"
#undef private
#undef protected

// get_variables 가 N+1 칸을 쓰는 것을 막는다 (C++ 은 N 칸 VLA — 여기서는 앞 N 칸만, 모자라면 0)
extern "C" MYBOOL oracle_get_variables(lprec *lp, REAL *var) {
  int cols = get_Ncolumns(lp);
  int orig = get_Norig_columns(lp);
  std::vector<REAL> tmp(cols + 1, 0.0);
  MYBOOL r = get_variables(lp, tmp.data());
  for (int i = 0; i < orig - 1; i++) var[i] = i < cols ? tmp[i] : 0.0;
  if (cols != orig) fprintf(stderr, "presolve removed columns: %d -> %d\n", orig, cols);
  return r;
}

static std::istream *IN;
static std::string tok() {
  std::string s;
  if (!(*IN >> s)) throw std::runtime_error("eof");
  return s;
}
static int I() { return std::stoi(tok()); }
static double D() { return std::stod(tok()); }
static std::string S() {
  std::string t = tok();
  std::string out;
  for (size_t i = 1; i + 1 < t.size(); i += 2) out.push_back((char)std::stoi(t.substr(i, 2), nullptr, 16));
  return out;
}
static PnRDB::point P() {
  PnRDB::point p;
  p.x = I();
  p.y = I();
  return p;
}
static PnRDB::bbox B() {
  PnRDB::bbox b;
  b.LL = P();
  b.UR = P();
  return b;
}
static PnRDB::contact C() {
  PnRDB::contact c;
  c.metal = S();
  c.originBox = B();
  c.placedBox = B();
  c.originCenter = P();
  c.placedCenter = P();
  return c;
}
static PnRDB::Via V() {
  PnRDB::Via v;
  v.model_index = I();
  v.originpos = P();
  v.placedpos = P();
  v.UpperMetalRect = C();
  v.LowerMetalRect = C();
  v.ViaRect = C();
  return v;
}
static PnRDB::pin PIN() {
  PnRDB::pin p;
  p.name = S();
  p.netIter = I();
  int n = I();
  for (int i = 0; i < n; i++) p.pinContacts.push_back(C());
  n = I();
  for (int i = 0; i < n; i++) p.pinVias.push_back(V());
  return p;
}
static PnRDB::Metal MET() {
  PnRDB::Metal m;
  m.MetalIdx = I();
  m.width = I();
  m.MetalRect = C();
  int n = I();
  for (int i = 0; i < n; i++) m.LinePoint.push_back(P());
  return m;
}

// ---------------------------------------------------------------- JSON 쓰기
static std::ostringstream O;
static std::string js(const std::string &s) {
  std::string o = "\"";
  for (char c : s) {
    if (c == '"' || c == '\\') o += '\\';
    o += c;
  }
  return o + "\"";
}
// ---------------------------------------------------------------- PnRDB -> JSON (pybind 덤프와 같은 키)
static std::string jp(const PnRDB::point &p) { return "{\"x\":" + std::to_string(p.x) + ",\"y\":" + std::to_string(p.y) + "}"; }
static std::string jb(const PnRDB::bbox &b) { return "{\"LL\":" + jp(b.LL) + ",\"UR\":" + jp(b.UR) + "}"; }
static std::string jc(const PnRDB::contact &c) {
  return "{\"metal\":" + js(c.metal) + ",\"originBox\":" + jb(c.originBox) + ",\"originCenter\":" + jp(c.originCenter) + ",\"placedBox\":" + jb(c.placedBox) +
         ",\"placedCenter\":" + jp(c.placedCenter) + "}";
}
static std::string jvia(const PnRDB::Via &v) {
  return "{\"model_index\":" + std::to_string(v.model_index) + ",\"originpos\":" + jp(v.originpos) + ",\"placedpos\":" + jp(v.placedpos) +
         ",\"UpperMetalRect\":" + jc(v.UpperMetalRect) + ",\"LowerMetalRect\":" + jc(v.LowerMetalRect) + ",\"ViaRect\":" + jc(v.ViaRect) + "}";
}
static std::string jmetal(const PnRDB::Metal &m) {
  std::string s = "{\"MetalIdx\":" + std::to_string(m.MetalIdx) + ",\"LinePoint\":[";
  for (size_t i = 0; i < m.LinePoint.size(); i++) s += (i ? "," : "") + jp(m.LinePoint[i]);
  return s + "],\"width\":" + std::to_string(m.width) + ",\"MetalRect\":" + jc(m.MetalRect) + "}";
}
static std::string jpin(const PnRDB::pin &p) {
  std::string s = "{\"name\":" + js(p.name) + ",\"type\":" + js(p.type) + ",\"use\":" + js(p.use) + ",\"netIter\":" + std::to_string(p.netIter) + ",\"pinContacts\":[";
  for (size_t i = 0; i < p.pinContacts.size(); i++) s += (i ? "," : "") + jc(p.pinContacts[i]);
  s += "],\"pinVias\":[";
  for (size_t i = 0; i < p.pinVias.size(); i++) s += (i ? "," : "") + jvia(p.pinVias[i]);
  return s + "]}";
}

int main(int argc, char **argv) {
  // 기준(wasm32, Pyodide)은 0 번지부터 1024 바이트가 0 이다 — 빈 벡터의 [0] 읽기(데이터 포인터 null)가
  // 0 을 읽고 지나간다. 네이티브에서도 0 쪽을 0 으로 채운 쪽으로 깔아 같은 길을 가게 한다 (ORACLE_NOZERO=1 이면 안 깐다).
  if (!getenv("ORACLE_NOZERO")) {
    void *z = mmap((void *)0, 4096, PROT_READ | PROT_WRITE, MAP_FIXED | MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (z == MAP_FAILED) { perror("mmap(0)"); return 3; }
  }
  std::ifstream f(argv[1]);
  IN = &f;
  PnRDB::Drc_info drc;
  drc.MaxLayer = I();
  int n = I();
  for (int i = 0; i < n; i++) {
    std::string k = S();
    drc.Metalmap[k] = I();
  }
  n = I();
  for (int i = 0; i < n; i++) {
    std::string k = S();
    drc.Viamap[k] = I();
  }
  n = I();
  for (int i = 0; i < n; i++) {
    PnRDB::metal_info m;
    m.name = S();
    m.layerNo = I();
    m.width = I();
    m.dist_ss = I();
    m.direct = I();
    m.grid_unit_x = I();
    m.grid_unit_y = I();
    m.minL = I();
    m.maxL = I();
    m.dist_ee = I();
    m.offset = I();
    m.unit_R = D();
    m.unit_C = D();
    m.unit_CC = D();
    m.lower_via_index = I();
    m.upper_via_index = I();
    drc.Metal_info.push_back(m);
  }
  n = I();
  for (int i = 0; i < n; i++) {
    PnRDB::via_info v;
    v.name = S();
    v.layerNo = I();
    v.lower_metal_index = I();
    v.upper_metal_index = I();
    v.width = I();
    v.width_y = I();
    v.cover_l = I();
    v.cover_l_P = I();
    v.cover_u = I();
    v.cover_u_P = I();
    v.dist_ss = I();
    v.dist_ss_y = I();
    v.R = D();
    drc.Via_info.push_back(v);
  }
  n = I();
  for (int i = 0; i < n; i++) {
    PnRDB::ViaModel v;
    v.name = S();
    v.ViaIdx = I();
    v.LowerIdx = I();
    v.UpperIdx = I();
    for (auto *r : {&v.ViaRect, &v.LowerRect, &v.UpperRect}) {
      int k = I();
      for (int j = 0; j < k; j++) r->push_back(P());
    }
    v.R = D();
    drc.Via_model.push_back(v);
  }

  PnRDB::hierNode node;
  node.name = S();
  node.isTop = I();
  node.isIntelGcellGlobalRouter = I();
  node.width = I();
  node.height = I();
  node.LL = P();
  node.UR = P();
  n = I();
  for (int i = 0; i < n; i++) {
    PnRDB::terminal t;
    t.name = S();
    t.type = S();
    t.netIter = I();
    int k = I();
    for (int j = 0; j < k; j++) t.termContacts.push_back(C());
    node.Terminals.push_back(t);
  }
  n = I();
  for (int i = 0; i < n; i++) {
    PnRDB::net t;
    t.name = S();
    t.shielding = I();
    t.sink2Terminal = I();
    t.degree = I();
    t.symCounterpart = I();
    t.iter2SNetLsit = I();
    t.priority = S();
    t.axis_dir = I() == 0 ? PnRDB::H : PnRDB::V;
    t.axis_coor = I();
    t.multi_connection = I();
    int k = I();
    for (int j = 0; j < k; j++) {
      PnRDB::connectNode c;
      c.type = I() == 0 ? PnRDB::Block : PnRDB::Terminal;
      c.iter = I();
      c.iter2 = I();
      t.connected.push_back(c);
    }
    node.Nets.push_back(t);
  }
  n = I();
  for (int i = 0; i < n; i++) {
    PnRDB::blockComplex bc;
    bc.selectedInstance = I();
    bc.child = I();
    bc.instNum = I();
    int k = I();
    for (int j = 0; j < k; j++) {
      PnRDB::block b;
      b.name = S();
      b.master = S();
      b.gdsFile = S();
      b.orient = PnRDB::Omark(I());
      b.isLeaf = I();
      b.width = I();
      b.height = I();
      b.placedBox = B();
      b.originBox = B();
      int m = I();
      for (int q = 0; q < m; q++) b.blockPins.push_back(PIN());
      m = I();
      for (int q = 0; q < m; q++) b.interMetals.push_back(C());
      m = I();
      for (int q = 0; q < m; q++) b.interVias.push_back(V());
      bc.instance.push_back(b);
    }
    node.Blocks.push_back(bc);
  }
  n = I();
  for (int i = 0; i < n; i++) {
    PnRDB::PowerNet p;
    p.name = S();
    p.power = I();
    int k = I();
    for (int j = 0; j < k; j++) p.Pins.push_back(PIN());
    k = I();
    for (int j = 0; j < k; j++) p.path_metal.push_back(MET());
    k = I();
    for (int j = 0; j < k; j++) p.path_via.push_back(V());
    node.PowerNets.push_back(p);
  }
  n = I();
  for (int i = 0; i < n; i++) node.DoNotRoute.push_back(S());
  node.Routing_Layers.global_min_layer = S();
  node.Routing_Layers.global_max_layer = S();
  n = I();
  for (int i = 0; i < n; i++) {
    PnRDB::Min_Max_Routing_Layer_Per_Net r;
    r.net_name = S();
    r.net_min_layer = S();
    r.net_max_layer = S();
    node.Routing_Layers.Routing_per_Net.push_back(r);
  }
  int Lm = I(), Hm = I();


  node.n_copy = 0;
  GcellGlobalRouter *gr = nullptr;
  try {
    gr = new GcellGlobalRouter(node, drc, Lm, Hm);
  } catch (std::exception &e) {
    std::cout << "{\"error\":" << js(std::string("m4: ") + e.what()) << "}" << std::endl;
    return 0;
  }
  if (getenv("ORACLE_M4ONLY")) { std::cout << "{}" << std::endl; return 0; }
  try {
    GcellDetailRouter dr(node, *gr, 1, 1);
  } catch (std::exception &e) {
    std::cout << "{\"error\":" << js(std::string("m5: ") + e.what()) << "}" << std::endl;
    return 0;
  }
  // 모드 5 기록 (src/route/align/records.mjs recordOf 와 같은 모양)
  O << "{\"Nets\":[";
  for (size_t i = 0; i < node.Nets.size(); i++) {
    auto &n = node.Nets[i];
    O << (i ? "," : "") << "{\"name\":" << js(n.name) << ",\"path_metal\":[";
    for (size_t j = 0; j < n.path_metal.size(); j++) O << (j ? "," : "") << jmetal(n.path_metal[j]);
    O << "],\"path_via\":[";
    for (size_t j = 0; j < n.path_via.size(); j++) O << (j ? "," : "") << jvia(n.path_via[j]);
    O << "]}";
  }
  O << "],\"blockPins\":[";
  for (size_t i = 0; i < node.blockPins.size(); i++) O << (i ? "," : "") << jpin(node.blockPins[i]);
  O << "],\"interMetals\":[";
  for (size_t i = 0; i < node.interMetals.size(); i++) O << (i ? "," : "") << jc(node.interMetals[i]);
  O << "],\"interVias\":[";
  for (size_t i = 0; i < node.interVias.size(); i++) O << (i ? "," : "") << jvia(node.interVias[i]);
  O << "],\"Terminals\":[";
  for (size_t i = 0; i < node.Terminals.size(); i++) {
    auto &t = node.Terminals[i];
    O << (i ? "," : "") << "{\"name\":" << js(t.name) << ",\"termContacts\":[";
    for (size_t j = 0; j < t.termContacts.size(); j++) O << (j ? "," : "") << jc(t.termContacts[j]);
    O << "]}";
  }
  O << "]}";
  std::cout << O.str() << std::endl;
  return 0;
}
