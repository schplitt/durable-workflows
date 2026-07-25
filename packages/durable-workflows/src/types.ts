/**
 * DRAFT — public type surface for the durable workflows engine.
 *
 * Entry point shape:
 *
 *   const engine = durableWorkflows({ store, plugins: { ... } })
 *
 * Plugins never augment the engine surface — it is fixed. What a plugin
 * extends is the WORKFLOW's world: its shim defines a virtual module inside
 * the sandbox, and its `./workflow` d.ts types that module for authors'
 * editors. Anything operational a plugin needs host-side (e.g. agents orphan
 * reconciliation) lives on the plugin instance itself, not on the engine.
 */
import type { BoundaryCache } from 'durable-isolates'
import type { ResourceLimits, SandboxOptions } from 'durable-isolates/types/iso4'

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export type DurableWorkflows = (options: DurableWorkflowsOptions) => DurableWorkflowsEngine

export interface DurableWorkflowsOptions {
  /**
   * Options for the iso4 sandbox — the sandbox itself is ENTIRELY managed
   * internally: created lazily on first execution together with the one
   * prefix per engine (core step shim + all plugin shims), reused for every
   * replay, and disposed by `dispose()`. Note: each engine owns its own
   * sandbox subprocess — two engines (e.g. two runtime-surface versions)
   * means two processes.
   *
   * Engine default: `maxIsolates: 45` (iso4 defaults to CPU count) — replay
   * runs are mostly I/O-idle (bridge waits don't burn CPU), so far more
   * concurrent runs than cores is fine. This is the capacity budget for
   * concurrently ACTIVE runs, including long-executing step bodies: one
   * held slot per run for up to the wall budget; excess continuations queue.
   * Sized for a 2-core / 4GB service (worst case 45 × 64MB ≈ 2.9GB isolate
   * memory; realistic orchestration isolates use a fraction of the cap).
   */
  sandbox?: SandboxOptions
  /**
   * The only mandatory adapter: ONE persistent world — instances, their
   * boundary caches, and read access to workflow definitions. Values are
   * stored exactly as they cross the iso4 bridge (V8-serializable data) —
   * there is no codec layer.
   */
  store: WorkflowStore
  /**
   * Capabilities workflow code can import. Each plugin is a pair of an
   * in-sandbox shim and a host-side implementation.
   *
   * Always a record: keys ARE the mount points — the virtual module
   * specifiers workflow code imports. Only what is mounted exists in the
   * sandbox, so a deployment can expose a fully custom namespace over the
   * first-party plugins (e.g. `{ 'cumulocity:sleep': timePlugin(...) }`).
   * Core modules (`durable-workflows:workflow`) are remounted via `alias`.
   */
  plugins?: Readonly<Record<string, DurableWorkflowsPlugin>>
  /**
   * Additional or replacement specifiers for CORE modules, e.g.
   * `{ 'cumulocity:workflow': 'durable-workflows:workflow' }` (alias →
   * canonical). The types-side counterpart is a thin ambient re-export
   * d.ts shipped by the whitelabeling package.
   */
  alias?: Readonly<Record<string, string>>
  /**
   * iso4 resource limits per replay run; `ResolvedDefinition.limits`
   * overrides per definition, and explicit settings ALWAYS win — the engine
   * never silently overrides what was configured. Limits are a safety net
   * against runaway code, not scheduling — CPU time excludes bridge waits
   * (host I/O is free), so generous values cost little.
   *
   * Engine defaults (differing from iso4's own):
   * - `maxBridgeCalls: 300` — each durable boundary costs a small, known
   *   number of bridge calls: a completed do/scope replays as 1 (a
   *   `durableLookup` hit, its body skipped), a do/scope executing this run is
   *   2 (`durableLookup` miss + `durableCommit`), and every durable operation
   *   is 1 (`durableCall`, whether answered from cache or dispatched). A
   *   typical workflow (~32 boundaries, most cached on a late replay, a handful
   *   of operations) peaks around 100–160 calls in a full run, so 300 is ~2×
   *   headroom while catching the runaway `while (true) await op()` loop fast.
   *   Step-per-item loops over large collections should raise this via their
   *   definition's limits.
   * - `wallTimeMs: 600_000` — wall time DOES include in-run bridge waits
   *   (iso4 defaults to 30s). Matches Cloudflare's default step duration:
   *   step bodies doing mixed compute + I/O may legitimately run for
   *   minutes, each holding one isolate slot while active. A run executes
   *   ALL remaining ready steps sequentially — step-heavy pipelines (e.g.
   *   migrations) raise this via their definition's limits; anything longer
   *   than the budget (or of unknown duration) is lifted to a durable
   *   operation that suspends, which holds NO slot. Retries, if any, are the
   *   caller's cross-run concern (cache surgery), never an in-run wait.
   * - `cpuTimeMs: 30_000` — actual in-sandbox compute per run (bridge waits
   *   excluded; iso4 defaults to 5s). Generous enough for real per-step
   *   data reshaping; heavy crunchers raise it per definition.
   * - everything else: iso4 defaults, including `memoryMb: 64` and the 16MB
   *   bridge/export payload caps — DELIBERATELY not raised. The sandbox is
   *   the orchestrator, not the compute engine: every value crossing a
   *   durable boundary is persisted and re-crossed on replay, so big data
   *   (large CSVs, images) is passed BY REFERENCE (storage key, workspace
   *   path) and processed host-side by plugins or agents, which have real
   *   toolchains. 64MB covers legitimate in-sandbox work (reshaping a few MB
   *   of JSON, orchestration math); honest edge cases raise `cpuTimeMs` /
   *   `memoryMb` via their definition's limits.
   *
   * A limit breach kills the run mid-step with nothing written: the instance
   * fails with the iso4 error, and raising limits + `continueWorkflow`
   * re-executes the incomplete step cleanly.
   */
  limits?: Partial<ResourceLimits>
  /**
   * Observability hook: structured lifecycle events (instance/step/operation
   * state changes) and context-tagged workflow logs. The engine emits, the
   * application persists — the library stores nothing itself.
   */
  onEvent?: (event: EngineEvent) => void
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine surface
// ─────────────────────────────────────────────────────────────────────────────

export interface DurableWorkflowsEngine {
  /**
   * In-flight work: currently executing replay runs and store writes that
   * have not settled yet. Entries remove themselves on settlement. For a
   * graceful container shutdown: stop your trigger wiring, then
   * `await Promise.allSettled([...engine.pendingPromises])`, then `dispose()`
   * (which also awaits these itself).
   */
  readonly pendingPromises: ReadonlySet<Promise<unknown>>
  /**
   * Start a new instance and run its first turn. Resolves the definition via
   * the store's `getDefinition` (without a version unless `opts.version` says
   * otherwise), pins the returned concrete version to the instance for all
   * future replays, and returns the run's outcome.
   */
  create: (workflow: string, input?: unknown, opts?: CreateOptions) => Promise<RunOutcome>
  get: (instanceId: string) => Promise<WorkflowInstanceHandle | null>
  /**
   * THE single continuation entry point — called by the application's own
   * trigger wiring (its cron, its timer service, its webhook handlers). The
   * engine never wakes anything itself.
   *
   * Plain re-execution: a fresh replay passes through the cache and
   * re-dispatches every still-waiting operation's handler, which consults host
   * state (the plugin's own backend, the clock, an approval row) and proceeds,
   * throws, or suspends again. There is no delivery argument and no token — a
   * resolved value reaches the workflow because the handler now RETURNS it on
   * re-dispatch, not because anything is injected into the cache. If nothing is
   * due the run just suspends again (a harmless no-op). Returns the outcome.
   */
  continueWorkflow: (instanceId: string) => Promise<RunOutcome>
  terminate: (instanceId: string) => Promise<void>
  /**
   * Prefix invalidation: deletes the boundary, every boundary recorded after it
   * (by `seq`), and its whole subtree (by key-prefix — a scope's children commit
   * before the scope itself, so a seq-only prune would leave them cached), then
   * replays. Rare manual remediation — not part of normal operation.
   */
  evict: (instanceId: string, stepId: string) => Promise<RunOutcome>
  /**
   * Evict everything and replay from scratch.
   */
  restart: (instanceId: string) => Promise<RunOutcome>
  /**
   * Await `pendingPromises`, then release the precompiled prefix and dispose
   * the internally managed sandbox.
   */
  dispose: () => Promise<void>
}

export interface ResolvedDefinition {
  /**
   * The concrete version the instance pins; replay always resolves exactly this.
   */
  version: string
  /**
   * Bundled ESM source. Capability specifiers stay external.
   */
  code: string
  /**
   * Per-definition resource overrides (e.g. from a manifest) for workloads
   * that legitimately need more than the engine default — heavy in-sandbox
   * compute like parsing large files. Merge order: engine defaults ←
   * `options.limits` ← these; explicit settings always win. Limits bound ONE
   * replay execution, never the workflow's lifetime — anything longer-running
   * than the wall budget belongs in a durable operation that suspends.
   */
  limits?: Partial<ResourceLimits>
}

/**
 * The outcome of one replay run (`create` / `continueWorkflow` / `evict` /
 * `restart`). A run never ends 'running': it either completed, is now waiting
 * on one or more operations, or failed.
 */
export type RunOutcome
  = | (RunOutcomeBase & { status: 'completed' })
    | (RunOutcomeBase & { status: 'waiting', pending: PendingOperation[] })
    | (RunOutcomeBase & { status: 'failed', error: SerializedError })

interface RunOutcomeBase {
  instanceId: string
  /**
   * Which run this was (1 = first execution) — matches the instance's run
   * counter after this turn.
   */
  run: number
}

/**
 * A durable operation that suspended this run, surfaced so the caller's own
 * wiring can react (register a timer, POST a job, create an approval ticket)
 * and later resume with a plain `continueWorkflow`. `stepId` is the boundary
 * key, `operation` the plugin operation name, `payload` whatever the handler
 * passed to `SuspendIsolate`. Usually the handler already did the outward work
 * before suspending, so this is mostly informational; the bare escape-hatch
 * plugins (raw events) are where the caller genuinely acts on it.
 */
export interface PendingOperation {
  stepId: string
  operation: string
  payload: unknown
}

export interface CreateOptions {
  /**
   * Caller-provided id for idempotent creation (e.g. derived from an alarm id).
   */
  instanceId?: string
  /**
   * Pin a specific definition version instead of the store's "latest"/active.
   */
  version?: string
}

export interface WorkflowInstanceHandle {
  readonly id: string
  status: () => Promise<InstanceStatus>
  /**
   * `null` while the instance is running/waiting; the outcome once it is
   * terminal.
   */
  outcome: () => Promise<InstanceOutcome | null>
}

/**
 * How a finished instance ended, plus run metadata — everything derivable
 * from the instance record. NOTE: the workflow function's return value is
 * DISCARDED — workflows act through their steps, nobody consumes a return
 * (revisit if child workflows / awaiting another workflow ever lands).
 */
export type InstanceOutcome
  = | (InstanceOutcomeBase & { status: 'completed' })
    | (InstanceOutcomeBase & { status: 'failed', error: SerializedError })
    | (InstanceOutcomeBase & { status: 'terminated' })

interface InstanceOutcomeBase {
  instanceId: string
  workflow: string
  version: string
  /**
   * How many runs (replays) the instance took.
   */
  runs: number
  createdAt: string
  finishedAt: string
}

export type InstanceStatus = InstanceRecord['status']

// ─────────────────────────────────────────────────────────────────────────────
// Plugins
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A plugin ships as ONE npm package with two faces, versioned as a unit so
 * shim, host implementation and author-facing types can never drift:
 *
 *   "."          → the plugin factory (this interface) — consumed by the
 *                  application composing the engine. A plugin does NOT name
 *                  itself: the mount key in `options.plugins` is the
 *                  specifier; the package README documents its conventional
 *                  one (e.g. `durable-workflows:agents`).
 *   "./workflow" → ambient types for workflow authors' editors:
 *                  `declare module 'durable-workflows:agents' { ... }`
 *                  (the `cloudflare:workers` pattern) for the conventional
 *                  specifier; whitelabeled mounts ship their own thin
 *                  re-export d.ts. Zero runtime coupling — at runtime the
 *                  specifier resolves to the shim in the prefix.
 *
 * Breaking the workflow-facing API is a major bump; in-flight instances keep
 * running on an engine composed with the old major (npm alias deps), new
 * instances go to a new engine — routing and drain are application scope.
 *
 * Plugins repeat the core's adapter pattern one level down, in one of two
 * packaging shapes (both this same `{ id, shim, handlers }` object):
 *   - the plugin ships the SHIM and the handler LOGIC and takes its deployment
 *     backend as a factory parameter (a well-defined external service: the
 *     agents plugin takes an agent-service client, a fetch plugin the iso4
 *     fetch handler);
 *   - the plugin ships only the SHIM and the dev supplies the handler, because
 *     the mechanism is irreducibly their infra (the `time`/sleep plugin: where
 *     and how a wake-up is registered — cron row, Postgres NOTIFY, setTimeout
 *     — and what fires it are the dev's, so the handler is theirs, guided by
 *     jsdoc).
 * Either way the dev wires the backend (or the handler) to their infra exactly
 * like they wire the core's store to their database.
 */
export interface DurableWorkflowsPlugin {
  /**
   * Unique id (diagnostics, error scoping).
   */
  id: string
  /**
   * In-sandbox ESM source compiled into the iso4 prefix. Defines the
   * module's exports, building on `durable-workflows:internal` — the core's
   * semver'd shim-facing module, itself a thin wrapper over the kernel's
   * `durable-isolates:internal` that enforces the leaf rule and namespaces
   * step ids into boundary keys. A durable-operation call forms an auto step
   * id (the boundary key) and routes to this plugin's handlers by name. No
   * token machinery exists: an operation that must wait suspends by its handler
   * throwing `SuspendIsolate`, and resume is plain re-execution — the handler
   * consults host state to proceed. `internal` is for shims only:
   * registration-time import scanning rejects workflow bundles that import it.
   */
  shim: string
  /**
   * Host-side handlers keyed by operation `name`. The plugin's factory closes
   * over its backend (and any auth provider); a handler provisions credentials
   * itself per call via that provider (`auth(instanceId)`), so every resume
   * runs against freshly provisioned secrets that never enter the sandbox.
   */
  handlers: Readonly<Record<string, DurableHandler>>
}

/**
 * A host-side handler for one durable operation `name`. Invoked when its
 * boundary is not already settled in the cache — a cache hit never re-dispatches
 * it. A `waiting` boundary IS re-dispatched (the resume path): the handler
 * consults host state and either returns a value (→ completed boundary), throws
 * `SuspendIsolate` (→ still waiting), or throws anything else (→ failed
 * boundary, re-thrown deterministically on replay). It receives ONE structured
 * input: the sandbox `payload` kept strictly separate from engine metadata.
 */
export type DurableHandler = (input: DurableHandlerInput) => unknown

export interface DurableHandlerInput {
  instanceId: string
  workflow: string
  /**
   * Monotonic per-instance run counter (1 = first execution).
   */
  run: number
  /**
   * The boundary key — unique per operation call, stable across replays. Key
   * your own backend on this (timer row, dispatch idempotency).
   */
  stepId: string
  /**
   * Exactly what the workflow passed the operation, forwarded from the sandbox
   * — never blended with the metadata above.
   */
  payload: unknown
}

/**
 * Identity helper for plugin authors — shape validation with inference kept.
 * A plugin factory typically wraps this: `agentsPlugin(opts)` builds the
 * object and may expose its own operational methods alongside (never on the
 * engine).
 */
export type DefineWorkflowsPlugin = <TPlugin extends DurableWorkflowsPlugin>(plugin: TPlugin) => TPlugin

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An optional verdict a plugin may attach to a failure. The minimal engine does
 * NOT act on it — retry is the caller's cache surgery (delete the failed
 * boundary and re-run), not engine state — so `class` is purely informational
 * for the application's own retry decision. `permanent` conventionally means
 * "re-running can never help" (bad config, disallowed request).
 */
export type ErrorClass = 'permanent' | 'transient'

/**
 * How a failure is surfaced (`RunOutcome` failed, `FailedInstanceRecord`). This
 * layer's shape is the kernel's recorded error — the plain
 * `{ name, message, ...ownFields }` a thrown handler error becomes crossing the
 * iso4 bridge — lifted into a named shape. `data` carries the thrown error's
 * own fields verbatim; it is re-thrown into the sandbox on replay, so
 * catch-branches see it identically. `class` is an optional verdict a plugin
 * attached, read by the app, not by the engine.
 */
export interface SerializedError {
  /**
   * JS error name.
   */
  name: string
  message: string
  stack?: string
  /**
   * The thrown error's own fields, carried verbatim across the kernel bridge
   * and re-thrown into the sandbox on replay.
   */
  data?: unknown
  /**
   * Optional plugin-attached verdict; informational only (see `ErrorClass`).
   */
  class?: ErrorClass
}

// ─────────────────────────────────────────────────────────────────────────────
// Store contract & records
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Discriminated on `status` — error exists iff failed. The workflow's return
 * value is never persisted (discarded on completion).
 */
export type InstanceRecord
  = | ActiveInstanceRecord
    | CompletedInstanceRecord
    | FailedInstanceRecord
    | TerminatedInstanceRecord

interface InstanceRecordBase {
  instanceId: string
  workflow: string
  /**
   * The pinned definition version — every replay resolves exactly this.
   */
  version: string
  input?: unknown
  /**
   * Monotonic run counter — incremented per continuation; feeds
   * `DurableHandlerInput.run`, `RunOutcome.run` and `InstanceOutcome.runs`.
   */
  runs: number
  createdAt: string
  updatedAt: string
}

export interface ActiveInstanceRecord extends InstanceRecordBase {
  status: 'running' | 'waiting'
}

export interface CompletedInstanceRecord extends InstanceRecordBase {
  status: 'completed'
}

export interface FailedInstanceRecord extends InstanceRecordBase {
  status: 'failed'
  error: SerializedError
}

export interface TerminatedInstanceRecord extends InstanceRecordBase {
  status: 'terminated'
}

/**
 * Deliberately tiny: the engine persists only instances and, per instance, the
 * kernel's boundary cache as an opaque blob. There is no per-step table — the
 * durable history IS the cache. Eviction (prefix / subtree surgery) is done
 * in-memory by the engine on the loaded cache before it re-executes, so the
 * store only ever reads and writes the whole blob. A new backend should be an
 * afternoon.
 *
 * Definitions are the store's READ-ONLY third concern: the engine never
 * writes them. Writing (upload, versioning, rollback, deletion) is the
 * application's own deploy layer operating on the same backend — deliberately
 * out of engine scope.
 */
export interface WorkflowStore {
  createInstance: (record: InstanceRecord) => Promise<void>
  getInstance: (instanceId: string) => Promise<InstanceRecord | null>
  updateInstance: (record: InstanceRecord) => Promise<void>
  deleteInstance: (instanceId: string) => Promise<void>

  /**
   * The instance's boundary cache — the kernel's durable history, persisted
   * verbatim. `null` (or `{}`) before the first run.
   */
  getCache: (instanceId: string) => Promise<BoundaryCache | null>
  putCache: (instanceId: string, cache: BoundaryCache) => Promise<void>

  /**
   * Where workflow definitions come from — the engine only ever READS them.
   * Called without a `version` when creating a new instance (the adapter
   * decides what "latest"/active means and returns the concrete version to
   * pin), and with the pinned version on every replay of an existing
   * instance.
   *
   * CONTRACT (the price of storing a reference instead of the bytes): a
   * `(name, version)` pair is immutable and must stay fetchable —
   * byte-identical, forever — while any instance pins it. Think docker image
   * digest: the deploy layer never mutates a handed-out version and refuses
   * to delete one that instances still reference; otherwise those instances
   * strand or (worse) replay divergent code. The engine cannot enforce this —
   * it lives in the adapter/deploy layer.
   */
  getDefinition: (name: string, version?: string) => Promise<ResolvedDefinition | null>
}

// ─────────────────────────────────────────────────────────────────────────────
// Observability
// ─────────────────────────────────────────────────────────────────────────────

export type EngineEvent
  = | { type: 'instance', instanceId: string, status: InstanceStatus, run: number }
    | {
      type: 'step'
      instanceId: string
      stepId: string
      /**
       * The boundary's status this run — mirrors the kernel's `BoundaryRecord`.
       */
      status: 'completed' | 'failed' | 'waiting'
      run: number
    }
    | { type: 'log', instanceId: string, stepId?: string, run: number, level: 'log' | 'warn' | 'error', args: unknown[] }
