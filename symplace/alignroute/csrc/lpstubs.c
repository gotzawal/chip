/* LP 파일 읽기(lp_rlp.c, yacc_read.c)는 빌드에서 뺀다 — setjmp 가 wasm 에 없고 ALIGN 은 부르지 않는다.
 * lp_lib.c 가 찾는 이름만 둔다. */
#include <stddef.h>
typedef struct _lprec lprec;
lprec *read_LP(char *f, int v, char *n) { (void)f; (void)v; (void)n; return NULL; }
lprec *read_lp(void *f, int v, char *n) { (void)f; (void)v; (void)n; return NULL; }
lprec *read_lpt(void *f, int v, char *n) { (void)f; (void)v; (void)n; return NULL; }
