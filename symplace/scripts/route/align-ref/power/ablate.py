import os, sys, io, contextlib
sys.path.insert(0, os.path.dirname(__file__))
import pg_proto as PG, pr_proto as PR, pr_check
root = os.path.expanduser('~/.cache/symplace/tap')
cases = [(ex, var) for ex in sorted(os.listdir(root)) for var in ('align', 'ours')]
tests = [('baseline', None, None)] + [(k, PR.FLAGS, k) for k in PR.FLAGS] + [('cr_bug', PG.FLAGS, 'cr_bug')]
for name, flags, key in tests:
    if flags is not None:
        flags[key] = False
    fails = []
    for ex, var in cases:
        try:
            ok, s = pr_check.run(ex, var)
        except Exception as e:
            ok = False
        if not ok:
            fails.append(f'{ex}/{var}')
    if flags is not None:
        flags[key] = True
    print(f'{name:16s} failing cases {len(fails)}/10 {fails}', flush=True)
