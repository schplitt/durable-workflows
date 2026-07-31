import type { HostGlobals, Prefix, RebindGlobals, ResourceLimits } from '@iso4/sandbox'
import type {
  BoundaryCache,
  BoundaryRecord,
  ExecuteHandle,
  ExecuteResult,
  HostGlobal,
  PendingOperation,
  PerExecuteGlobals,
} from './types'
import { SuspendIsolate } from './suspend-isolate'
import { DURABLE_CALL_GLOBAL, DURABLE_COMMIT_GLOBAL, DURABLE_LOOKUP_GLOBAL } from './shim'

/**
 * Kernel default limits merged UNDER the caller's. Only `maxBridgeCalls` is
 * raised from iso4's default of 10: replay round-trips through a bridge call
 * per durable boundary (cache lookups included), so 10 is exhausted at once.
 */
const DEFAULT_LIMITS: Partial<ResourceLimits> = { maxBridgeCalls: 1000 }

/**
 * A promise that never settles — returned from the bridge after we abort the
 * run, so the sandbox never observes a value for the suspending call.
 */
function never(): Promise<never> {
  return new Promise<never>(() => {})
}

/**
 * Sentinel resolved (never thrown) by a dispatch whose global suspended, so
 * the in-flight dispatch promise always settles and the drain can await it.
 */
const SUSPENDED = Symbol('durable-isolates.suspended')

/**
 * The bridge envelope for a settled durable call.
 */
type CallEnvelope
  = | { ok: true, value: unknown }
    | { ok: false, error: unknown }

export interface ExecuteRunParams {
  prefix: Prefix<HostGlobals, Record<string, never>>
  defaults: Map<string, HostGlobal>
  hydrateLimits: Partial<ResourceLimits> | undefined
  code: string
  cache: BoundaryCache
  globals: PerExecuteGlobals | undefined
  executeLimits: Partial<ResourceLimits> | undefined
}

/**
 * One replay turn. Three bridge globals, each closed over this run's context,
 * back the three primitives:
 *
 * - `__di_call(key, name, args)` — answers the boundary at `key` from the cache
 *   or dispatches the `name` global, recording the result. A global throwing
 *   `SuspendIsolate` writes a waiting record and aborts. A `waiting` record is
 *   NOT terminal on replay — it re-dispatches (that is the one resume path), so
 *   the global (consulting host state) can proceed, suspend again, or throw.
 * - `__di_lookup(key)` — non-memoized read of the live cache (checkpoint check).
 * - `__di_commit(key, value)` — record a completed boundary from the sandbox.
 *
 * Every in-flight global dispatch is tracked and DRAINED before the result is
 * built (on every outcome): a dispatch racing an abort or the run's completion
 * still lands in the cache, while its resolution into a dead isolate is a
 * harmless no-op. `handle.suspend()` aborts the isolate and resolves after the
 * drain — the external-teardown path.
 * @param params the prefix, default globals, code, cache, per-run globals and limits
 */
export function executeRun(params: ExecuteRunParams): ExecuteHandle {
  const { prefix, defaults, hydrateLimits, code, globals, executeLimits } = params

  const registry = new Map(defaults)
  if (globals !== undefined) {
    for (const [name, global] of Object.entries(globals))
      registry.set(name, global)
  }

  const cache: BoundaryCache = { ...params.cache }
  const pending: PendingOperation[] = []
  const inFlight = new Set<Promise<unknown>>()
  const controller = new AbortController()

  let seqNext = 0
  for (const r of Object.values(cache)) {
    if (r.seq >= seqNext)
      seqNext = r.seq + 1
  }

  // Run one global and record the boundary. Always SETTLES (suspension
  // resolves the sentinel) so the drain can await every dispatch.
  const dispatch = async (key: string, name: string, args: unknown[], seq: number): Promise<CallEnvelope | typeof SUSPENDED> => {
    const global = registry.get(name)
    if (global === undefined) {
      // Plain, persistable record (see the catch below); iso4 rebuilds it as an
      // Error in the sandbox when the bridge re-throws it.
      const error = { name: 'Error', message: `durable-isolates: no global for "${name}"` }
      cache[key] = { seq, status: 'failed', error }
      return { ok: false, error }
    }
    try {
      const value = await global(...args)
      cache[key] = { seq, status: 'completed', value }
      return { ok: true, value }
    } catch (e) {
      if (e instanceof SuspendIsolate) {
        cache[key] = { seq, status: 'waiting', name }
        pending.push({ id: key, name, payload: e.payload })
        return SUSPENDED
      }
      // Record the failure as plain, persistable data (the cache is JSON-shaped).
      // An Error's name/message are non-enumerable, so lift them explicitly; the
      // spread carries any own enumerable fields (e.g. `status`). `stack` is
      // dropped — a host stack is noise replayed in the sandbox, where iso4
      // synthesizes a fresh one. The bridge re-throws this, and iso4 (>=0.2.2)
      // rebuilds a real Error from it in the sandbox — no reconstruction shim.
      const error = e instanceof Error ? { ...e, name: e.name, message: e.message } : e
      cache[key] = { seq, status: 'failed', error }
      return { ok: false, error }
    }
  }

  // `__di_lookup` — non-memoized read of the live cache (the checkpoint check).
  const lookupBridge = (...bridgeArgs: unknown[]): unknown => {
    const record: BoundaryRecord | undefined = cache[String(bridgeArgs[0])]
    if (record !== undefined && record.status === 'completed')
      return { hit: true, value: record.value }
    return { hit: false }
  }

  // `__di_commit` — record a completed boundary from the sandbox.
  const commitBridge = (...bridgeArgs: unknown[]): unknown => {
    cache[String(bridgeArgs[0])] = { seq: seqNext++, status: 'completed', value: bridgeArgs[1] }
    return { ok: true }
  }

  // `__di_call` — answer the boundary at `key` from the cache or dispatch its
  // global. Resolves with the boundary's value on success and REJECTS with the
  // recorded error on failure: iso4 (>=0.2.2) delivers a rejecting bridge to the
  // sandbox `catch` faithfully (rebuilt as a real Error with name/message/fields),
  // so no envelope unwrapping or error reconstruction is needed sandbox-side.
  const callBridge = async (...bridgeArgs: unknown[]): Promise<unknown> => {
    const key = String(bridgeArgs[0])
    const name = String(bridgeArgs[1])
    const args: unknown[] = Array.isArray(bridgeArgs[2]) ? bridgeArgs[2] : []

    const existing = cache[key]
    if (existing !== undefined) {
      if (existing.status === 'completed')
        return existing.value
      if (existing.status === 'failed')
        throw existing.error
      // waiting → fall through and re-dispatch (existing seq reused)
    }

    const dispatched = dispatch(key, name, args, existing?.seq ?? seqNext++)
    inFlight.add(dispatched)
    const settled = await dispatched.finally(() => inFlight.delete(dispatched))
    if (settled === SUSPENDED) {
      controller.abort()
      return never()
    }
    if (settled.ok)
      return settled.value
    throw settled.error
  }

  const limits: Partial<ResourceLimits> = { ...DEFAULT_LIMITS, ...hydrateLimits, ...executeLimits }

  const result = (async (): Promise<ExecuteResult> => {
    const result = await prefix.run({
      code,
      globals: {
        [DURABLE_CALL_GLOBAL]: callBridge,
        [DURABLE_LOOKUP_GLOBAL]: lookupBridge,
        [DURABLE_COMMIT_GLOBAL]: commitBridge,
      } as RebindGlobals<HostGlobals>,
      limits,
      signal: controller.signal,
    })

    // Drain: let every in-flight dispatch finish and land in the cache before
    // the result is built — the IO is kept even though the isolate is gone.
    await Promise.allSettled([...inFlight])

    // Suspension is detected by the ABORT — never by catching an in-sandbox
    // throw — so sandbox `try/catch` around a suspending call cannot swallow it.
    if (result.status === 'aborted')
      return { outcome: 'suspended', pending, cache }
    if (result.status === 'completed')
      return { outcome: 'completed', result: result.exports.default, cache }
    return { outcome: 'failed', error: result.error, cache }
  })()

  const suspend = (): Promise<ExecuteResult> => {
    controller.abort()
    return result
  }

  return { result, suspend }
}
