/**
 * The in-sandbox side of the kernel: the `durable-isolates:internal` module
 * source compiled into every prefix, and the one bridge-global it calls.
 *
 * The module exposes the durable primitives — `durableCall` (host-backed work),
 * `durableLookup`/`durableCommit` (the sandbox-side checkpoint protocol) — plus
 * the `boundary(key, fn)` sugar and the ambient `nextKey` former built on them.
 * Keys are formed IN THE SANDBOX and carried over the wire; the host never
 * mints them. There is no in-sandbox memoization state that survives a run: the
 * cache always lives host-side, reached through the bridge, and every replay
 * re-derives the same keys by re-executing the same code.
 */

/**
 * Shape of the host bridge global — declared at precompile, rebound per run.
 */
export type BridgeGlobals = Record<string, (...args: unknown[]) => unknown>

/**
 * Virtual specifier of the shim-facing module. Shims `import` from this.
 */
export const INTERNAL_SPECIFIER = 'durable-isolates:internal'

/**
 * The single bridge-global every primitive reaches, multiplexed on its first
 * argument (`'call' | 'lookup' | 'commit'`). Rebound per `execute`.
 */
export const DURABLE_CALL_GLOBAL = '__di_call'

/**
 * Source of the `durable-isolates:internal` module.
 *
 * `durableCall(key, name, ...args)` — the host-backed durable primitive. The
 * host answers the boundary keyed by `key` from the cache, or forwards ALL
 * `args` to the mounted handler `name`. The bridge always RESOLVES with an
 * `{ ok, value } | { ok: false, error }` envelope (never rejects — a rejecting
 * host bridge poisons the whole run), which the shim unwraps: returns the
 * value, or throws a reconstructed error (catchable, non-poisoning, with name /
 * stack / data preserved since it crossed the bridge as data). On suspension
 * the host aborts the run, so the returned promise never resolves.
 *
 * `durableLookup(key)` — non-memoized read of the live cache: `{hit, value?}`.
 * `durableCommit(key, value)` — record a completed boundary from the sandbox.
 * `boundary(key, fn)` — checkpoint sugar: hit → cached value without running
 * `fn`; miss → run `fn`, commit, return. Nestable via the ambient prefix stack
 * (keys concatenate with `/`); bodies containing further durable work re-run on
 * every replay until committed, so scopes must run sequentially.
 * `nextKey(name)` — ambient auto-key former for shims: current prefix + name +
 * a per-scope-per-name counter (plain module state, reset every replay).
 */
export const internalShim: string = /* js */ `
function __di_reconstruct(e) {
  const err = new Error(e && e.message != null ? e.message : String(e));
  if (e && e.name) err.name = e.name;
  if (e && e.stack) err.stack = e.stack;
  if (e && 'data' in e && e.data !== undefined) err.data = e.data;
  return err;
}

const __di_prefix = [];
const __di_counters = Object.create(null);

export async function durableCall(key, name, ...args) {
  const r = await globalThis.${DURABLE_CALL_GLOBAL}('call', String(key), String(name), args);
  if (r && r.ok) return r.value;
  throw __di_reconstruct(r ? r.error : { message: 'durable-isolates: malformed durableCall result' });
}

export async function durableLookup(key) {
  return await globalThis.${DURABLE_CALL_GLOBAL}('lookup', String(key));
}

export async function durableCommit(key, value) {
  await globalThis.${DURABLE_CALL_GLOBAL}('commit', String(key), value);
}

export function nextKey(name) {
  const scoped = [...__di_prefix, String(name)].join('/');
  const n = __di_counters[scoped] = (__di_counters[scoped] || 0) + 1;
  return scoped + '#' + (n - 1);
}

export async function boundary(key, fn) {
  const full = [...__di_prefix, String(key)].join('/');
  const r = await durableLookup(full);
  if (r && r.hit) return r.value;
  __di_prefix.push(String(key));
  try {
    const value = await fn();
    await durableCommit(full, value);
    return value;
  } finally {
    __di_prefix.pop();
  }
}
`
