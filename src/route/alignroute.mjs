/** alignroute.wasm — ALIGN 배선기(RouteWork 4·5·2·3)를 Rust 로 그대로 옮긴 것 — 를 부른다.
 *
 *  const router = await loadAlignRouter(bytes);
 *  const out = router.route(job);   // job: {drc, node, modes, signal, powerGrid, powerRouting, skip}
 *    -> { records: [{module, mode, ms, out}], warnings }   (symplace/alignroute/src/route.rs)
 *
 *  wasm32-wasip1 로 빌드된다 (lp_solve 가 C 라이브러리를 쓴다). 파일도 환경도 없으니 WASI 는
 *  흉내만 낸다: 파일은 EBADF, 출력은 버린다, 시각은 0. 배선 결과에는 닿지 않는다.
 *  wasm 이 죽으면(trap) 인스턴스를 새로 만들고 오류를 올린다.
 */
const EBADF = 8, ENOSYS = 52;

export async function loadAlignRouter(bytes) {
  const mod = await WebAssembly.compile(bytes);
  let inst = null, mem = null;
  const dv = () => new DataView(mem.buffer);
  const wasi = {
    environ_sizes_get: (c, s) => { dv().setUint32(c, 0, true); dv().setUint32(s, 0, true); return 0; },
    environ_get: () => 0,
    args_sizes_get: (c, s) => { dv().setUint32(c, 0, true); dv().setUint32(s, 0, true); return 0; },
    args_get: () => 0,
    clock_time_get: (id, prec, out) => { dv().setBigUint64(out, 0n, true); return 0; },
    fd_prestat_get: () => EBADF,
    fd_write: (fd, iov, n, out) => {
      let t = 0;
      for (let k = 0; k < n; k++) t += dv().getUint32(iov + 8 * k + 4, true);
      dv().setUint32(out, t, true);
      return 0;
    },
    proc_exit: (c) => { throw new Error(`alignroute: proc_exit(${c})`); },
  };
  const imports = { alignroute: { now_ms: () => performance.now() } };
  for (const i of WebAssembly.Module.imports(mod)) {
    if (i.module === "alignroute") continue;
    imports[i.module] ??= {};
    imports[i.module][i.name] = wasi[i.name] ??
      (() => (/^(fd_|path_)/.test(i.name) ? EBADF : ENOSYS));
  }
  const fresh = async () => {
    inst = await WebAssembly.instantiate(mod, imports);
    mem = inst.exports.memory;
    inst.exports._initialize?.();
  };
  await fresh();
  const enc = new TextEncoder(), dec = new TextDecoder();

  return {
    /** 모듈 하나를 배선한다. job 은 JSON 으로 넘긴다 (f64 는 가장 짧은 표기 -> Rust 가 같은 비트로 읽는다). */
    async route(job) {
      const text = enc.encode(JSON.stringify(job));
      let res;
      try {
        const e = inst.exports;
        const p = e.alloc(text.length);
        new Uint8Array(mem.buffer, p, text.length).set(text);
        const q = e.route_json(p, text.length);
        const n = e.out_len();
        res = JSON.parse(dec.decode(new Uint8Array(mem.buffer, q, n)));
        e.dealloc(p, text.length);
      } catch (err) {
        await fresh();     // 죽은 인스턴스는 버린다
        throw new Error(`alignroute 가 죽었다 (${job?.node?.name ?? "?"}): ${err.message}`);
      }
      if (res.error) throw new Error(`alignroute: ${res.error}`);
      return res;
    },
  };
}
