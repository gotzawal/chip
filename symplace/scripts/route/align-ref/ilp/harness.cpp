// Scratch harness: re-creates the GcellGlobalRouter ST generation (GlobalGraph logic copied
// literally, logging removed) on a tiny synthetic tile grid and then builds the ILP exactly like
// GcellGlobalRouter::ILPSolveRouting (including its quirks), solves it with lp_solve 5.5.2.11
// using the same settings, and brute-forces all assignments to count ties.
#include <climits>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>
#include <algorithm>
extern "C" {
#include "lp_lib.h"
}
using namespace std;

struct Edge { int dest, weight, capacity; };
struct Node { int src; vector<Edge> list; };
struct TileEdge { int next, capacity; };
struct Tile { int x, y, metal; vector<TileEdge> north, south, east, west, up, down; };

struct GG {  // literal copy of GlobalGraph semantics
  vector<vector<int>> Pin_terminals;
  int source, dest;
  vector<Node> graph;
  vector<vector<pair<int, int>>> Path;
  vector<Tile>* tiles;
  void build(vector<Tile>& T) {
    tiles = &T;
    graph.clear();
    for (unsigned i = 0; i < T.size(); i++) {
      Node n; n.src = i;
      auto upd = [&](vector<TileEdge>& v) {
        for (auto& e : v) if (e.capacity > 0 && e.next != -1) {
          Edge E; E.dest = e.next;
          E.weight = (double)abs(T[i].y - T[e.next].y) + abs(T[i].x - T[e.next].x);
          E.capacity = e.capacity; n.list.push_back(E);
        }
      };
      upd(T[i].north); upd(T[i].south); upd(T[i].east); upd(T[i].west); upd(T[i].up); upd(T[i].down);
      graph.push_back(n);
    }
    source = graph.size(); dest = source + 1;
    Node s; s.src = source; graph.push_back(s);
    Node d; d.src = dest; graph.push_back(d);
  }
  void SetSrcDest(vector<int> a, vector<int> b) {
    for (int t : a) { Edge e{t, 0, 0}; graph[source].list.push_back(e); e.dest = source; graph[t].list.push_back(e); }
    for (int t : b) { Edge e{t, 0, 0}; graph[dest].list.push_back(e); e.dest = dest; graph[t].list.push_back(e); }
  }
  void RMSrcDest(vector<int> a, vector<int> b) {
    graph[source].list.clear(); graph[dest].list.clear();
    for (int t : a) graph[t].list.pop_back();
    for (int t : b) graph[t].list.pop_back();
  }
  void Rm(multimap<double, int>& m, double d, int idx) {
    auto lo = m.lower_bound(d), hi = m.upper_bound(d);
    for (auto it = lo; it != hi; ++it) if (it->second == idx) { m.erase(it); return; }
    fprintf(stderr, "cannot find\n");
  }
  vector<int> dijkstra() {
    vector<int> path;
    vector<double> dist(graph.size(), INT_MAX);
    vector<int> parent(graph.size(), -1), status(graph.size(), 0);
    multimap<double, int> dm;
    dist[source] = 0; status[source] = 1; dm.insert({0.0, source});
    int count = 0;
    while (status[dest] != 2 && count < (int)graph.size() - 1) {
      if (dm.empty()) return path;
      double mn = dm.begin()->first;
      vector<int> ulist;
      for (auto it = dm.lower_bound(mn); it != dm.upper_bound(mn); ++it) ulist.push_back(it->second);
      int u = ulist[0];
      Rm(dm, dist[u], u);
      status[u] = 2;
      for (auto& e : graph[u].list) {
        int v = e.dest;
        if (v == u) continue;
        if (status[v] == 0) { parent[v] = u; dist[v] = dist[u] + e.weight; status[v] = 1; dm.insert({dist[v], v}); }
        else if (status[v] == 1 && dist[v] > dist[u] + e.weight) {
          parent[v] = u; double od = dist[v]; dist[v] = dist[u] + e.weight; Rm(dm, od, v); dm.insert({dist[v], v});
        }
      }
      count++;
    }
    vector<int> rev;
    for (int j = dest; j != -1; j = parent[j]) rev.push_back(j);
    for (int k = rev.size() - 1; k >= 0; k--) if (rev[k] != source && rev[k] != dest) path.push_back(rev[k]);
    return path;
  }
  void InitialSrcDest(vector<int>& s, vector<int>& d, vector<int>& acc) {
    set<int> ss, ds;
    for (unsigned i = 0; i < Pin_terminals.size(); i++) {
      if (i == 0) { for (int t : Pin_terminals[i]) ss.insert(t); acc.push_back(1); }
      else { for (int t : Pin_terminals[i]) ds.insert(t); acc.push_back(0); }
    }
    s.assign(ss.begin(), ss.end()); d.assign(ds.begin(), ds.end());
  }
  void ChangeSrcDest(vector<int>& s, vector<int>& d, vector<int> p, vector<int>& acc) {
    for (int t : p) for (unsigned j = 0; j < Pin_terminals.size(); j++) for (int q : Pin_terminals[j]) if (t == q) acc[j] = 1;
    set<int> ss, ds;
    for (unsigned i = 0; i < acc.size(); i++) for (int t : Pin_terminals[i]) (acc[i] == 1 ? ss : ds).insert(t);
    for (int t : p) ss.insert(t);
    s.assign(ss.begin(), ss.end()); d.assign(ds.begin(), ds.end());
  }
  int CalcW(vector<vector<int>>& P) {
    int sum = 0;
    for (auto& p : P) for (unsigned j = 0; j + 1 < p.size(); j++)
      for (auto& e : graph[p[j]].list) if (e.dest == p[j + 1]) { sum += e.weight; break; }
    return sum;
  }
  vector<pair<int, int>> Edges(vector<vector<int>>& P) {
    vector<pair<int, int>> r;
    for (auto& p : P) {
      if (p.size() == 1) r.push_back({p[0], p[0]});
      for (int j = 0; j < (int)p.size() - 1; j++) r.push_back({p[j], p[j + 1]});
    }
    return r;
  }
  void MST(int& WL, vector<pair<int, int>>& tp) {
    vector<vector<int>> MP; vector<int> s, d, acc;
    InitialSrcDest(s, d, acc);
    if (d.empty()) MP.push_back({s[0]});
    while (!d.empty()) {
      vector<int> a = s, b = d;
      SetSrcDest(a, b);
      vector<int> p = dijkstra();
      if (p.empty()) throw runtime_error("Empty path");
      MP.push_back(p);
      RMSrcDest(a, b);
      ChangeSrcDest(s, d, p, acc);
    }
    WL = CalcW(MP); tp = Edges(MP);
  }
  void GetWL(int& WL, int& index, vector<int> cand) {
    int last = INT_MAX;
    for (unsigned i = 0; i < cand.size(); i++) {
      Pin_terminals.push_back({cand[i]});
      vector<pair<int, int>> tp; MST(WL, tp);
      if (WL < last) { last = WL; index = i; }
      Pin_terminals.pop_back();
    }
  }
  void IterSteiner(vector<int>& cand) {
    int it = (int)Pin_terminals.size() - 2, lastWL = INT_MAX, WL = INT_MAX, flag = 1;
    while (it > 0 && flag) {
      int index = -1;
      GetWL(WL, index, cand);
      if (lastWL - WL > 0) {
        lastWL = WL;
        vector<int> keep;
        for (unsigned i = 0; i < cand.size(); i++) { if ((int)i == index) Pin_terminals.push_back({cand[i]}); else keep.push_back(cand[i]); }
        cand = keep;
      } else flag = 0;
      it--;
    }
  }
  void UpdW(vector<pair<int, int>>& p) {
    for (auto& e : p) {
      for (auto& x : graph[e.first].list) if (x.dest == e.second) x.weight *= 2;
      for (auto& x : graph[e.second].list) if (x.dest == e.first) x.weight *= 2;
    }
  }
  void FindSTs(int pathNo, vector<int>& cand) {
    auto tt = Pin_terminals;
    bool empty = true;
    for (auto& g : tt) if (!g.empty()) empty = false;
    if (empty) return;
    for (int i = 0; i < pathNo; i++) {
      Pin_terminals = tt;
      IterSteiner(cand);
      int w; vector<pair<int, int>> tp; MST(w, tp); UpdW(tp); Path.push_back(tp);
    }
  }
};

static double g_delta; static int g_triv, g_nodes, g_rows_after, g_cols_after, g_rows;
struct Opts { int tag = 0; bool brute = false; bool presolve = true; int floorfirst = -1; bool reverse_rows = false; bool nopresolve = false; };

// Returns chosen ST index per net (STindex semantics: default 0, set when Vars[i]==1).
vector<int> solveILP(vector<vector<vector<pair<int, int>>>>& STs, GG& g, Opts o, double* obj, int* ncolafter, int* ret) {
  int N = 0; vector<pair<int, int>> val;  // (net, st)
  vector<vector<int>> valIdx(STs.size());
  for (unsigned h = 0; h < STs.size(); h++) for (unsigned i = 0; i < STs[h].size(); i++) { valIdx[h].push_back(N++); val.push_back({h, i}); }
  lprec* lp = make_lp(0, N + 1);
  set_verbose(lp, IMPORTANT);
  set_outputfile(lp, (char*)"/dev/null");
  vector<vector<pair<vector<double>, vector<int>>>> dummy;
  struct Row { vector<double> v; vector<int> c; int type; double rhs; };
  vector<Row> rows;
  for (unsigned i = 0; i < STs.size(); i++) {
    Row r; r.type = EQ; r.rhs = 1;
    for (unsigned k = 0; k < STs[i].size(); k++) { r.c.push_back(valIdx[i][k] + 1); r.v.push_back(1); }
    if (r.v.empty()) continue;
    rows.push_back(r);
  }
  // capacity rows (literal copy of the quirky construction)
  vector<pair<int, int>> Edges; vector<int> Caps; vector<vector<int>> E2V;
  int cnt = 0;
  for (unsigned i = 0; i < STs.size(); i++) for (unsigned j = 0; j < STs[i].size(); j++) {
    cnt++;
    for (auto& e : STs[i][j]) {
      int found = 0, index = -1;
      for (unsigned l = 0; l < Edges.size(); l++)
        if ((e.first == Edges[l].first && e.second == Edges[l].second) || (e.first == Edges[l].second && e.second == Edges[l].first)) { found = 1; index = l; break; }
      if (found) E2V[index].push_back(cnt);
      else for (auto& x : g.graph[e.first].list) if (x.dest == e.second) { Caps.push_back(x.capacity); Edges.push_back(e); E2V.push_back({}); break; }
    }
  }
  for (unsigned i = 0; i < E2V.size(); i++) {
    Row r; r.type = LE; r.rhs = 0;
    for (int j = 0; j < cnt; j++) { bool f = false; for (int k : E2V[i]) if (k == j) f = true; if (f) { r.c.push_back(j + 1); r.v.push_back(1); } }
    r.c.push_back(cnt + 1); r.v.push_back(-Caps[i]);
    rows.push_back(r);
  }
  if (o.brute) {
    // enumerate all assignments (one ST per net with STs); s = max(count/cap) over LE rows
    vector<int> nets; for (unsigned i = 0; i < STs.size(); i++) if (!STs[i].empty()) nets.push_back(i);
    long total = 1; for (int n : nets) total *= STs[n].size();
    double best = 1e30; long nbest = 0; set<vector<vector<pair<int,int>>>> geoms;
    vector<pair<double, vector<int>>> all;
    for (long a = 0; a < total; a++) {
      long r = a; vector<int> choice(STs.size(), -1); vector<char> x(N + 2, 0);
      for (int n : nets) { int k = r % STs[n].size(); r /= STs[n].size(); choice[n] = k; x[valIdx[n][k] + 1] = 1; }
      double s = 0; bool feas = true;
      for (auto& row : rows) if (row.type == LE) {
        double c = 0, cap = 0;
        for (unsigned q = 0; q < row.c.size(); q++) { if (row.c[q] == N + 1) cap = -row.v[q]; else c += x[row.c[q]]; }
        double need = c / cap; if (need > s) s = need; if (need > 1) feas = false;
      }
      if (!feas) continue;
      all.push_back({s, choice});
      if (s < best - 1e-12) best = s;
    }
    for (auto& pr : all) if (pr.first <= best + 1e-12) {
      nbest++;
      vector<vector<pair<int,int>>> gm; for (unsigned n = 0; n < STs.size(); n++) if (pr.second[n] >= 0) gm.push_back(STs[n][pr.second[n]]);
      geoms.insert(gm);
    }
    printf("brute force: %ld assignments, optimum s*=%.12g reached by %ld assignments, %zu distinct routed geometries\n", total, best, nbest, geoms.size());
  }
  if (o.reverse_rows) { vector<Row> rr(rows.rbegin(), rows.rend()); rows = rr; }
  for (auto& r : rows) add_constraintex(lp, r.v.size(), &r.v[0], &r.c[0], r.type, r.rhs);
  static FILE* dumpf = getenv("DUMP") ? fopen(getenv("DUMP"), "a") : NULL;
  bool dodump = dumpf && o.brute == false && o.reverse_rows == false && o.floorfirst < 0 && !o.nopresolve && o.tag == 0;
  for (int i = 1; i <= N; i++) set_binary(lp, i, TRUE);
  set_bounds(lp, N + 1, 0.0, 1.0);
  double one = 1; int col = N + 1; set_obj_fnex(lp, 1, &one, &col);
  set_minim(lp); set_timeout(lp, 60);
  if (!o.nopresolve) set_presolve(lp, PRESOLVE_PROBEFIX | PRESOLVE_ROWDOMINATE, get_presolveloops(lp));
  if (o.floorfirst >= 0) set_bb_floorfirst(lp, o.floorfirst);
  *ret = solve(lp);
  { int triv = 0; for (auto& r : rows) if (r.type == LE && r.c.size() == 1) triv++;
    g_triv = triv; g_delta = lp->bb_deltaOF; g_nodes = (int)get_total_nodes(lp); g_rows_after = get_Nrows(lp); g_cols_after = get_Ncolumns(lp); g_rows = rows.size(); }
  if (o.brute) {
    int triv = 0; for (auto& r : rows) if (r.type == LE && r.c.size() == 1) triv++;
    printf("  rows=%zu (trivial cap rows=%d) bb_deltaOF=%g bb_totalnodes=%lld total_iter=%lld perturb_count=%d rows_after=%d cols_after=%d\n", rows.size(), triv, lp->bb_deltaOF, (long long)get_total_nodes(lp), (long long)get_total_iter(lp), lp->perturb_count, get_Nrows(lp), get_Ncolumns(lp));
  }
  *obj = get_objective(lp);
  *ncolafter = get_Ncolumns(lp);
  vector<double> Vars(N + 1);
  get_variables(lp, &Vars[0]);
  if (dodump) {
    fprintf(dumpf, "{\"N\":%d,\"rows\":[", N);
    for (unsigned k = 0; k < rows.size(); k++) {
      fprintf(dumpf, "%s[%d,%.17g,[", k ? "," : "", rows[k].type, rows[k].rhs);
      for (unsigned q = 0; q < rows[k].c.size(); q++) fprintf(dumpf, "%s[%d,%.17g]", q ? "," : "", rows[k].c[q], rows[k].v[q]);
      fprintf(dumpf, "]]");
    }
    fprintf(dumpf, "],\"ret\":%d,\"obj\":%.17g,\"vars\":[", *ret, get_objective(lp));
    for (int q = 0; q <= N; q++) fprintf(dumpf, "%s%.17g", q ? "," : "", Vars[q]);
    fprintf(dumpf, "]}\n");
    fflush(dumpf);
  }
  vector<int> pick(STs.size(), 0);
  for (int i = 0; i < N; i++) if (Vars[i] == 1) pick[val[i].first] = val[i].second;
  delete_lp(lp);
  return pick;
}

int run(unsigned seed, int nnets, bool quiet);
int main(int argc, char** argv) {
  if (argc > 3) {  // batch: seeds [a,b) with nnets
    int a = atoi(argv[1]), b = atoi(argv[3]), n = atoi(argv[2]);
    for (int s = a; s < b; s++) run(s, n, true);
    return 0;
  }
  return run(argc > 1 ? atoi(argv[1]) : 1, argc > 2 ? atoi(argv[2]) : 6, false);
}
int run(unsigned seed, int nnets, bool quiet) {
  srand(seed);
  lprec* t = make_lp(0, 1);
  if (seed == 1 && !quiet) {
    printf("defaults after make_lp: floorfirst=%d bb_rule=%d scaling=%d improve=%d epsint=%g mip_gap_abs=%g mip_gap_rel=%g pivoting=%d simplextype=%d depthlimit=%d anti_degen=%d presolve=%d maxpivot=%d epsel=%g\n",
           get_bb_floorfirst(t), get_bb_rule(t), get_scaling(t), get_improve(t), get_epsint(t), get_mip_gap(t, TRUE), get_mip_gap(t, FALSE), get_pivoting(t),
           get_simplextype(t), get_bb_depthlimit(t), get_anti_degen(t), get_presolve(t), get_maxpivot(t), get_epsel(t));
  }
  delete_lp(t);
  // 1 column x 2 rows x 5 layers (M1..M5) like a ~1.5um x 12um module with tile_size=100
  int W = 2984, H = 23688, xu = 16000, yu = 16800;
  vector<Tile> T;
  int gux[5] = {160, -1, 160, -1, 288}, guy[5] = {-1, 168, -1, 168, -1};
  for (int k = 0; k < 5; k++)
    for (int X = 0; X < W; X += xu) {
      int w = X + xu > W ? W - X : xu;
      for (int Y = 0; Y < H; Y += yu) {
        int h = Y + yu > H ? H - Y : yu;
        Tile tl; tl.x = X + w / 2; tl.y = Y + h / 2; tl.metal = k; T.push_back(tl);
      }
    }
  // planar N/S edges on vertical layers only (single column => no E/W edges)
  for (int k = 0; k < 5; k += 2) {
    int a = 2 * k, b = 2 * k + 1;
    int cap = W / gux[k];
    int red = rand() % (cap / 2);  // pretend obstacles
    cap = (int)(cap - red * 1.5); if (cap < 1) cap = 1;
    T[a].north.push_back({b, cap}); T[b].south.push_back({a, cap});
  }
  for (int k = 0; k < 4; k++) for (int y = 0; y < 2; y++) {
    int a = 2 * k + y, b = 2 * (k + 1) + y;
    T[a].up.push_back({b, 1000}); T[b].down.push_back({a, 1000});
  }
  GG g;
  vector<vector<vector<pair<int, int>>>> STs;
  for (int n = 0; n < nnets; n++) {
    int ng = 2 + rand() % 2;
    vector<vector<int>> groups;
    for (int q = 0; q < ng; q++) { int layer = rand() % 2; int row = rand() % 2; groups.push_back({2 * layer + row}); }
    set<int> terms; for (auto& gp : groups) for (int x : gp) terms.insert(x);
    // potential steiner nodes = terminal tiles sharing x or y with another terminal (see report)
    vector<int> cand;
    for (int a : terms) for (int b : terms) if (a != b && (T[a].x == T[b].x || T[a].y == T[b].y)) { cand.push_back(a); break; }
    g.build(T);
    g.Path.clear();
    g.Pin_terminals = groups;
    g.FindSTs(5, cand);
    STs.push_back(g.Path);
  }
  if (quiet) {
    double obj; int nc, ret; Opts o;
    auto p = solveILP(STs, g, o, &obj, &nc, &ret);
    // reversed ST order inside each net (a column permutation), mapped back
    vector<vector<vector<pair<int,int>>>> R = STs; for (auto& v : R) reverse(v.begin(), v.end());
    Opts oq; oq.tag = 1; double obj2; int nc2, ret2; auto q = solveILP(R, g, oq, &obj2, &nc2, &ret2);
    for (unsigned n = 0; n < q.size(); n++) q[n] = STs[n].empty() ? 0 : (int)STs[n].size() - 1 - q[n];
    int diffgeom = 0; for (unsigned n = 0; n < p.size(); n++) if (!STs[n].empty() && STs[n][p[n]] != STs[n][q[n]]) diffgeom++;
    printf("seed %u ret %d obj %.17g pick", seed, ret, obj); for (int x : p) printf(" %d", x);
    printf(" | colperm obj %.17g nets_with_different_geometry %d | triv %d deltaOF %g nodes %d rows %d->%d cols %d\n", obj2, diffgeom, g_triv, g_delta, g_nodes, g_rows, g_rows_after, g_cols_after);
    return 0;
  }
  printf("seed %u nets %d\n", seed, nnets);
  for (unsigned n = 0; n < STs.size(); n++) {
    printf(" net %u:", n);
    for (auto& p : STs[n]) { printf(" ["); for (auto& e : p) printf("%d-%d ", e.first, e.second); printf("]"); }
    printf("\n");
  }
  double obj; int nc, ret;
  Opts o; o.brute = true;
  auto p0 = solveILP(STs, g, o, &obj, &nc, &ret);
  printf("lp_solve default: ret=%d obj=%.12g ncols_after=%d pick:", ret, obj, nc);
  for (int x : p0) printf(" %d", x);
  printf("\n");
  Opts o2; o2.reverse_rows = true;
  auto p1 = solveILP(STs, g, o2, &obj, &nc, &ret);
  printf("rows reversed   : ret=%d obj=%.12g pick:", ret, obj);
  for (int x : p1) printf(" %d", x);
  printf("\n");
  Opts o3; o3.floorfirst = BRANCH_CEILING;
  auto p2 = solveILP(STs, g, o3, &obj, &nc, &ret);
  printf("floor=CEILING   : ret=%d obj=%.12g pick:", ret, obj);
  for (int x : p2) printf(" %d", x);
  printf("\n");
  Opts o4; o4.nopresolve = true;
  auto p3 = solveILP(STs, g, o4, &obj, &nc, &ret);
  printf("no presolve     : ret=%d obj=%.12g pick:", ret, obj);
  for (int x : p3) printf(" %d", x);
  printf("\n");
  // distinct-geometry check: how many distinct global paths among optimal picks?
  return 0;
}
