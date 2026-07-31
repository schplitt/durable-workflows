/**
 * durable-isolates — the replay kernel's public type surface.
 *
 * The model: mount in-sandbox SHIMS plus host GLOBALS. A shim forms a `key` in
 * the sandbox and calls `durableCall(key, name, ...args)` (from
 * `durable-isolates:internal`); the kernel answers that boundary from the cache
 * when `key` is recorded (never re-executed), dispatches the `name` global on a
 * miss, and lets a global suspend the whole run by throwing `SuspendIsolate`.
 * Sandbox-side checkpoints (`boundary(key, fn)` over `durableLookup`/
 * `durableCommit`) memoize in-sandbox work the same way. Everything the caller
 * must remember comes back as the grown cache, and resume is always the same
 * move: run it again.
 *
 * The kernel owns no store, no scheduler, no instances, no id policy. The
 * CALLER owns storage (persist `cache`, hand it back next turn), retry/eviction
 * (cache surgery), and reacting to `pending` operations. Keys are always formed
 * sandbox-side and carried over the wire — the kernel is a memoize-by-key
 * router. Determinism is a documented contract (deterministic keys, no
 * time/randomness in branches), not an enforced one: a key miss simply runs.
 */
import type { ResourceLimits, SandboxOptions } from '@iso4/sandbox'

// ─────────────────────────────────────────────────────────────────────────────
// Host — owns the one iso4 sandbox (Rust bind + isolate pool)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bind ONE iso4 sandbox — a single connection to the Rust core holding the
 * `maxIsolates` pool that budgets every concurrent run across every prefix
 * hydrated on it. Created lazily on the first `hydrate`, reused thereafter;
 * `dispose()` tears it (and all its prefixes) down.
 */
export type CreateDurableIsolates = (options?: DurableIsolatesOptions) => DurableIsolates

export interface DurableIsolatesOptions {
  /**
   * iso4 sandbox options — the one Rust bind and its `maxIsolates` pool.
   * Resource LIMITS are not set here: they are per-run execution caps,
   * configured on `hydrate` (default) and `execute` (override).
   */
  sandbox?: SandboxOptions
}

export interface DurableIsolates {
  /**
   * Hydrate a prefix from a set of mounted modules — precompiles their shims
   * (plus `durable-isolates:internal`) into a V8 startup snapshot. Many prefixes
   * share the one sandbox and its isolate pool.
   */
  hydrate: (options: HydrateOptions) => Promise<DurableIsolatesRunner>
  /**
   * Tear down the sandbox and every prefix hydrated on it.
   */
  dispose: () => Promise<void>
}

export interface HydrateOptions {
  /**
   * The mounted modules. Keys ARE the virtual module specifiers — the mount
   * points in-sandbox code imports (e.g. `import { request } from 'cumulocity'`).
   */
  modules: Readonly<Record<string, ModuleDefinition>>
  /**
   * Default iso4 resource limits for every `execute` on this prefix;
   * `ExecuteOptions.limits` overrides per run. Replay is bridge-call heavy (a
   * completed boundary still round-trips through the cache lookup), so
   * `maxBridgeCalls` defaults to 1000 (iso4's own default of 10 is far too low).
   */
  limits?: Partial<ResourceLimits>
}

/**
 * One mounted module: an in-sandbox shim plus its default host globals.
 */
export interface ModuleDefinition {
  /**
   * In-sandbox ESM source compiled into the prefix, exposing this module's
   * public API. It forms a deterministic `key` in the sandbox (its own scheme,
   * or `nextKey` from `durable-isolates:internal`) and calls
   * `durableCall(key, name, ...args)` for each durable operation. Non-durable
   * work just calls a plain iso4 global.
   */
  shim: string
  /**
   * Default host globals, keyed by the `name` the shim routes to. OPTIONAL:
   * globals whose per-instance state (e.g. auth) is captured per run can be
   * supplied via `ExecuteOptions.globals` instead. Effective global = the
   * per-execute override falling back to this default; a `name` with neither
   * fails that call.
   */
  globals?: GlobalMap
}

// ─────────────────────────────────────────────────────────────────────────────
// Globals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A host-side global for one operation `name`. The kernel invokes it only when
 * the call's `key` is not already completed/failed in the cache, so globals
 * never see replay of a settled boundary. A `waiting` boundary IS re-dispatched
 * (that is the resume path): the global consults host/app state and either
 * proceeds this time, suspends again, or throws. It receives ALL the args the
 * shim's `durableCall` forwarded (V8-serialized across the bridge).
 *
 * It does one of:
 * - returns a value → completed boundary; the sandbox `await` resolves;
 * - throws `SuspendIsolate` → the run suspends (waiting boundary + abort);
 * - throws anything else → failed boundary, re-thrown deterministically on replay.
 */
export type HostGlobal = (...args: unknown[]) => unknown

/**
 * Host globals keyed by the operation `name` the shim routes to.
 */
export type GlobalMap = Readonly<Record<string, HostGlobal>>

/**
 * Per-`execute` global overrides, keyed by operation `name`. Rebinds the host
 * global for THIS run (the credentials story: fresh globals per run, auth in
 * their closure — including any approval/consent answers the global consults
 * on re-dispatch). Omitted names reuse the module's default global.
 */
export type PerExecuteGlobals = Readonly<Record<string, HostGlobal>>

// ─────────────────────────────────────────────────────────────────────────────
// Runner — a hydrated prefix; one replay turn per execute
// ─────────────────────────────────────────────────────────────────────────────

export interface DurableIsolatesRunner {
  /**
   * One replay turn — a (nearly) pure function over the cache. Re-runs `code`
   * from the top in a fresh isolate: a boundary answers from `cache` when its
   * key is recorded, else runs for real; a global throwing `SuspendIsolate`
   * aborts the run (suspension is host-decided and uncatchable in-sandbox).
   * Returns the outcome plus the grown cache — the caller persists `cache` and
   * hands it back next turn. The returned handle carries the `result` promise
   * and `suspend()` for external teardown.
   */
  execute: (options: ExecuteOptions) => ExecuteHandle
  /**
   * Release this prefix's snapshot. The sandbox stays up for other prefixes;
   * `DurableIsolates.dispose()` tears down the sandbox itself.
   */
  dispose: () => Promise<void>
}

export interface ExecuteOptions {
  /**
   * ESM source — the SAME source on every replay. Keys are formed
   * deterministically in the shim; determinism is the documented contract
   * (deterministic keys and branches). A changed path just misses the cache and
   * runs — the kernel does not police it.
   */
  code: string
  /**
   * History; `{}` on the first run. The CALLER owns storage — pass whatever was
   * persisted (or kept in memory) from the previous turn's `cache`.
   */
  cache: BoundaryCache
  /**
   * Rebind host globals for this run (auth and approval answers captured in
   * closure), keyed by operation `name`. Omitted names reuse the module default.
   */
  globals?: PerExecuteGlobals
  /**
   * iso4 resource limits for this run, overriding the prefix's `hydrate`
   * default.
   */
  limits?: Partial<ResourceLimits>
}

/**
 * The in-flight run: the result promise plus external suspension.
 */
export interface ExecuteHandle {
  /**
   * The run's outcome — resolves when the turn completes, suspends, or fails.
   */
  result: Promise<ExecuteResult>
  /**
   * Suspend the run from OUTSIDE (server teardown): aborts the isolate (CPU
   * work since the last boundary is disposable — replay redoes it), lets every
   * in-flight global dispatch FINISH and be recorded (the IO is not wasted;
   * replay fast-paths it), then resolves with `{outcome: 'suspended', ... }` —
   * the same shape as a global suspension, with possibly-empty `pending`.
   * Await it in the shutdown path, persist `cache`, and re-execute later. A
   * no-op resolving the settled result when the run already finished.
   */
  suspend: () => Promise<ExecuteResult>
}

// ─────────────────────────────────────────────────────────────────────────────
// Result
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Discriminated on `outcome`. The grown cache always comes back as `cache`;
 * the payload beyond that is outcome-specific.
 */
export type ExecuteResult
  = | CompletedResult
    | SuspendedResult
    | FailedResult

interface ExecuteResultBase {
  /**
   * The grown cache — the caller persists it (or keeps it in memory) and hands
   * it back as the next `execute`'s `cache`.
   */
  cache: BoundaryCache
}

export interface CompletedResult extends ExecuteResultBase {
  outcome: 'completed'
  /**
   * The module's `export default` value.
   */
  result: unknown
}

export interface SuspendedResult extends ExecuteResultBase {
  outcome: 'suspended'
  /**
   * Boundaries awaiting the outside world — one per waiting record written this
   * run (empty when the run was suspended externally via `handle.suspend()`).
   * The caller reacts (elicit, notify, wait) and resumes by re-executing with
   * the grown cache: the waiting boundary re-dispatches and its global,
   * consulting host state, proceeds, suspends again, or throws.
   */
  pending: PendingOperation[]
}

export interface FailedResult extends ExecuteResultBase {
  outcome: 'failed'
  /**
   * The failure — a user error (iso4 `RunError`: `code`/`name`/`message`/
   * `stack`/`fields`) or a resource-limit breach. Typed `unknown`: the kernel
   * does not model a shape; the caller inspects it at its own risk.
   */
  error: unknown
}

/**
 * A dispatched-but-unanswered operation, handed outward on suspension. `id` is
 * the boundary's cache key, `name` the operation that suspended, `payload` what
 * the global passed to `SuspendIsolate`.
 */
export interface PendingOperation {
  id: string
  name: string
  payload: unknown
}

// ─────────────────────────────────────────────────────────────────────────────
// The cache
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The durable history: one record per boundary, keyed by the boundary id (the
 * sandbox-formed key). Matching is by id only — the kernel never matches by
 * position. Plain JSON data; the caller persists it however it likes.
 */
export type BoundaryCache = Record<string, BoundaryRecord>

/**
 * One recorded boundary. `seq` is history order (stamped at dispatch/commit
 * time) — eviction surgery ("this and everything after") and timelines only,
 * NEVER matching. Retry and eviction are the caller's cache surgery: delete a
 * failed entry to re-execute that boundary; delete by `seq` suffix to evict a
 * boundary and everything recorded after it.
 */
export type BoundaryRecord
  = | CompletedBoundary
    | FailedBoundary
    | WaitingBoundary

interface BoundaryRecordBase {
  /**
   * History order — eviction and timeline only, never matching.
   */
  seq: number
}

export interface CompletedBoundary extends BoundaryRecordBase {
  status: 'completed'
  value: unknown
}

export interface FailedBoundary extends BoundaryRecordBase {
  status: 'failed'
  /**
   * The value the global threw, recorded verbatim. Re-thrown into the sandbox
   * on replay via the durable envelope; iso4's bridge serialization carries it
   * faithfully (name/message/stack + own fields).
   */
  error: unknown
}

/**
 * A boundary whose global suspended. NOT terminal: re-executing the same cache
 * re-dispatches it — that is the one resume path. Values only ever enter the
 * cache through a live dispatch or an explicit in-sandbox commit; there is no
 * way to inject a result from outside.
 */
export interface WaitingBoundary extends BoundaryRecordBase {
  status: 'waiting'
  /**
   * The operation that suspended.
   */
  name: string
}
