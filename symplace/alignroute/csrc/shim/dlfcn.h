/* wasm 에는 dlopen 이 없다. lp_solve 가 외부 BLAS 적재에 실패하고 내장 BLAS 를 쓰게 한다 (기준 휠과 같은 길). */
#ifndef SHIM_DLFCN_H
#define SHIM_DLFCN_H
#define RTLD_LAZY 1
#define RTLD_NOW 2
#define RTLD_GLOBAL 0x100
static inline void *dlopen(const char *f, int m) { (void)f; (void)m; return 0; }
static inline void *dlsym(void *h, const char *s) { (void)h; (void)s; return 0; }
static inline int dlclose(void *h) { (void)h; return 0; }
static inline char *dlerror(void) { return 0; }
#endif
