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
import type { HostExportFunction, HostGlobals, HostModuleObject, Imports, ResourceLimits, RunError, RunFailure, RunResult, RunSuccess, Sandbox, SandboxOptions } from '@iso4/sandbox'

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
   * Prepare a prefix from iso4 `imports` and `globals` (passed through, plain)
   * plus the durable registry `durableGlobals`; the kernel adds its own
   * `durable-isolates:internal` module and three bridge globals. Served by
   * warm resident instances — many prefixes share the one sandbox and its run
   * slots, and a prefix is the trust boundary (runs on one prefix share
   * `globalThis` carryover). Per-run overrides for the plain side are
   * handed to iso4 as given, so a wrong one fails the run with iso4's own
   * `ERR_UNDECLARED_BINDING` / `ERR_FROZEN_BINDING`.
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
   * iso4's `imports`, passed through as they are: keys are the specifiers
   * sandbox code imports; a string value is a sandbox module's ESM source (a
   * shim forming keys and calling `durableCall`/`boundary` from
   * `durable-isolates:internal`, or any other code), an object value is an
   * iso4 host module (plain host functions and data, nested up to 64 levels).
   * Plain host functions here are NOT durable and the kernel never touches
   * them: nothing is recorded, values cross with iso4's own V8 serialization,
   * and a `SuspendIsolate` thrown from one is just an error named
   * `SuspendIsolate` in the program (suspension is a durable call's feature).
   * The specifier `durable-isolates:internal` is reserved.
   */
  imports?: Imports
  /**
   * iso4's `globals`, passed through as they are: plain host functions (or
   * strings / data constants) installed on `globalThis` in the sandbox. Not
   * durable — same as a host-module function above. The three kernel bridge
   * names (`KERNEL_BRIDGE_GLOBALS`) are reserved, and a name cannot also be a
   * durable global.
   */
  globals?: HostGlobals
  /**
   * The durable registry: host functions a shim reaches ONLY through
   * `durableCall(key, name, …args)`, keyed by that `name`. Every call to one
   * is recorded, positioned, replayed from the cache, and can suspend the
   * run. A `name` whose per-run state (auth, approval answers) is captured
   * per run can be supplied on `ExecuteOptions.durableGlobals` instead.
   */
  durableGlobals?: DurableGlobals
  /**
   * Durable modules given as host functions, keyed by specifier: the kernel
   * writes the sandbox module for you. `import { load } from 'acme'` then
   * calls `load(...)`, which the generated module turns into
   * `durableCall(nextKey('acme.load'), 'acme.load', ...args)` — recorded as
   * `acme.load#0` (scope-prefixed inside a `boundary()`), positioned, replayed
   * from the cache, able to suspend. Nested objects become nested exports.
   * Functions only (a data value has nothing to record), export names must be
   * identifiers, a specifier cannot also be in `imports`, and the dotted
   * operation name cannot collide with a `durableGlobals` name; `prepare`
   * refuses each with the offending path. Top-level names are the module's
   * exports and must be identifiers; nested names may be any string (reached
   * as `obj[name]`).
   */
  durableImports?: Readonly<Record<string, DurableModule>>
  /**
   * Default iso4 resource limits for every `execute` on this prefix;
   * `ExecuteOptions.limits` overrides per run. Replay is bridge-call heavy (a
   * completed boundary still round-trips through the cache lookup), so
   * `maxBridgeCalls` defaults to 1000 (iso4's own default of 10 is far too low).
   */
  limits?: Partial<ResourceLimits>
}

// ─────────────────────────────────────────────────────────────────────────────
// Durable globals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A host-side durable global for one operation `name`. A call that has to RUN (a new
 * key, or a waiting record being resumed) and finds no mounted global rejects
 * the run (`reason: 'unknown-global'`); a call answered from the cache needs
 * none. The kernel invokes it only when
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
// Parameters are `any` so an ordinary typed host function `(id: string) => …` fits.
export type DurableGlobal = (...args: any[]) => unknown

/**
 * Durable globals keyed by the operation `name` the shim routes to — the
 * registry at prepare, or a per-run override map on `execute` (the
 * credentials story: fresh functions per run, auth in their closure,
 * including any approval answers the function consults on re-dispatch;
 * omitted names keep the prepared default).
 */
export type DurableGlobals = Readonly<Record<string, DurableGlobal>>

/**
 * A durable module given as host functions (see `PrepareOptions.durableImports`):
 * each property is a durable function, or a nested object of them.
 */
export interface DurableModule {
  readonly [name: string]: DurableGlobal | DurableModule
}

/**
 * Per-run overrides for plain iso4 globals declared at prepare: the function
 * (or bridge handler) under that name for THIS run — iso4's `globals` rebind,
 * handed through as given. An unknown name fails the run with iso4's own
 * `ERR_UNDECLARED_BINDING`.
 */
export type PlainGlobalOverrides = Readonly<Record<string, HostExportFunction>>

/**
 * Per-run overrides for the function leaves of host-module imports declared
 * at prepare, by specifier, mirroring the declared shape (nested objects
 * allowed) — iso4's `imports` rebind, handed through as given. An unknown
 * specifier or path, a string module or a data leaf fails the run with iso4's
 * own `ERR_UNDECLARED_BINDING` / `ERR_FROZEN_BINDING`.
 */
export type PlainImportOverrides = Readonly<Record<string, HostModuleObject>>

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
   * Per-run overrides for the function leaves of host-module `imports`
   * declared at prepare (iso4 semantics, plain).
   */
  imports?: PlainImportOverrides
  /**
   * Per-run overrides for plain iso4 `globals` declared at prepare.
   */
  globals?: PlainGlobalOverrides
  /**
   * Rebind durable globals for this run (auth and approval answers captured
   * in closure), keyed by operation `name`. Omitted names keep the prepared
   * default; `undefined` unmounts the name for this run. A value that is
   * neither makes `execute` throw before the run starts.
   */
  durableGlobals?: DurableGlobals
  /**
   * Rebind functions of `durableImports` modules for this run, by the same
   * specifier and (nested) path they were declared with — the same thing as
   * `durableGlobals` under the dotted operation name, written the way the
   * module was declared (the shape is not checked against the declaration; a
   * path that matches no declared leaf simply binds a name nothing calls). If
   * both maps name the same operation, `durableGlobals` wins. A leaf that is
   * neither a function nor `undefined` makes `execute` throw before the run.
   */
  durableImports?: Readonly<Record<string, DurableModule>>
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
 * Why a run was rejected — discriminated on `reason`: `non-json` (a value
 * JSON cannot write), `divergence` (the replay no longer lines up with the
 * history), `duplicate-key` (a key used twice, or a commit onto a recorded
 * key), `unknown-global` (a call that has to run has no mounted global), and
 * `protocol` (a bridge payload the shim never sends). `key` is the boundary
 * the violation happened at (nothing new is recorded there).
 */
export type Rejection = NonJsonRejection | DivergenceRejection | DuplicateKeyRejection | UnknownGlobalRejection | ProtocolRejection

/**
 * A boundary key was used twice: by two operations in this run (a step id
 * reused in a loop, two parallel steps with one id), or by a commit onto a key
 * the history already holds. Nothing new is recorded.
 */
export interface DuplicateKeyRejection extends RejectionBase {
  reason: 'duplicate-key'
  detail: 'used twice in this run' | 'already recorded'
}

/**
 * The program called an operation no mounted global answers (`name`): the
 * mounted globals changed since the run was recorded, or the shim routes to a
 * name that was never mounted. Nothing is recorded — a waiting record at `key`
 * stays as it was — so mounting the global and running the same cache resumes.
 */
export interface UnknownGlobalRejection extends RejectionBase {
  reason: 'unknown-global'
  name: string
}

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
 * an insertion), or at a recorded key the program asked for something else:
 * another operation `name`, the same operation with other `args` (compared as
 * stable JSON, so object key order does not matter), or a different `kind` of
 * operation (a durable call where a `boundary()`/`durableCommit` checkpoint
 * was recorded, or the reverse). Nothing is answered, re-thrown or
 * re-dispatched; the history is left as it was.
 */
export interface DivergenceRejection extends RejectionBase {
  reason: 'divergence'
  /**
   * What differed: the position, the operation name, the arguments, or the
   * kind of operation (a durable call where a checkpoint was recorded, or a
   * checkpoint where a call was).
   */
  mismatch: 'order' | 'name' | 'args' | 'kind'
  /**
   * What the history holds where the conflict is: the record at `key` for
   * `name`, `args` and `kind` (then `recorded.key === key`); for `order`,
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
   * The operation `name` that was dispatched. The kernel always writes it;
   * optional in the type because the cache is caller-persisted data that may
   * predate this field.
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
