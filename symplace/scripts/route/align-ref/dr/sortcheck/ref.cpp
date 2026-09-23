// libc++ 18 std::sort 기준: 사례마다 정렬한 뒤의 원소 번호 (벡터 전체), 벡터 밖(가드)을 건드리면 "UB".
// 입력: T, 그리고 사례마다 n first kind, (key special) * n
// kind 1: key <, 2: 특수면 참 (SortPinsOrder 첫 정렬꼴), 3: 번호 쌍의 해시 (아무렇게나 어긋남),
//      4: 앞쪽 [0, first) 와의 가장 가까운 거리 (SortPinsOrder 둘째 정렬꼴 — 지금 벡터를 읽는다)
// 배열은 mmap 한 곳에 두고 양쪽에 가드 원소와 PROT_NONE 쪽을 둔다. 쪽을 넘으면 SIGSEGV 를 잡아 "UB".
#include <sys/mman.h>
#include <unistd.h>

#include <algorithm>
#include <climits>
#include <csetjmp>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>

struct E {
  int key, special, id;
};
static E *arr;
static int nfirst, kind, touched;
static long calls;
static sigjmp_buf jb;

static void onsegv(int) { siglongjmp(jb, 1); }

static inline unsigned h(unsigned a, unsigned b) {
  unsigned x = a * 2654435761u ^ (b + 0x9e3779b9u + (a << 6) + (a >> 2));
  x ^= x >> 13;
  x *= 0x5bd1e995u;
  x ^= x >> 15;
  return x;
}

struct Cmp {
  bool operator()(const E &a, const E &b) const {
    if (++calls > 20000000) siglongjmp(jb, 2);
    if (a.id < 0 || b.id < 0) touched = 1;
    switch (kind) {
      case 1:
        return a.key < b.key;
      case 2:
        if (a.special || b.special) return true;
        return a.key < b.key;
      case 3:
        return h((unsigned)a.id, (unsigned)b.id) & 1;
      case 4: {
        if (a.special || b.special) return true;
        int da = INT_MAX, db = INT_MAX;
        bool any = false;
        for (int k = 0; k < nfirst; k++) {
          const E &p = arr[k];
          if (p.id < 0) touched = 1;
          if (p.special) continue;
          any = true;
          da = std::min(da, abs(a.key - p.key));
          db = std::min(db, abs(b.key - p.key));
        }
        if (!any) return true;
        return da < db;
      }
    }
    return false;
  }
};

int main() {
  int T;
  if (scanf("%d", &T) != 1) return 1;
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = onsegv;
  sa.sa_flags = SA_NODEFER;
  sigaction(SIGSEGV, &sa, nullptr);
  sigaction(SIGBUS, &sa, nullptr);
  const long PG = sysconf(_SC_PAGESIZE);
  const int G = 4096;  // 가드 원소
  while (T--) {
    int n, first;
    if (scanf("%d %d %d", &n, &first, &kind) != 3) return 1;
    std::vector<E> in(n);
    for (int i = 0; i < n; i++) {
      int k, s;
      if (scanf("%d %d", &k, &s) != 2) return 1;
      in[i] = {k, s, i};
    }
    size_t bytes = (size_t)(n + 2 * G) * sizeof(E);
    size_t body = (bytes + PG - 1) / PG * PG;
    char *m = (char *)mmap(nullptr, body + 2 * PG, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    mprotect(m, PG, PROT_NONE);
    mprotect(m + PG + body, PG, PROT_NONE);
    E *buf = (E *)(m + PG);
    for (int i = 0; i < G; i++) {
      buf[i] = {0, 0, -1};
      buf[G + n + i] = {0, 0, -1};
    }
    for (int i = 0; i < n; i++) buf[G + i] = in[i];
    arr = &buf[G];
    nfirst = first;
    touched = 0;
    calls = 0;
    int r = sigsetjmp(jb, 1);
    if (r == 0) std::sort(arr + first, arr + n, Cmp());
    bool mod = false;
    for (int i = 0; i < G; i++)
      if (buf[i].id != -1 || buf[G + n + i].id != -1) mod = true;
    if (r != 0 || touched || mod) {
      printf("UB\n");
    } else {
      for (int i = 0; i < n; i++) printf("%d ", arr[i].id);
      printf("\n");
    }
    munmap(m, body + 2 * PG);
  }
  return 0;
}
