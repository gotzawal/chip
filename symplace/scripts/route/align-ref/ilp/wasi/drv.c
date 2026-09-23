/* lps 한 줄씩: N nrows / typ rhs n (col val)* ... -> ALIGN ILPSolveRouting 과 같은 호출 순서로 푼다 */
#include <stdio.h>
#include <stdlib.h>
#include "lp_lib.h"
int main(void) {
  int N, nr;
  while (scanf("%d %d", &N, &nr) == 2) {
    lprec *lp = make_lp(0, N + 1);
    set_verbose(lp, 3);
    set_outputfile(lp, "/dev/null");
    for (int r = 0; r < nr; r++) {
      int typ, n; double rhs;
      scanf("%d %lf %d", &typ, &rhs, &n);
      int *cols = malloc(sizeof(int) * (n ? n : 1)); double *vals = malloc(sizeof(double) * (n ? n : 1));
      for (int k = 0; k < n; k++) scanf("%d %lf", &cols[k], &vals[k]);
      add_constraintex(lp, n, vals, cols, typ, rhs);
      free(cols); free(vals);
    }
    for (int i = 1; i <= N; i++) set_binary(lp, i, TRUE);
    set_bounds(lp, N + 1, 0.0, 1.0);
    double one = 1.0; int col = N + 1;
    set_obj_fnex(lp, 1, &one, &col);
    set_minim(lp);
    set_timeout(lp, 60);
    set_presolve(lp, PRESOLVE_PROBEFIX | PRESOLVE_ROWDOMINATE, get_presolveloops(lp));
    int ret = solve(lp);
    double *v = malloc(sizeof(double) * (N + 1));
    get_variables(lp, v);
    printf("%d %.17g", ret, get_objective(lp));
    for (int i = 0; i <= N; i++) printf(" %.17g", v[i]);
    printf("\n");
    free(v);
    delete_lp(lp);
  }
  return 0;
}
