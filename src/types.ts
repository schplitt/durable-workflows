/**
 * DRAFT — public type surface for the durable workflows engine.
 *
 * Entry point shape:
 *
 *   const engine = durableWorkflows({ sandbox, store, resolveDefinition, plugins: [...] })
 *
 * Plugin typing follows the better-auth model, not the vite model: plugins are
 * not just lifecycle hooks, they carry types that augment the inferred engine
 * surface (`$engine`). Later the same mechanism can feed the workflow-authoring
 * types (what a workflow may import).
 */
import type { ResourceLimits, Sandbox } from '@iso4/sandbox'

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export type DurableWorkflows = <const TPlugins extends readonly DurableWorkflowsPlugin[] = []>(
  options: DurableWorkflowsOptions<TPlugins>,
) => DurableWorkflowsEngine & InferEngineExtensions<TPlugins>

export interface DurableWorkflowsOptions<
  TPlugins extends readonly DurableWorkflowsPlugin[] = readonly DurableWorkflowsPlugin[],
> {
  /**
   * The iso4 sandbox the engine executes workflow replays in. Owned by the
   * caller (create/dispose is the application's responsibility). The engine
   * compiles exactly ONE prefix on it — core step shim + all plugin shims —
   * lazily on first execution, and reuses it for every replay.
   */
  sandbox: Sandbox
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
   * in-sandbox shim and a host-side implementation, plus optional engine
   * surface augmentation via `$engine`.
   */
  plugins?: TPlugins
  /**
   * Default retry policy for steps that fail without a per-step override.
   * Steps failed as `permanent` are never retried regardless of policy.
   */
  retry?: RetryPolicy
  /**
   * Error names that permanently fail a step — no retries — without needing
   * a per-step override or a durable-operation verdict.
   */
  nonRetryableErrors?: string[]
  /**
   * Escape hatch when a name list is not enough (e.g. classify by message
   * content or step kind). Takes precedence over `nonRetryableErrors`.
   */
  classifyError?: (error: SerializedError, ctx: { stepId: string, attempt: number }) => ErrorClass
  /**
   * Default iso4 resource limits per replay run. The engine always forces
   * `maxBridgeCalls` high enough for replay bookkeeping (iso4 defaults to 10,
   * which replay-heavy workflows exceed immediately).
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
   * Release the precompiled prefix; in-flight runs finish first.
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
  /**
   * Engine surface augmentation (better-auth style): merged into the engine
   * type returned by `durableWorkflows()`. Implementation lands on the engine
   * object at construction.
   */
  $engine?: Record<string, unknown>
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
 * Identity helper for plugin authors: preserves the literal type of the
 * plugin object (notably `$engine`) so it flows into engine-type inference.
 */
export type DefineWorkflowsPlugin = <const TPlugin extends DurableWorkflowsPlugin>(plugin: TPlugin) => TPlugin

/**
 * Intersection of all `$engine` augmentations carried by the plugin tuple.
 */
export type InferEngineExtensions<TPlugins extends readonly DurableWorkflowsPlugin[]>
  = UnionToIntersection<NonNullable<TPlugins[number]['$engine']>>

type UnionToIntersection<U>
  = (U extends unknown ? (k: U) => void : never) extends ((k: infer I) => void) ? I : unknown

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
export interface DoStepRecord extends StepRecordBase {
  kind: 'do'
  status: 'completed' | 'failed'
  value?: unknown
  error?: SerializedError
}

/**
 * Composite namespace. Only recorded once its body ran to completion (or
 * failed permanently) — until then only its sub-steps exist, linked via
 * `parentId`. Evicting a scope evicts its whole subtree.
 */
export interface ScopeStepRecord extends StepRecordBase {
  kind: 'scope'
  status: 'completed' | 'failed'
  value?: unknown
  error?: SerializedError
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
export interface WaitForEventStepRecord extends StepRecordBase {
  kind: 'waitForEvent'
  status: 'waiting' | 'completed' | 'failed'
  eventType: string
  /**
   * Timeout deadline, if the wait has one.
   */
  wakeAt?: string
  /**
   * The delivered event payload once completed.
   */
  value?: unknown
  error?: SerializedError
}

/**
 * Long-running host work dispatched by a plugin (e.g. an agent prompt).
 */
export interface OperationStepRecord extends StepRecordBase {
  kind: 'operation'
  status: 'waiting' | 'completed' | 'failed'
  /**
   * Idempotency key for dispatch; also how the outer world addresses the
   * completion back to this step.
   */
  operationToken: string
  /**
   * Operation timeout deadline, if any.
   */
  wakeAt?: string
  value?: unknown
  error?: SerializedError
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
