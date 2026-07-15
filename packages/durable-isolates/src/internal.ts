/**
 * `durable-isolates:internal` — the shim-facing contract.
 *
 * What mounted module shims import (never end-user code). Self-contained by
 * design (imports nothing) so it can be shipped as raw text and injected as the
 * ambient module into an editor / codemode `.d.ts`, or imported normally by
 * shim authors from `durable-isolates/internal`.
 */

/**
 * The host-backed durable primitive. The shim forms `key` in the sandbox
 * (via {@link NextKey}, an input-derived string, or an author-supplied id) and
 * passes it over the wire; `name` routes to the mounted host handler; `args`
 * are forwarded to it. The host answers a cache hit by `key`, or dispatches the
 * handler; recorded/handler failures re-throw deterministically, and on
 * suspension the returned promise never resolves (the run is aborted).
 */
export type DurableCall = (key: string, name: string, ...args: unknown[]) => Promise<unknown>

/**
 * Non-memoized read of the live cache — `{hit: true, value}` for a completed
 * boundary at `key`, `{hit: false}` otherwise. Deliberately NOT a boundary
 * itself: a recorded "miss" would replay as a miss forever.
 */
export type DurableLookup = (key: string) => Promise<{ hit: true, value: unknown } | { hit: false }>

/**
 * Record a completed boundary at `key` from the sandbox ("cache this so we
 * remember after a restart"). Value-only: a failed stretch throws, stays
 * unrecorded, and re-runs on the next turn.
 */
export type DurableCommit = (key: string, value: unknown) => Promise<void>

/**
 * Checkpoint sugar over lookup/commit: on a hit return the cached value WITHOUT
 * running `fn`; on a miss run `fn` in-sandbox, commit its result, return it.
 * Nestable — `key` joins the ambient prefix while `fn` runs, so inner keys
 * concatenate (`scope/inner#0`). The prefix is carried through async context
 * (iso4 `AsyncLocalStorage`), so it survives `await` and stays isolated per
 * branch: nested scopes may run sequentially OR in parallel (`Promise.all`) and
 * still key deterministically. A body containing further durable work re-runs on
 * every replay until committed (inner boundaries fast-path from the cache).
 */
export type Boundary = <T>(key: string, fn: () => T | Promise<T>) => Promise<T>

/**
 * Ambient auto-key former for shims: current scope prefix + `name` + a
 * per-scope-per-name counter. Counters are plain sandbox module state — they
 * reset every replay, which is exactly what deterministic re-derivation wants.
 */
export type NextKey = (name: string) => string

/**
 * The `durable-isolates:internal` module surface, for typing shim source.
 */
export interface DurableIsolatesInternal {
  durableCall: DurableCall
  durableLookup: DurableLookup
  durableCommit: DurableCommit
  boundary: Boundary
  nextKey: NextKey
}
