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
 * The bridge-globals the primitives reach — one per primitive, each rebound per
 * `execute`: `durableCall` → {@link DURABLE_CALL_GLOBAL}, `durableLookup` →
 * {@link DURABLE_LOOKUP_GLOBAL}, `durableCommit` → {@link DURABLE_COMMIT_GLOBAL}.
 */
export const DURABLE_CALL_GLOBAL = '__di_call'
export const DURABLE_LOOKUP_GLOBAL = '__di_lookup'
export const DURABLE_COMMIT_GLOBAL = '__di_commit'

/**
 * Source of the `durable-isolates:internal` module.
 *
 * `durableCall(key, name, ...args)` — the host-backed durable primitive. The
 * host answers the boundary keyed by `key` from the cache, or forwards ALL
 * `args` to the mounted global `name`. The bridge resolves with the boundary's
 * value on success and REJECTS with the recorded error on failure.
 * On suspension the host aborts the run, so the returned promise never settles.
 *
 * `durableLookup(key)` — non-memoized read of the live cache: `{hit, value?}`.
 * `durableCommit(key, value)` — record a completed boundary from the sandbox.
 * `boundary(key, fn)` — checkpoint sugar: hit → cached value without running
 * `fn`; miss → run `fn`, commit, return. Nestable: `key` joins the ambient
 * scope while `fn` runs, so inner keys concatenate with `/`. The scope is
 * carried through iso4's `AsyncLocalStorage` (0.3.0+), so it survives `await`
 * and stays isolated per branch under `Promise.all` — nested boundaries may run
 * sequentially OR in parallel and still key deterministically. Bodies containing
 * further durable work re-run on every replay until committed.
 * `nextKey(name)` — ambient auto-key former for shims: current scope + name +
 * a per-scope-per-name counter. The scope comes from the async-context store;
 * the counter is plain module state keyed by the full scoped path (distinct per
 * scope, so parallel scopes never share one) and resets every replay.
 *
 * `AsyncLocalStorage` is imported from `node:async_hooks` — available to run
 * (postfix) code, which is where these functions execute; constructing the
 * store at module scope and calling `run`/`getStore` at dispatch time is fine
 * for a precompiled import. Only `run`/`getStore` are used (the 0.3.0 subset).
 */
export const internalShim: string = /* js */ `
import { AsyncLocalStorage } from 'node:async_hooks';

const __di_als = new AsyncLocalStorage();
const __di_counters = Object.create(null);
const __di_scope = () => __di_als.getStore() ?? [];

export async function durableCall(key, name, ...args) {
  return await globalThis.${DURABLE_CALL_GLOBAL}(String(key), String(name), args);
}

export async function durableLookup(key) {
  return await globalThis.${DURABLE_LOOKUP_GLOBAL}(String(key));
}

export async function durableCommit(key, value) {
  await globalThis.${DURABLE_COMMIT_GLOBAL}(String(key), value);
}

export function nextKey(name) {
  const scoped = [...__di_scope(), String(name)].join('/');
  const n = __di_counters[scoped] = (__di_counters[scoped] || 0) + 1;
  return scoped + '#' + (n - 1);
}

export async function boundary(key, fn) {
  const parent = __di_scope();
  const full = [...parent, String(key)].join('/');
  const r = await durableLookup(full);
  if (r && r.hit) return r.value;
  return await __di_als.run([...parent, String(key)], async () => {
    const value = await fn();
    await durableCommit(full, value);
    return value;
  });
}
`
