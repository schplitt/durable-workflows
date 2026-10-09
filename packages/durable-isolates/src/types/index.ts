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
 * router — and a position checker: every durable call and `boundary()` is
 * issued at a position (`scope` + `order`, counted per boundary scope in
 * source order) that is recorded and compared on replay, and a durable call at
 * a recorded key must ask the same call (`name` + `args`, compared as stable
 * JSON) the record holds. Anything else is rejected as a replay divergence. A
 * new key at a free position simply runs.
 *
 * Every value crossing a boundary is written with `JSON.stringify` and read
 * back with `JSON.parse` before anyone sees it, already on the first run, so
 * the first run sees exactly what a replay sees (a `Date` is its ISO string
 * everywhere, `undefined` in an array is `null` everywhere). What JSON cannot
 * write — a `bigint`, a circular structure, a `toJSON` or getter that throws —
 * REJECTS the run (a terminal `rejected` outcome, uncatchable in-sandbox).
 */
import type { ResourceLimits, RunError, RunFailure, RunResult, RunSuccess, Sandbox, SandboxOptions } from '@iso4/sandbox'

// ─────────────────────────────────────────────────────────────────────────────
// Host — owns the one iso4 sandbox (the Rust bind)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bind ONE iso4 sandbox — a single connection to the Rust core whose run
 * admission (the runtime's own derived concurrency, unless `maxConcurrentRuns`
 * pins it) and memory budget govern every run across every prefix prepared on
 * it. Created lazily on the first `prepare` (or `getSandbox`), reused
 * thereafter; `dispose()` tears it (and all its prefixes) down.
 */
export type CreateDurableIsolates = (options?: DurableIsolatesOptions) => DurableIsolates

export interface DurableIsolatesOptions {
  /**
   * iso4 sandbox options — the one Rust bind: `maxConcurrentRuns`,
   * `maxQueuedRuns`, `memoryBudgetMb`, `hostReserveMb`, per-isolate
   * `memoryMb`. Resource LIMITS are not set here: they are per-run execution
   * caps, configured on `prepare` (default) and `execute` (override).
   */
  sandbox?: SandboxOptions
}

export interface DurableIsolates {
  /**
   * Prepare a prefix from a set of mounted modules — their shims (plus
   * `durable-isolates:internal`) become the prefix source, served by warm
   * resident instances. Many prefixes share the one sandbox and its run slots.
   */
  prepare: (options: PrepareOptions) => Promise<DurableIsolatesRunner>
  /**
   * The iso4 sandbox every prefix is prepared on — for its own API
   * (`stats()` for capacity/usage metrics, …). Always the same instance
   * `prepare` uses. CREATES the sandbox if it does not exist yet, so metrics
   * can be scraped before the first run; after `dispose()` the next call
   * creates a fresh one. The sandbox stays owned by durable-isolates: tear it
   * down through `DurableIsolates.dispose()`, not `sandbox.dispose()`.
   */
  getSandbox: () => Promise<Sandbox>
  /**
   * Tear down the sandbox and every prefix prepared on it. Not terminal: a
   * later `prepare`/`getSandbox` creates a fresh sandbox.
   */
  dispose: () => Promise<void>
}

export interface PrepareOptions {
  /**
   * The mounted modules. Keys ARE the virtual module specifiers — the mount
   * points in-sandbox code imports (e.g. `import { request } from 'acme'`).
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
 * shim's `durableCall` forwarded, as they read back from JSON.
 *
 * It does one of:
 * - returns a value → completed boundary; the value is written and read back
 *   as JSON (a `Date` becomes its ISO string, a `Map` becomes `{}`, …) and the
 *   sandbox `await` resolves with that;
 * - throws `SuspendIsolate` → the run suspends (waiting boundary + abort);
 * - throws anything else → failed boundary, re-thrown deterministically on
 *   replay. An `Error` is recorded as its `name` + `message` only; a non-Error
 *   throw is recorded as JSON;
 * - returns or throws something JSON cannot write (a `bigint`, a cycle, a
 *   `toJSON`/getter that throws) → the run is REJECTED (terminal `rejected`
 *   outcome, nothing recorded at this key).
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
// Runner — a prepared prefix; one replay turn per execute
// ─────────────────────────────────────────────────────────────────────────────

export interface DurableIsolatesRunner {
  /**
   * The iso4 prefix id this runner executes on — the key of its entry in
   * `sandbox.stats().prefixes`, for correlating per-prefix instance counts.
   */
  readonly prefixId: string
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
   * deterministically in the shim. Every durable call and `boundary()` must be
   * issued at the position it was recorded at, and a durable call at a
   * RECORDED key must ask the same `name` with the same `args` (stable JSON,
   * object key order ignored), or the run is rejected as a replay divergence —
   * so keep durable calls in the same order on every run, give each parallel
   * branch that makes more than one durable call its own `boundary()`, and
   * wrap nondeterministic inputs in `boundary()`. Durable calls and checkpoints
   * belong on the awaited path: work registered with iso4's `waitUntil` runs
   * after `execute` has returned, so anything it records lands in a `cache`
   * the caller may already have persisted — not supported.
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
   * iso4 resource limits for this run, overriding the prefix's `prepare`
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
 * Discriminated on `outcome`. The grown cache always comes back as `cache` and
 * iso4's own result for the turn as `run`; the payload beyond that is
 * outcome-specific.
 */
export type ExecuteResult
  = | CompletedResult
    | SuspendedResult
    | FailedResult
    | RejectedResult

interface ExecuteResultBase {
  /**
   * The grown cache — the caller persists it (or keeps it in memory) and hands
   * it back as the next `execute`'s `cache`.
   */
  cache: BoundaryCache
  /**
   * iso4's result for this turn, passed through verbatim (never reshaped):
   * `durationMs`, `wallTimeMs`, `cpuTimeMs`, `queueWaitMs`, `heapUsedBytes`,
   * `bridgeCalls`, `stdout`/`stderr`, …. Its arm follows `outcome` —
   * `completed` → `RunSuccess`, `failed` → `RunFailure`, `suspended` → iso4's
   * aborted arm (a suspension IS an abort to iso4). Which fields each arm
   * carries is iso4's contract: `queueWaitMs` is absent when no queueing
   * happened (and on `ERR_QUEUE_FULL`), the aborted arm has neither
   * `queueWaitMs` nor `heapUsedBytes`, and an abort that falls back to socket
   * teardown (a tight synchronous loop) reports zero timings and no
   * `bridgeCalls`. The clocks stop when the isolate settles — the kernel's
   * drain of in-flight dispatches afterwards is not included.
   *
   * `bridgeCalls` lists every bridge call the sandbox attempted, including the
   * kernel's own: every durable call (cache hit or dispatch) crosses as
   * `__di_call`, checkpoints as `__di_lookup` / `__di_commit` — see
   * `KERNEL_BRIDGE_GLOBALS` to filter them. Entries carry no arguments, so a
   * `__di_call` entry does not say which operation it was.
   */
  run: RunResult
}

export interface CompletedResult extends ExecuteResultBase {
  outcome: 'completed'
  /**
   * The module's `export default` value (`run.exports.default`).
   */
  result: unknown
  run: RunSuccess
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
  /**
   * Normally iso4's aborted arm — the kernel suspends a run by aborting it.
   * A program that never awaited the suspending call (or threw after it) can
   * finish first; the outcome is still `suspended`, because the operation is
   * parked, and iso4's own arm is passed through.
   */
  run: RunResult
}

export interface FailedResult extends ExecuteResultBase {
  outcome: 'failed'
  /**
   * The failure — iso4's `RunError`, passed through verbatim (never
   * wrapped). Switch on `code` (`RunErrorCode`): user errors
   * (`ERR_USER_CODE`, `ERR_HOST_BRIDGE`), limit breaches (`ERR_CPU_TIMEOUT`,
   * `ERR_MEMORY_LIMIT`, …) and capacity refusals (`ERR_QUEUE_FULL`,
   * `ERR_CAPACITY_MEMORY`, which iso4 resolves as failed runs rather than
   * rejecting) all land here. The same object as `run.error`.
   */
  error: RunError
  run: RunFailure
}

/**
 * The kernel REFUSED to continue the run: the program violated the durable
 * contract at a boundary, so no replay could be trusted to see the same thing
 * twice. Terminal for this turn and uncatchable in-sandbox (the isolate is
 * aborted and the violating bridge call never settles); every in-flight
 * dispatch is still drained into `cache`, but nothing is recorded at the
 * violating key — fix the program or the global and run the same cache again.
 * A suspension that happened in the same run is not reported (its waiting
 * record is in `cache`, its `pending` entry is dropped): a rejected run is
 * dead, and the resume re-dispatches the waiting boundary anyway.
 * `rejection` says what was refused and why, discriminated on `reason`; its
 * `message` is written for the author (or the model) that wrote the program.
 */
export interface RejectedResult extends ExecuteResultBase {
  outcome: 'rejected'
  rejection: Rejection
  /**
   * Normally iso4's aborted arm (the kernel rejects a run by aborting it). Only
   * a program that never awaited the violating call can finish first, in
   * which case iso4's own arm is passed through.
   */
  run: RunResult
}

/**
 * Why a run was rejected — discriminated on `reason`. `key` is the boundary
 * the violation happened at (nothing new is recorded there).
 */
export type Rejection = NonJsonRejection | DivergenceRejection | ProtocolRejection

/**
 * A bridge payload the kernel shim never sends: a program reached a bridge
 * global directly (`__di_call` with non-array args or no position, non-text
 * where text is expected, …). Nothing is recorded.
 */
export interface ProtocolRejection extends RejectionBase {
  reason: 'protocol'
  source: 'args' | 'commit'
  /**
   * The global the call routed to (`args` only).
   */
  name?: string
  /**
   * What was wrong, in fixed words (`not JSON text`, `malformed JSON text`,
   * `args are not a JSON array`, `missing issue position`, `malformed position`).
   */
  detail: string
}

/**
 * The program's durable operations no longer line up with the history. Either
 * an operation was issued at a different POSITION than recorded (`order`: the
 * operations are not in the recorded order — a swapped pair, a flipped branch,
 * an insertion), or at a recorded key the program asked for a different call:
 * another operation `name`, the same operation with other `args` (compared as
 * stable JSON, so object key order does not matter), or a call where the
 * record holds no call at all (a `boundary()`/`durableCommit` checkpoint, or a
 * record written by an older kernel). Nothing is answered, re-thrown or
 * re-dispatched; the history is left as it was.
 */
export interface DivergenceRejection extends RejectionBase {
  reason: 'divergence'
  /**
   * What differed: the position, the operation name, the arguments, or the
   * record holds no call to compare against.
   */
  mismatch: 'order' | 'name' | 'args' | 'no-call'
  /**
   * What the history holds where the conflict is: the record at `key` for
   * `name`, `args` and `no-call` (then `recorded.key === key`); for `order`,
   * the record that owns the asked position — at `key` if `key` is recorded
   * at another position, else the OTHER key already holding that position.
   * `name`/`args` are absent on a checkpoint record; `scope`/`order` on a
   * record written without a position (an older kernel, a raw commit).
   */
  recorded: { key: string, name?: string, args?: unknown[], scope?: string, order?: number }
  /**
   * What the program asked for this run: a durable call (its `name` and `args`
   * as they read back from JSON) or a checkpoint, at the issue position
   * `scope` + `order`.
   */
  attempted: { scope: string, order: number, name: string, args: unknown[] } | { scope: string, order: number }
}

interface RejectionBase {
  key: string
  /**
   * Author-facing explanation: what was refused, where, and the rule to
   * follow.
   */
  message: string
}

interface NonJsonRejectionBase extends RejectionBase {
  reason: 'non-json'
  /**
   * The JSON serializer's own explanation (`Do not know how to serialize a
   * BigInt`, `Converting circular structure to JSON …`, or what a throwing
   * `toJSON`/getter threw), cut to 1 KB. It may quote property names from the
   * value, which is why it is kept out of `message`.
   */
  detail: string
}

/**
 * A value JSON refuses on a durable call: in the args the sandbox passed
 * (`args`), in what the global `name` returned (`result`) or in what it threw
 * (`error`).
 */
export interface NonJsonCallRejection extends NonJsonRejectionBase {
  source: 'args' | 'result' | 'error'
  /**
   * The global the call routed to.
   */
  name: string
}

/**
 * A value JSON refuses, committed from the sandbox (`durableCommit`, or
 * returned from a `boundary()` body).
 */
export interface NonJsonCommitRejection extends NonJsonRejectionBase {
  source: 'commit'
}

export type NonJsonRejection = NonJsonCallRejection | NonJsonCommitRejection

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
 * sandbox-formed key); each record also remembers the position (`scope` +
 * `order`) it was issued at, which replay verifies. Plain JSON data; the
 * caller persists it however it likes.
 */
export type BoundaryCache = Record<string, BoundaryRecord>

/**
 * One recorded boundary. `seq` is history order (stamped at dispatch/commit
 * time) — eviction surgery ("this and everything after") and timelines only,
 * NEVER matching. Retry and eviction are the caller's cache surgery: delete a
 * failed entry to re-execute that boundary; delete by `seq` suffix to evict a
 * boundary and everything recorded after it.
 *
 * A record written by a global DISPATCH (`durableCall`) also carries the call
 * itself — `name` and `args` — so the history says what was asked at each key,
 * not only what came back. A record written by an in-sandbox COMMIT
 * (`durableCommit` / `boundary()`) has neither: the kernel never saw a call,
 * only a value.
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
  /**
   * The scope the operation was issued in: the ambient `boundary()` path
   * (`''` at the top level, `outer`, `outer/inner`, …). Positions are counted
   * per scope, so a boundary answered from the cache skips its whole subtree
   * without disturbing the parent's count, and parallel bodies never
   * interleave each other's numbering. Written on every record a durable call
   * or `boundary()` produces; absent on a raw `durableCommit` record and on
   * records from an older kernel.
   */
  scope?: string
  /**
   * Issue position within `scope`: a counter over every durable call and
   * checkpoint issued in that scope, taken when the operation was issued
   * (source order — stable under `Promise.all`, unlike `seq`). Compared on
   * replay: an operation at a different position than recorded, or a new key
   * at a position another key already holds, is a divergence. Present
   * together with `scope`.
   */
  order?: number
}

export interface CompletedBoundary extends BoundaryRecordBase {
  status: 'completed'
  /**
   * The operation `name` that was dispatched. Present on dispatch records,
   * absent on commit records.
   */
  name?: string
  /**
   * The args the shim forwarded to the global. Present on dispatch records,
   * absent on commit records.
   */
  args?: unknown[]
  value: unknown
}

export interface FailedBoundary extends BoundaryRecordBase {
  status: 'failed'
  /**
   * The operation `name` that was dispatched — also on a "no global for
   * `name`" failure. The kernel always writes it; optional in the type because
   * the cache is caller-persisted data that may predate this field.
   */
  name?: string
  /**
   * The args the shim forwarded to the global. The kernel always writes it;
   * optional in the type because the cache is caller-persisted data that may
   * predate this field.
   */
  args?: unknown[]
  /**
   * What the global threw, as JSON. An `Error` is reduced to `{ name, message }`
   * (own fields and the host stack are dropped — the sandbox gets a real Error
   * rebuilt from the two); a non-Error throw is recorded as it reads back from
   * JSON. Re-thrown into the sandbox deterministically on replay.
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
  /**
   * The args the shim forwarded to the global that suspended — the same args
   * the re-dispatch on resume forwards again.
   */
  args: unknown[]
}
