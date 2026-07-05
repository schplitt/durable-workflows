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
import type { ResourceLimits, SandboxOptions } from '@iso4/sandbox'

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
   * Engine default: `maxIsolates: 30` (iso4 defaults to CPU count) — replay
   * runs are mostly I/O-idle (bridge waits don't burn CPU), so far more
   * concurrent runs than cores is fine and many instances may continue at
   * once.
   */
  sandbox?: SandboxOptions
  /**
   * The only mandatory adapter: where instances, steps and pending events
   * live. Values are stored exactly as they cross the iso4 bridge
   * (V8-serializable data) — there is no codec layer.
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
   */
  plugins?: readonly DurableWorkflowsPlugin[]
  /**
   * Retry policy for steps that fail without a per-step override.
   * OMITTED = NO RETRIES: a failing step fails on first attempt. There is no
   * built-in default, and no error classification in the engine: workflow
   * errors are the user's domain (catch them or set per-step policy); the
   * only thing that stops a configured retry is a host-side `permanent`
   * verdict on the error (e.g. a plugin failing an operation as unresolvable).
   */
  retry?: RetryPolicy
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
   * - `wallTimeMs: 180_000` — wall time DOES include in-run bridge waits
   *   (iso4 defaults to 30s). Anything legitimately longer than this belongs
   *   in a durable operation that suspends.
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
   * Deliver an external event (resolves a matching wait-for-event) and
   * continue the instance.
   */
  sendEvent: (instanceId: string, event: { type: string, payload?: unknown }) => Promise<void>
  /**
   * Replay a suspended instance now. This is THE continuation entry point —
   * called by the application's own trigger wiring (its cron, its timer
   * service, its queue consumer). The engine never wakes anything itself.
   */
  continueWorkflow: (instanceId: string) => Promise<void>
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
   * The workflow's return value; only once status is `completed`.
   */
  result: () => Promise<unknown>
}

export type InstanceStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'terminated'

// ─────────────────────────────────────────────────────────────────────────────
// Plugins
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A plugin ships as ONE npm package with two faces, versioned as a unit so
 * shim, host implementation and author-facing types can never drift:
 *
 *   "."          → the plugin factory (this interface) — consumed by the
 *                  application composing the engine.
 *   "./workflow" → ambient types for workflow authors' editors:
 *                  `declare module 'durable-workflows:agents' { ... }`
 *                  (the `cloudflare:workers` pattern). Zero runtime coupling —
 *                  at runtime the specifier resolves to the shim in the prefix.
 *
 * Breaking the workflow-facing API is a major bump; in-flight instances keep
 * running on an engine composed with the old major (npm alias deps), new
 * instances go to a new engine — routing and drain are application scope.
 */
export interface DurableWorkflowsPlugin {
  /**
   * Unique id (diagnostics, error scoping).
   */
  id: string
  /**
   * Virtual module specifier workflow code imports, e.g. `durable-workflows:agents`.
   */
  specifier: string
  /**
   * In-sandbox ESM source compiled into the iso4 prefix. Defines the module's
   * exports; may use the core's in-sandbox durable-call helper so plugin
   * operations become auto-id'd durable steps (how agent sessions work).
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

export interface RetryPolicy {
  /**
   * Maximum attempts per step (1 = no retries).
   */
  limit: number
  backoff?: 'constant' | 'linear' | 'exponential'
  delayMs?: number
}

export type ErrorClass = 'permanent' | 'transient'

export interface SerializedError {
  /**
   * JS error name. See iso4#12 — flattened to 'Error' until fixed upstream.
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
    | SleepStepRecord
    | WaitForEventStepRecord
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
 * Durable timer. Cannot fail — it is either still pending or satisfied.
 */
export interface SleepStepRecord extends StepRecordBase {
  kind: 'sleep'
  status: 'waiting' | 'completed'
  /**
   * Wake deadline. Informational for the application's own trigger wiring —
   * the engine checks it only when a continuation replays past this step.
   */
  wakeAt: string
}

/**
 * Durable wait on an external event. `failed` = timeout expired before the
 * event arrived (checked at continuation time, never autonomously).
 */
export type WaitForEventStepRecord
  = | WaitForEventStepWaitingRecord
    | WaitForEventStepCompletedRecord
    | WaitForEventStepFailedRecord

export interface WaitForEventStepWaitingRecord extends StepRecordBase {
  kind: 'waitForEvent'
  status: 'waiting'
  eventType: string
  /**
   * Timeout deadline, if the wait has one.
   */
  wakeAt?: string
}

export interface WaitForEventStepCompletedRecord extends StepRecordBase {
  kind: 'waitForEvent'
  status: 'completed'
  eventType: string
  /**
   * The delivered event payload.
   */
  value: unknown
}

export interface WaitForEventStepFailedRecord extends StepRecordBase {
  kind: 'waitForEvent'
  status: 'failed'
  eventType: string
  error: SerializedError
}

/**
 * Long-running host work dispatched by a plugin (e.g. an agent prompt).
 * `operationToken` is the dispatch idempotency key and how the outer world
 * addresses the completion back to this step.
 */
export type OperationStepRecord
  = | OperationStepWaitingRecord
    | OperationStepCompletedRecord
    | OperationStepFailedRecord

export interface OperationStepWaitingRecord extends StepRecordBase {
  kind: 'operation'
  status: 'waiting'
  operationToken: string
  /**
   * Operation timeout deadline, if any.
   */
  wakeAt?: string
}

export interface OperationStepCompletedRecord extends StepRecordBase {
  kind: 'operation'
  status: 'completed'
  operationToken: string
  value: unknown
}

export interface OperationStepFailedRecord extends StepRecordBase {
  kind: 'operation'
  status: 'failed'
  operationToken: string
  error: SerializedError
}

export interface InstanceRecord {
  instanceId: string
  workflow: string
  version?: string
  status: InstanceStatus
  input?: unknown
  result?: unknown
  error?: SerializedError
  createdAt: string
  updatedAt: string
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

  putEvent: (instanceId: string, type: string, payload: unknown) => Promise<void>
  /**
   * Consume one pending event of the given type, or null.
   */
  takeEvent: (instanceId: string, type: string) => Promise<unknown | null>
}

// ─────────────────────────────────────────────────────────────────────────────
// Observability
// ─────────────────────────────────────────────────────────────────────────────

export type EngineEvent
  = | { type: 'instance', instanceId: string, status: InstanceStatus, run: number }
    | { type: 'step', instanceId: string, stepId: string, status: StepStatus, attempt: number, run: number }
    | { type: 'log', instanceId: string, stepId?: string, run: number, level: 'log' | 'warn' | 'error', args: unknown[] }
