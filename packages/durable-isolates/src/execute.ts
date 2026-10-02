import type { HostGlobals, Prefix, RebindGlobals, ResourceLimits } from '@iso4/sandbox'
import type {
  BoundaryCache,
  BoundaryRecord,
  ExecuteHandle,
  ExecuteResult,
  HostGlobal,
  NonJsonCallRejection,
  PendingOperation,
  PerExecuteGlobals,
  Rejection,
} from './types'
import { SuspendIsolate } from './suspend-isolate'
import { DURABLE_CALL_GLOBAL, DURABLE_COMMIT_GLOBAL, DURABLE_LOOKUP_GLOBAL } from './shim'
import { NonJsonValueError, toJson } from './json'

/**
 * The rule every rejection message ends with — written for whoever wrote the
 * program (an author or a model), so the fix is stated, not just the fault.
 */
const JSON_RULE = 'Only JSON values (null, booleans, finite numbers, strings, arrays, plain objects) can cross a durable boundary; convert the value before it reaches one.'

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
 * Sentinel resolved (never thrown) by a dispatch that ended the run — its
 * global suspended, or produced a value the run was rejected over — so the
 * in-flight dispatch promise always settles and the drain can await it.
 */
const ABORTED = Symbol('durable-isolates.aborted')

/**
 * The bridge envelope for a settled durable call.
 */
type CallEnvelope
  = | { ok: true, value: unknown }
    | { ok: false, error: unknown }

export interface ExecuteRunParams {
  prefix: Prefix<HostGlobals, Record<string, never>>
  defaults: Map<string, HostGlobal>
  prepareLimits: Partial<ResourceLimits> | undefined
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
 * Every value entering the cache — call args, a global's return or throw, a
 * committed value — is admitted through `toJson`: JSON-normalized so the first
 * run sees what a replay sees, and REJECTING the run on a value JSON cannot
 * carry. A rejection aborts the isolate like a suspension does (the violating
 * bridge call never settles, so sandbox `try/catch` cannot swallow it), keeps
 * the first violation, and records nothing at the violating key.
 *
 * Every in-flight global dispatch is tracked and DRAINED before the result is
 * built (on every outcome): a dispatch racing an abort or the run's completion
 * still lands in the cache, while its resolution into a dead isolate is a
 * harmless no-op. `handle.suspend()` aborts the isolate and resolves after the
 * drain — the external-teardown path.
 * @param params the prefix, default globals, code, cache, per-run globals and limits
 */
export function executeRun(params: ExecuteRunParams): ExecuteHandle {
  const { prefix, defaults, prepareLimits, code, globals, executeLimits } = params

  const registry = new Map(defaults)
  if (globals !== undefined) {
    for (const [name, global] of Object.entries(globals))
      registry.set(name, global)
  }

  // Null-prototype so EVERY key is a plain entry: on an ordinary object a key
  // named `__proto__` would hit the prototype setter (never persisted, and the
  // committed object would then answer every other key by inheritance), and
  // `constructor` / `toString` would read inherited functions. `Object.assign`
  // onto a null-prototype target defines own properties, so an own `__proto__`
  // entry in the caller's cache is carried over as data.
  const cache: BoundaryCache = Object.assign(Object.create(null) as BoundaryCache, params.cache)
  const pending: PendingOperation[] = []
  const inFlight = new Set<Promise<unknown>>()
  const controller = new AbortController()

  let seqNext = 0
  for (const r of Object.values(cache)) {
    if (r.seq >= seqNext)
      seqNext = r.seq + 1
  }

  // The first violation that rejected this run (later ones are dropped: the
  // isolate is already being aborted).
  let rejection: Rejection | undefined

  // Admit a value into the cache: JSON-normalize it, or REJECT the run over it.
  // `at` says where the value came from, for the rejection record and message.
  const admit = (
    value: unknown,
    at: { source: 'commit', key: string } | { source: NonJsonCallRejection['source'], key: string, name: string },
  ): { ok: true, value: unknown } | { ok: false } => {
    try {
      return { ok: true, value: toJson(value) }
    } catch (e) {
      if (!(e instanceof NonJsonValueError))
        throw e
      // The message carries no sandbox-written text (no key, no name — those
      // are in the structured fields): `path` keys are identifier-only or
      // JSON-quoted and `found` is a V8 or host class name.
      const where = at.source === 'args'
        ? 'in an argument of a durable call'
        : at.source === 'result' ? 'in what a global returned' : at.source === 'error' ? 'in what a global threw' : 'in a committed value'
      const message = `durable-isolates: non-JSON value ${where}: ${e.found} at ${e.path}. ${JSON_RULE}`
      rejection ??= { reason: 'non-json', ...at, path: e.path, found: e.found, message }
      controller.abort()
      return { ok: false }
    }
  }

  // Run one global and record the boundary. Every record a dispatch writes
  // carries the call's `name` and `args` (what the shim forwarded), so the
  // history says WHAT was asked at each key, not only what came back. Always
  // SETTLES (suspension and rejection resolve the sentinel) so the drain can
  // await every dispatch.
  const dispatch = async (key: string, name: string, args: unknown[], seq: number): Promise<CallEnvelope | typeof ABORTED> => {
    const global = registry.get(name)
    if (global === undefined) {
      // Plain, persistable record (see the catch below); iso4 rebuilds it as an
      // Error in the sandbox when the bridge re-throws it.
      const error = { name: 'Error', message: `durable-isolates: no global for "${name}"` }
      cache[key] = { seq, status: 'failed', name, args, error }
      return { ok: false, error }
    }
    let returned: unknown
    try {
      returned = await global(...args)
    } catch (e) {
      if (e instanceof SuspendIsolate) {
        cache[key] = { seq, status: 'waiting', name, args }
        pending.push({ id: key, name, payload: e.payload })
        return ABORTED
      }
      // Record the failure as JSON. An Error is reduced to name + message (its
      // own fields and the host stack are dropped: the cache is text a model
      // reads back, and iso4 synthesizes a fresh stack in the sandbox). The
      // bridge re-throws this and iso4 (>=0.2.2) rebuilds a real Error from it
      // in the sandbox — no reconstruction shim. A non-Error throw is admitted
      // like any other value.
      const admitted = e instanceof Error ? { ok: true as const, value: { name: String(e.name), message: String(e.message) } } : admit(e, { source: 'error', key, name })
      if (!admitted.ok)
        return ABORTED
      cache[key] = { seq, status: 'failed', name, args, error: admitted.value }
      return { ok: false, error: admitted.value }
    }
    const admitted = admit(returned, { source: 'result', key, name })
    if (!admitted.ok)
      return ABORTED
    cache[key] = { seq, status: 'completed', name, args, value: admitted.value }
    return { ok: true, value: admitted.value }
  }

  // `__di_lookup` — non-memoized read of the live cache (the checkpoint check).
  const lookupBridge = (...bridgeArgs: unknown[]): unknown => {
    const record: BoundaryRecord | undefined = cache[String(bridgeArgs[0])]
    if (record !== undefined && record.status === 'completed')
      return { hit: true, value: record.value }
    return { hit: false }
  }

  // `__di_commit` — record a completed boundary from the sandbox. Only an ack
  // goes back: the shim JSON-normalizes its own copy (the same rules as
  // `toJson`, on a value this admission has just proven JSON-clean), which is
  // far cheaper than echoing a large value across the bridge again.
  const commitBridge = (...bridgeArgs: unknown[]): unknown => {
    const key = String(bridgeArgs[0])
    const admitted = admit(bridgeArgs[1], { source: 'commit', key })
    if (!admitted.ok)
      return never()
    cache[key] = { seq: seqNext++, status: 'completed', value: admitted.value }
    return { ok: true }
  }

  // `__di_call` — answer the boundary at `key` from the cache or dispatch its
  // global. Resolves with the boundary's value on success and REJECTS with the
  // recorded error on failure: iso4 (>=0.2.2) delivers a rejecting bridge to the
  // sandbox `catch` faithfully (rebuilt as a real Error with name/message),
  // so no envelope unwrapping or error reconstruction is needed sandbox-side.
  const callBridge = async (...bridgeArgs: unknown[]): Promise<unknown> => {
    const key = String(bridgeArgs[0])
    const name = String(bridgeArgs[1])

    // Args are admitted BEFORE the lookup: a non-JSON argument is a violation
    // even at a key the cache would have answered.
    const admitted = admit(Array.isArray(bridgeArgs[2]) ? bridgeArgs[2] : [], { source: 'args', key, name })
    if (!admitted.ok)
      return never()
    const args = admitted.value as unknown[]

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
    if (settled === ABORTED) {
      controller.abort()
      return never()
    }
    if (settled.ok)
      return settled.value
    throw settled.error
  }

  const limits: Partial<ResourceLimits> = { ...DEFAULT_LIMITS, ...prepareLimits, ...executeLimits }

  const result = (async (): Promise<ExecuteResult> => {
    const result = await prefix.execute({
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

    // Hand back an ordinary object (spread defines own properties, so a
    // `__proto__` entry stays data) — callers and stores never see the
    // null-prototype working copy.
    const grown: BoundaryCache = { ...cache }

    // A rejection wins over everything else this turn: the run is dead however
    // the isolate ended (normally aborted by us; completed only if the program
    // never awaited the violating call).
    if (rejection !== undefined)
      return { outcome: 'rejected', rejection, cache: grown, run: result }
    // Suspension is detected by the ABORT — never by catching an in-sandbox
    // throw — so sandbox `try/catch` around a suspending call cannot swallow it.
    if (result.status === 'aborted')
      return { outcome: 'suspended', pending, cache: grown, run: result }
    if (result.status === 'completed')
      return { outcome: 'completed', result: result.exports.default, cache: grown, run: result }
    return { outcome: 'failed', error: result.error, cache: grown, run: result }
  })()

  const suspend = (): Promise<ExecuteResult> => {
    controller.abort()
    return result
  }

  return { result, suspend }
}
