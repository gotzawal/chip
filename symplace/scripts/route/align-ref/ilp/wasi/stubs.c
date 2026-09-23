/* LP 파일 읽기(lp_rlp.c, yacc_read.c)는 setjmp 가 필요해 빼고, lp_lib.c 가 부르는 이름만 둔다. ALIGN 은 안 쓴다. */
#include <stddef.h>
typedef struct _lprec lprec;
lprec *read_LP(char *f, int v, char *n) { (void)f; (void)v; (void)n; return NULL; }
lprec *read_lp(void *f, int v, char *n) { (void)f; (void)v; (void)n; return NULL; }
lprec *read_lpt(void *f, int v, char *n) { (void)f; (void)v; (void)n; return NULL; }
