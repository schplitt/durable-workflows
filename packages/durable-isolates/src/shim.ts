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
 * Shape of the host bridge global — declared at prepare, rebound per run.
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
 * The kernel's bridge-global names as they appear in iso4's `bridgeCalls` —
 * for telling the kernel's own entries apart from other globals'.
 */
export const KERNEL_BRIDGE_GLOBALS: readonly [typeof DURABLE_CALL_GLOBAL, typeof DURABLE_LOOKUP_GLOBAL, typeof DURABLE_COMMIT_GLOBAL]
  = [DURABLE_CALL_GLOBAL, DURABLE_LOOKUP_GLOBAL, DURABLE_COMMIT_GLOBAL]

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
 * `durableCommit(key, value)` — record a completed boundary from the sandbox;
 * resolves with the value AS RECORDED (as it reads back from JSON), which is
 * what `boundary()` returns, so the first run sees what every replay sees.
 *
 * Args and committed values leave the sandbox as JSON TEXT, written here with
 * `JSON.stringify` on the program's real object; the host parses it. A value
 * JSON refuses (a bigint, a cycle) crosses as the serializer's message and the
 * host rejects the run.
 * `boundary(key, fn)` — checkpoint sugar: hit → cached value without running
 * `fn`; miss → run `fn`, commit, return. Nestable: `key` joins the ambient
 * scope while `fn` runs, so inner keys concatenate with `/`. The scope is
 * carried through iso4's `AsyncLocalStorage`, so it survives `await`
 * and stays isolated per branch under `Promise.all` — nested boundaries may run
 * sequentially OR in parallel and still key deterministically. Bodies containing
 * further durable work re-run on every replay until committed.
 * Every durable call and every `boundary()` also takes an ISSUE POSITION — a
 * counter per ambient scope, incremented synchronously at issue (source order
 * for operations issued in one synchronous stretch; a boundary body counts in
 * its own scope, so a cache hit on the boundary skips the whole subtree
 * consistently) — recorded as `scope` + `order` and compared on replay, so a
 * program whose operations no longer come in the recorded order diverges even
 * when each key still matches. Raw `durableLookup`/`durableCommit` take no
 * position (the position argument is internal to `boundary()`).
 * `nextKey(name)` — ambient auto-key former for shims: current scope + name +
 * a per-scope-per-name counter. The scope comes from the async-context store;
 * the counter is plain module state keyed by the full scoped path (distinct per
 * scope, so parallel scopes never share one) and resets every replay.
 *
 * `AsyncLocalStorage` is imported from `node:async_hooks` — available to run
 * (postfix) code, which is where these functions execute; constructing the
 * store at module scope and calling `run`/`getStore` at dispatch time is fine
 * for a prepared import. Only `run`/`getStore` are used (iso4's supported subset).
 */
export const internalShim: string = /* js */ `
import { AsyncLocalStorage } from 'node:async_hooks';

const __di_als = new AsyncLocalStorage();
const __di_counters = Object.create(null);
const __di_scope = () => __di_als.getStore() ?? [];

// Values leave the sandbox as JSON text, written here on the program's real
// object (the bridge's own serialization would strip prototypes and ignore
// toJSON). What JSON refuses (a bigint, a cycle, a toJSON/getter that throws)
// crosses as the serializer's complaint instead, and the host rejects the run.
// The intrinsics are captured at module load so program code cannot swap them.
const __di_stringify = JSON.stringify;
const __di_parse = JSON.parse;
const __di_String = String;
const __di_text = (value) => {
  try {
    return { text: __di_stringify(value) };
  } catch (e) {
    let detail;
    try {
      detail = __di_String(e !== null && e !== undefined && e.message !== undefined ? e.message : e);
    } catch {
      detail = 'unserializable value';
    }
    return { invalid: detail };
  }
};

// Issue position: a counter PER SCOPE (the ambient boundary path) over every
// durable call and checkpoint issued in that scope, taken synchronously at
// issue — so it follows source order even under Promise.all. A boundary body
// counts in its own scope, so a replay that answers the boundary from the
// cache (and never runs the body) leaves the parent's count untouched, and
// parallel bodies never interleave each other's numbering. Recorded as
// \`scope\` + \`order\` and compared on replay: an operation at a different
// position than recorded is a divergence.
const __di_issued = Object.create(null);
const __di_position = () => {
  const scope = __di_scope().join('/');
  const n = __di_issued[scope] = (__di_issued[scope] || 0) + 1;
  return { scope, order: n - 1 };
};

export async function durableCall(key, name, ...args) {
  const p = __di_position();
  const t = __di_text(args);
  return await globalThis.${DURABLE_CALL_GLOBAL}(String(key), String(name), t.text, t.invalid, p.order, p.scope);
}

export async function durableLookup(key, position) {
  return await globalThis.${DURABLE_LOOKUP_GLOBAL}(String(key), position && position.order, position && position.scope);
}

// A raw commit (no position) is outside the position check, like a raw lookup;
// only boundary() passes a position, for both halves of its checkpoint.
export async function durableCommit(key, value, position) {
  const t = __di_text(value);
  await globalThis.${DURABLE_COMMIT_GLOBAL}(String(key), t.text, t.invalid, position && position.order, position && position.scope);
  // Our own copy of the same text: what this run sees is what the cache holds.
  return t.text === undefined ? undefined : __di_parse(t.text);
}

export function nextKey(name) {
  const scoped = [...__di_scope(), String(name)].join('/');
  const n = __di_counters[scoped] = (__di_counters[scoped] || 0) + 1;
  return scoped + '#' + (n - 1);
}

export async function boundary(key, fn) {
  const parent = __di_scope();
  const full = [...parent, String(key)].join('/');
  const position = __di_position(); // the checkpoint's position in the PARENT scope: taken once, at issue
  const r = await durableLookup(full, position);
  if (r && r.hit) return r.value;
  return await __di_als.run([...parent, String(key)], async () => {
    return await durableCommit(full, await fn(), position);
  });
}
`
