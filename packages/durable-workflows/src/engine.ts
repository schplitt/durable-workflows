/**
 * The durable-workflows engine runtime — the "connector" that ties the authoring
 * surface and the execution host to a persistence store and a definition source,
 * exposing the full instance lifecycle.
 *
 * `durableWorkflows(options)` binds ONE {@link durableWorkflowHost} (its own iso4
 * sandbox, created lazily on the first run) and mounts, once, the caller's plugin
 * shims plus any `alias` re-export modules. Every lifecycle call resolves down to
 * a single replay turn:
 *
 *   load the instance record + its boundary cache from the store
 *     → resolve the pinned definition version via the store's `getDefinition`
 *     → hydrate (or reuse) a runner for that version, mounted with the plugins
 *     → execute one turn with per-run globals carrying the instance metadata
 *     → persist the grown cache and the new instance status
 *     → return a RunOutcome.
 *
 * The engine stores nothing but instances and one opaque cache blob per instance
 * (see {@link WorkflowStore}); retry, scheduling and wake-ups are the caller's
 * job. Resume is plain re-execution: a waiting operation re-dispatches and its
 * global consults host state.
 */
import type { HostGlobal, ModuleDefinition } from 'durable-isolates'
import type { ResourceLimits } from 'durable-isolates/types/iso4'
import type { WorkflowRunner } from './host'
import type {
  DurableGlobal,
  DurableWorkflowsEngine,
  DurableWorkflowsOptions,
  InstanceOutcome,
  InstanceRecord,
  ResolvedDefinition,
  RunOutcome,
  SerializedError,
  WorkflowInstanceHandle,
} from './types'
import { randomUUID } from 'node:crypto'
import { durableWorkflowHost } from './host'

/**
 * Engine sandbox defaults (differing from iso4's own) — see
 * {@link DurableWorkflowsOptions.sandbox}. Replay runs are mostly I/O-idle, so
 * far more concurrent runs than cores is fine.
 */
const DEFAULT_SANDBOX = { maxIsolates: 45 }

/**
 * Engine per-run limit defaults (differing from iso4's and the kernel's) — see
 * {@link DurableWorkflowsOptions.limits}. Merged UNDER `options.limits` and a
 * definition's own `limits`, so explicit settings always win.
 */
const DEFAULT_LIMITS: Partial<ResourceLimits> = {
  maxBridgeCalls: 300,
  wallTimeMs: 600_000,
  cpuTimeMs: 30_000,
}

/**
 * Lift the kernel's recorded failure (an iso4 `RunError` — `name`/`message`/
 * `stack`/`fields`, or any thrown value) into the engine's named
 * {@link SerializedError}. `data` is the error's own fields carried across the
 * bridge; `class` is a plugin-attached verdict (informational only) if the
 * thrown error carried a `permanent`/`transient` one.
 * @param error the kernel's recorded failure value
 */
function toSerializedError(error: unknown): SerializedError {
  if (typeof error !== 'object' || error === null)
    return { name: 'Error', message: String(error) }
  const e = error as { name?: unknown, message?: unknown, stack?: unknown, fields?: unknown }
  const name = typeof e.name === 'string' ? e.name : 'Error'
  const message = typeof e.message === 'string' ? e.message : String(error)
  const data = e.fields
  const rawClass = typeof data === 'object' && data !== null && 'class' in data
    ? (data as { class?: unknown }).class
    : undefined
  const errorClass = rawClass === 'permanent' || rawClass === 'transient' ? rawClass : undefined
  return {
    name,
    message,
    ...(typeof e.stack === 'string' ? { stack: e.stack } : {}),
    ...(data === undefined ? {} : { data }),
    ...(errorClass === undefined ? {} : { class: errorClass }),
  }
}

/**
 * Derive the terminal {@link InstanceOutcome} from a record, or `null` while the
 * instance is still running/waiting.
 * @param record the stored instance record
 */
function outcomeOf(record: InstanceRecord): InstanceOutcome | null {
  if (record.status === 'running' || record.status === 'waiting')
    return null
  const base = {
    instanceId: record.instanceId,
    workflow: record.workflow,
    version: record.version,
    runs: record.runs,
    createdAt: record.createdAt,
    finishedAt: record.updatedAt,
  }
  if (record.status === 'failed')
    return { ...base, status: 'failed', error: record.error }
  if (record.status === 'terminated')
    return { ...base, status: 'terminated' }
  return { ...base, status: 'completed' }
}

export function durableWorkflows(options: DurableWorkflowsOptions): DurableWorkflowsEngine {
  const { store, plugins = {}, alias = {}, limits, onEvent } = options

  const host = durableWorkflowHost({ sandbox: { ...DEFAULT_SANDBOX, ...options.sandbox } })

  // Mount modules built ONCE for the engine's lifetime: each plugin's in-sandbox
  // shim, plus a tiny re-export module per `alias` remapping a core specifier.
  const mountedModules: Record<string, ModuleDefinition> = {}
  for (const [specifier, plugin] of Object.entries(plugins))
    mountedModules[specifier] = { shim: plugin.shim }
  for (const [aliasSpecifier, canonical] of Object.entries(alias)) {
    if (Object.hasOwn(mountedModules, aliasSpecifier))
      throw new Error(`durable-workflows: alias "${aliasSpecifier}" collides with a mounted plugin`)
    // A reserved-specifier alias key is rejected by the host on hydrate; the
    // canonical target is a reserved core module, which is what we re-export.
    mountedModules[aliasSpecifier] = { shim: `export * from '${canonical}'` }
  }

  // Flat operation-name → global map across every plugin. Routing is by name,
  // so two DISTINCT globals under one name are ambiguous — reject that; the
  // same global mounted under two alias specifiers is fine.
  const globalByName = new Map<string, DurableGlobal>()
  for (const plugin of Object.values(plugins)) {
    for (const [name, global] of Object.entries(plugin.globals)) {
      const existing = globalByName.get(name)
      if (existing !== undefined && existing !== global)
        throw new Error(`durable-workflows: two plugins register a global named "${name}"`)
      globalByName.set(name, global)
    }
  }

  // Compiled runners, one per pinned definition version, reused across every run
  // of that version. Keyed by `workflow@version`; the promise is cached so
  // concurrent first runs share one hydrate, and a failed hydrate is evicted.
  const runners = new Map<string, Promise<WorkflowRunner>>()
  function ensureRunner(workflow: string, version: string, def?: ResolvedDefinition): Promise<WorkflowRunner> {
    const key = `${workflow}@${version}`
    let runner = runners.get(key)
    if (runner === undefined) {
      runner = (async () => {
        const resolved = def ?? await store.getDefinition(workflow, version)
        if (resolved === null)
          throw new Error(`durable-workflows: no definition for "${workflow}" @ "${version}"`)
        return host.hydrate({
          workflow: resolved.code,
          plugins: mountedModules,
          limits: { ...DEFAULT_LIMITS, ...limits, ...resolved.limits },
        })
      })().catch((err: unknown) => {
        runners.delete(key)
        throw err
      })
      runners.set(key, runner)
    }
    return runner
  }

  const pendingPromises = new Set<Promise<unknown>>()
  function track<T>(work: Promise<T>): Promise<T> {
    const tracked: Promise<T> = work.finally(() => {
      pendingPromises.delete(tracked)
    })
    pendingPromises.add(tracked)
    return tracked
  }

  // One replay turn against the current record. Resolves the runner, executes
  // with per-run globals, persists the grown cache and the new status, emits
  // events, and returns the outcome. An infrastructure failure (resolve/hydrate/
  // execute/store) rejects WITHOUT transitioning — nothing is persisted past the
  // point it threw.
  async function runTurn(record: InstanceRecord, def?: ResolvedDefinition): Promise<RunOutcome> {
    const { instanceId, workflow, version } = record
    const run = record.runs + 1

    const runner = await ensureRunner(workflow, version, def)
    const cache = (await store.getCache(instanceId)) ?? {}

    const globals: Record<string, HostGlobal> = {}
    for (const [name, global] of globalByName) {
      globals[name] = (...forwarded: unknown[]) => {
        const [stepId, ...payload] = forwarded
        return global({ instanceId, workflow, run, stepId: String(stepId), payload })
      }
    }

    const result = await runner.execute({ input: record.input, cache, globals }).result
    await store.putCache(instanceId, result.cache)

    // Emit a step event for every boundary that settled or changed this run.
    for (const [stepId, boundary] of Object.entries(result.cache)) {
      const prev = cache[stepId]
      if (prev === undefined || prev.status !== boundary.status)
        onEvent?.({ type: 'step', instanceId, stepId, status: boundary.status, run })
    }

    const now = new Date().toISOString()
    const base = { instanceId, workflow, version, input: record.input, runs: run, createdAt: record.createdAt, updatedAt: now }

    let next: InstanceRecord
    let outcome: RunOutcome
    if (result.outcome === 'completed') {
      next = { ...base, status: 'completed' }
      outcome = { instanceId, run, status: 'completed' }
    } else if (result.outcome === 'suspended') {
      next = { ...base, status: 'waiting' }
      outcome = {
        instanceId,
        run,
        status: 'waiting',
        pending: result.pending.map((p) => ({ stepId: p.id, operation: p.name, payload: p.payload })),
      }
    } else {
      const error = toSerializedError(result.error)
      next = { ...base, status: 'failed', error }
      outcome = { instanceId, run, status: 'failed', error }
    }

    await store.updateInstance(next)
    onEvent?.({ type: 'instance', instanceId, status: next.status, run })
    return outcome
  }

  return {
    pendingPromises,

    create: (workflow, input, opts) => track((async () => {
      const instanceId = opts?.instanceId ?? randomUUID()
      const existing = await store.getInstance(instanceId)
      if (existing !== null) {
        // Idempotent creation: an active instance re-runs (harmless replay,
        // accurate pending), a terminal one returns its recorded outcome.
        if (existing.status === 'running' || existing.status === 'waiting')
          return runTurn(existing)
        if (existing.status === 'completed')
          return { instanceId, run: existing.runs, status: 'completed' }
        if (existing.status === 'failed')
          return { instanceId, run: existing.runs, status: 'failed', error: existing.error }
        throw new Error(`durable-workflows: instance "${instanceId}" is terminated`)
      }

      const def = await store.getDefinition(workflow, opts?.version)
      if (def === null) {
        throw new Error(
          `durable-workflows: no definition for "${workflow}"${opts?.version ? ` @ "${opts.version}"` : ''}`,
        )
      }
      const now = new Date().toISOString()
      const record: InstanceRecord = {
        instanceId,
        workflow,
        version: def.version,
        input,
        runs: 0,
        status: 'running',
        createdAt: now,
        updatedAt: now,
      }
      await store.createInstance(record)
      onEvent?.({ type: 'instance', instanceId, status: 'running', run: 0 })
      return runTurn(record, def)
    })()),

    get: async (instanceId): Promise<WorkflowInstanceHandle | null> => {
      const record = await store.getInstance(instanceId)
      if (record === null)
        return null
      return {
        id: instanceId,
        status: async () => {
          const current = await store.getInstance(instanceId)
          if (current === null)
            throw new Error(`durable-workflows: instance "${instanceId}" no longer exists`)
          return current.status
        },
        outcome: async () => {
          const current = await store.getInstance(instanceId)
          if (current === null)
            throw new Error(`durable-workflows: instance "${instanceId}" no longer exists`)
          return outcomeOf(current)
        },
      }
    },

    continueWorkflow: (instanceId) => track((async () => {
      const record = await store.getInstance(instanceId)
      if (record === null)
        throw new Error(`durable-workflows: no instance "${instanceId}"`)
      if (record.status === 'terminated')
        throw new Error(`durable-workflows: instance "${instanceId}" is terminated`)
      return runTurn(record)
    })()),

    terminate: (instanceId) => track((async () => {
      const record = await store.getInstance(instanceId)
      if (record === null)
        throw new Error(`durable-workflows: no instance "${instanceId}"`)
      if (record.status === 'terminated')
        return
      const now = new Date().toISOString()
      await store.updateInstance({
        instanceId,
        workflow: record.workflow,
        version: record.version,
        input: record.input,
        runs: record.runs,
        status: 'terminated',
        createdAt: record.createdAt,
        updatedAt: now,
      })
      onEvent?.({ type: 'instance', instanceId, status: 'terminated', run: record.runs })
    })()),

    evict: (instanceId, stepId) => track((async () => {
      const record = await store.getInstance(instanceId)
      if (record === null)
        throw new Error(`durable-workflows: no instance "${instanceId}"`)
      if (record.status === 'terminated')
        throw new Error(`durable-workflows: instance "${instanceId}" is terminated`)
      const cache = (await store.getCache(instanceId)) ?? {}
      const target = cache[stepId]
      if (target === undefined)
        throw new Error(`durable-workflows: no boundary "${stepId}" in instance "${instanceId}"`)
      // Delete the boundary, everything recorded after it (prefix by seq), AND
      // its whole subtree (by key-prefix). The subtree matters because a scope's
      // children commit BEFORE the scope itself, so they carry a lower seq — a
      // seq-only prune would leave them cached and the replayed body would reuse
      // them instead of truly re-executing.
      const pruned = Object.fromEntries(
        Object.entries(cache).filter(([key, boundary]) =>
          boundary.seq < target.seq && key !== stepId && !key.startsWith(`${stepId}/`),
        ),
      )
      await store.putCache(instanceId, pruned)
      return runTurn(record)
    })()),

    restart: (instanceId) => track((async () => {
      const record = await store.getInstance(instanceId)
      if (record === null)
        throw new Error(`durable-workflows: no instance "${instanceId}"`)
      if (record.status === 'terminated')
        throw new Error(`durable-workflows: instance "${instanceId}" is terminated`)
      await store.putCache(instanceId, {})
      return runTurn(record)
    })()),

    dispose: async () => {
      await Promise.allSettled([...pendingPromises])
      await host.dispose()
    },
  }
}
