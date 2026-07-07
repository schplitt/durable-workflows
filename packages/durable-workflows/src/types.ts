/**
 * DRAFT — public type surface for the durable workflows engine.
 *
 * Entry point shape:
 *
 *   const engine = durableWorkflows({ store, resolveDefinition, plugins: [...] })
 *
 * Plugins never augment the engine surface — it is fixed. What a plugin
 * extends is the WORKFLOW's world: its shim defines a virtual module inside
 * the sandbox, and its `./workflow` d.ts types that module for authors'
 * editors. Anything operational a plugin needs host-side (e.g. agents orphan
 * reconciliation) lives on the plugin instance itself, not on the engine.
 */
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
   * The only mandatory adapter: where instances and steps live. Values are
   * stored exactly as they cross the iso4 bridge (V8-serializable data) —
   * there is no codec layer.
   */
  store: WorkflowStore
  /**
   * Where workflow definitions come from — the engine deliberately has NO
   * registry of its own. Called with a concrete version when replaying an
   * instance (instances pin the version they started on), and without one
   * when creating a new instance — the resolver decides what "latest" means
   * and returns the concrete version to pin. Definitions live wherever the
   * application wants: disk, database, git, an upload endpoint.
   */
  resolveDefinition: (name: string, version?: string) => Promise<ResolvedDefinition | null>
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
   * - `maxBridgeCalls: 300` — replay makes ~1 call per completed step plus
   *   2 per executing step plus every in-step host call; a typical workflow
   *   (~32 steps × ~3 host calls) peaks around 160 in a full run, so 300 is
   *   ~2× headroom while catching the runaway `while (true) await tool()`
   *   loop fast. Step-per-item loops over large collections should raise
   *   this via their definition's limits.
   * - `wallTimeMs: 600_000` — wall time DOES include in-run bridge waits
   *   (iso4 defaults to 30s). Matches Cloudflare's default step duration:
   *   step bodies doing mixed compute + I/O may legitimately run for
   *   minutes, each holding one isolate slot while active. A run executes
   *   ALL remaining ready steps sequentially — step-heavy pipelines (e.g.
   *   migrations) raise this via their definition's limits; anything longer
   *   than the budget (or of unknown duration) is lifted to a durable
   *   operation that suspends, which holds NO slot. Retry backoffs never
   *   wait in-run (cross-run via `retryAt`).
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
   * Start a new instance. Resolves the definition via `resolveDefinition`
   * (without a version unless `opts.version` says otherwise) and pins the
   * returned concrete version to the instance for all future replays.
   */
  create: (workflow: string, input?: unknown, opts?: CreateOptions) => Promise<WorkflowInstanceHandle>
  get: (instanceId: string) => Promise<WorkflowInstanceHandle | null>
  /**
   * THE single continuation entry point — called by the application's own
   * trigger wiring (its cron, its timer service, its webhook handlers). The
   * engine never wakes anything itself.
   *
   * Without `delivery`: plain replay — deadlines (sleep `wakeAt`, wait
   * timeouts, `retryAt`) are re-checked; if nothing is due the run just
   * suspends again (harmless no-op).
   *
   * With `delivery`: the result for the pending operation addressed by
   * `token`. The token is minted by the engine when the operation is
   * created and handed OUTWARD at dispatch time (dispatch payload, waiting
   * step record, `onEvent`) — the caller echoes it back, never derives it.
   * `error.class` carries the retry verdict. Unknown or already-settled
   * token → rejects (which doubles as duplicate/too-late detection). There
   * is NO buffering: a delivery must hit a waiting operation.
   */
  continueWorkflow: (instanceId: string, delivery?: OperationDelivery) => Promise<void>
  terminate: (instanceId: string) => Promise<void>
  /**
   * Prefix invalidation: deletes the step and every step recorded after it,
   * then replays. Rare manual remediation — not part of normal operation.
   */
  evict: (instanceId: string, stepId: string) => Promise<void>
  /**
   * Evict everything and replay from scratch.
   */
  restart: (instanceId: string) => Promise<void>
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
 * The result the outside world hands a suspended workflow, addressed by the
 * operation token that was handed out at dispatch time. Success delivers the
 * value the waiting operation resolves with; failure delivers an error whose
 * `class` feeds the retry machinery (`permanent` = never retried).
 */
export type OperationDelivery
  = | { token: string, value: unknown }
    | { token: string, error: SerializedError }

export interface CreateOptions {
  /**
   * Caller-provided id for idempotent creation (e.g. derived from an alarm id).
   */
  instanceId?: string
  /**
   * Pin a specific definition version instead of the resolver's "latest".
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
 * Plugins repeat the core's adapter pattern one level down: a plugin defines
 * its capability, shim and token protocol, but takes its deployment BACKEND
 * as an interface on its factory — the time plugin takes a timer backend,
 * an events plugin a notification transport, the agents plugin an agent
 * service client. The dev wires each to their infra exactly like they wire
 * the core's store to their database.
 */
export interface DurableWorkflowsPlugin {
  /**
   * Unique id (diagnostics, error scoping).
   */
  id: string
  /**
   * In-sandbox ESM source compiled into the iso4 prefix. Defines the
   * module's exports, building on `durable-workflows:internal` — the core's
   * semver'd shim-facing module (durable-operation calls with auto step ids
   * and tokens, bound to this plugin's host handlers). `internal` is for
   * shims only: registration-time import scanning rejects workflow bundles
   * that import it.
   */
  shim: string
  /**
   * Host-side bridge handlers, constructed **per instance run** — this is the
   * credentials story: every resume gets freshly built handlers, so secrets
   * live host-side only and tokens are provisioned at wake-up time.
   */
  host: (ctx: InstanceRunContext) => Record<string, HostHandler>
}

/**
 * Aligned with iso4's HostExportFunction; args/results cross the bridge serialized.
 */
export type HostHandler = (...args: unknown[]) => unknown

export interface InstanceRunContext {
  instanceId: string
  workflow: string
  /**
   * Monotonic per-instance run counter (1 = first execution).
   */
  run: number
}

/**
 * Identity helper for plugin authors — shape validation with inference kept.
 * A plugin factory typically wraps this: `agentsPlugin(opts)` builds the
 * object and may expose its own operational methods alongside (never on the
 * engine).
 */
export type DefineWorkflowsPlugin = <TPlugin extends DurableWorkflowsPlugin>(plugin: TPlugin) => TPlugin

// ─────────────────────────────────────────────────────────────────────────────
// Policies & errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Retries are configured per step (an option on the step call inside the
 * workflow). A step that supplies no policy gets the ENGINE DEFAULT:
 * `{ limit: 3, backoff: 'linear', delayMs: 3000 }`, paired with a default
 * per-step timeout of 5 minutes (which must fit the run's wall budget —
 * enforced engine-side via run abort, attributable to the step, retryable).
 *
 * Retries are CROSS-RUN — an isolate is never parked to wait out a backoff
 * delay. A failing attempt updates the failed record (attempts, pinned
 * policy, and `retryAt` = failure time + computed backoff) and the run ends
 * with the instance `waiting`. Re-execution happens on a later continuation
 * arriving at or after `retryAt` — checked at continuation time like every
 * other deadline; `retryAt` is informational for the application's trigger
 * wiring, the engine never acts on time itself. Once attempts exhaust the
 * policy the failure is final and replays as a deterministic throw.
 *
 * The EFFECTIVE policy is PINNED AT FIRST FAILURE: the step's own option (or
 * the engine default in force at that moment) is resolved and persisted on
 * the failed record; policies supplied by later replays — and later changes
 * to the engine default — are ignored. Step options should be constant
 * anyway (determinism rules), but pinning makes retry behavior immune to
 * nondeterministically computed policies and to default drift across
 * deploys.
 *
 * A host-side `permanent` error verdict always wins: such failures are never
 * retried regardless of policy (workflow code can trigger this via the
 * well-known NonRetryableError, Cloudflare-style). There is no error
 * classification in the engine beyond that — workflow errors are the
 * author's domain (catch them, or don't configure retries).
 */
export interface RetryPolicy {
  /**
   * Maximum attempts per step (1 = no retries).
   */
  limit: number
  /**
   * How the delay grows per attempt. Default: 'constant'.
   */
  backoff?: 'constant' | 'linear' | 'exponential'
  /**
   * Base delay between attempts in milliseconds. Minimum (and default) 1000.
   */
  delayMs?: number
}

export type ErrorClass = 'permanent' | 'transient'

export interface SerializedError {
  /**
   * JS error name.
   */
  name: string
  message: string
  stack?: string
  /**
   * Set by durable-operation verdicts or classification; permanent = never retried.
   */
  class?: ErrorClass
}

// ─────────────────────────────────────────────────────────────────────────────
// Store contract & records (skeleton — to be designed in detail)
// ─────────────────────────────────────────────────────────────────────────────

export type StepKind = StepRecord['kind']

export type StepStatus = StepRecord['status']

/**
 * Discriminated on `kind` — each durable primitive persists exactly the
 * fields its semantics need, no optional grab-bag.
 */
export type StepRecord
  = | DoStepRecord
    | ScopeStepRecord
    | OperationStepRecord

interface StepRecordBase {
  instanceId: string
  stepId: string
  /**
   * Record order — drives prefix eviction ("this step and everything after").
   */
  seq: number
  attempts: number
  /**
   * Enclosing scope's stepId for namespaced sub-steps.
   */
  parentId?: string
}

/**
 * Atomic unit of work. Never waits: it either completed (value frozen, body
 * skipped forever) or failed (retry policy decides what happens on the next
 * continuation).
 */
export type DoStepRecord = DoStepCompletedRecord | DoStepFailedRecord

export interface DoStepCompletedRecord extends StepRecordBase {
  kind: 'do'
  status: 'completed'
  value: unknown
}

export interface DoStepFailedRecord extends StepRecordBase {
  kind: 'do'
  status: 'failed'
  error: SerializedError
  /**
   * The EFFECTIVE policy, pinned at first failure: the step's own option or
   * the engine default in force at that moment. Policies supplied by later
   * replays — and later changes to the engine default — are ignored.
   */
  retry: RetryPolicy
  /**
   * When the next attempt becomes eligible — present only while retries
   * remain. Informational for the application's trigger wiring (like
   * `wakeAt`); enforced at continuation time.
   */
  retryAt?: string
}

/**
 * Composite namespace. Only recorded once its body ran to completion (or
 * failed permanently) — until then only its sub-steps exist, linked via
 * `parentId`. Evicting a scope evicts its whole subtree.
 */
export type ScopeStepRecord = ScopeStepCompletedRecord | ScopeStepFailedRecord

export interface ScopeStepCompletedRecord extends StepRecordBase {
  kind: 'scope'
  status: 'completed'
  value: unknown
}

export interface ScopeStepFailedRecord extends StepRecordBase {
  kind: 'scope'
  status: 'failed'
  error: SerializedError
}

/**
 * THE universal wait primitive — the only thing that suspends. Every waiting
 * capability (sleep, external events/approvals, agent work) is a plugin
 * composing this: an outward host-side dispatch paired with an inbound
 * token-addressed delivery via `continueWorkflow`. `token` is the dispatch
 * idempotency key AND the delivery address. Multiple operations may be
 * pending in parallel — which is why deliveries are always token-addressed.
 */
export type OperationStepRecord
  = | OperationStepWaitingRecord
    | OperationStepCompletedRecord
    | OperationStepFailedRecord

export interface OperationStepWaitingRecord extends StepRecordBase {
  kind: 'operation'
  status: 'waiting'
  token: string
  /**
   * Id of the plugin that dispatched this operation — observability and
   * orphan reconciliation (a plugin finds "its" waiting operations).
   */
  plugin: string
  /**
   * Plugin-defined operation name (e.g. 'sleep', 'approval.request',
   * 'session.prompt') — descriptive for wiring/UI; matching is by token.
   */
  operation: string
  /**
   * Deadline, if any (sleep wake time, wait/operation timeout) — enforced at
   * continuation time; informational for the application's trigger wiring.
   */
  wakeAt?: string
}

export interface OperationStepCompletedRecord extends StepRecordBase {
  kind: 'operation'
  status: 'completed'
  token: string
  plugin: string
  operation: string
  value: unknown
}

export interface OperationStepFailedRecord extends StepRecordBase {
  kind: 'operation'
  status: 'failed'
  token: string
  plugin: string
  operation: string
  error: SerializedError
  /**
   * The EFFECTIVE policy, pinned at first failure: the step's own option or
   * the engine default in force at that moment. Policies supplied by later
   * replays — and later changes to the engine default — are ignored.
   */
  retry: RetryPolicy
  /**
   * When the next attempt becomes eligible — present only while retries
   * remain. Informational for the application's trigger wiring (like
   * `wakeAt`); enforced at continuation time.
   */
  retryAt?: string
}

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
   * `InstanceRunContext.run` and `InstanceOutcome.runs`.
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

export interface WorkflowStore {
  createInstance: (record: InstanceRecord) => Promise<void>
  getInstance: (instanceId: string) => Promise<InstanceRecord | null>
  updateInstance: (record: InstanceRecord) => Promise<void>
  deleteInstance: (instanceId: string) => Promise<void>

  getStep: (instanceId: string, stepId: string) => Promise<StepRecord | null>
  putStep: (record: StepRecord) => Promise<void>
  listSteps: (instanceId: string) => Promise<StepRecord[]>
  /**
   * Prefix delete: the step and every record with a greater `seq`.
   */
  evictFromStep: (instanceId: string, stepId: string) => Promise<void>
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
      kind: StepKind
      status: StepStatus
      attempt: number
      run: number
      /**
       * The wait token for waiting wait-for-event / operation steps — this is
       * how the application's wiring learns the delivery address (e.g. hands
       * it to the agent service or embeds it in an approval ticket).
       */
      token?: string
    }
    | { type: 'log', instanceId: string, stepId?: string, run: number, level: 'log' | 'warn' | 'error', args: unknown[] }
