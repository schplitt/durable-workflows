import type { HostGlobals, Prefix, RebindGlobals, ResourceLimits } from '@iso4/sandbox'
import type {
  BoundaryCache,
  BoundaryRecord,
  DivergenceRejection,
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
import { stableStringify } from './json'

/**
 * The rule a divergence message ends with — what the author (or model) must
 * change for replays to line up.
 */
const DETERMINISM_RULE = 'Durable calls must be deterministic across runs: keep them in the same order, give each parallel branch that makes more than one durable call its own boundary(), and wrap nondeterministic inputs such as time, random values or external state in boundary() so they are recorded once.'

/**
 * The rule a protocol-fault message ends with.
 */
const PROTOCOL_RULE = 'Reach the kernel through the durable-isolates:internal module, never through its bridge globals directly.'

/**
 * The rule every rejection message ends with — written for whoever wrote the
 * program (an author or a model), so the fix is stated, not just the fault.
 */
const JSON_RULE = 'Only values JSON can write may cross a durable boundary: no bigint, no circular structure, no toJSON or getter that throws; convert the value before it reaches one.'

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
 * committed value — crosses as JSON: sandbox values arrive as text the shim
 * wrote with `JSON.stringify` on the program's real object, host values are
 * stringified here, and everything is `JSON.parse`d before it is stored or
 * handed on, so the first run sees what a replay sees. What JSON refuses (a
 * bigint, a cycle) REJECTS the run: the isolate is aborted like a suspension
 * (the violating bridge call never settles, so sandbox `try/catch` cannot
 * swallow it), the first violation is kept, nothing is recorded at the key.
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

  // One pass over the history: the next `seq`, and which key holds each
  // position (`scope` + `order`) for the position check. Both grow as this run
  // records.
  let seqNext = 0
  const keyAtPosition = new Map<string, string>()
  const positionId = (scope: string, order: number): string => `${order}\u0000${scope}`
  for (const k in cache) {
    const r = cache[k]!
    if (r.seq >= seqNext)
      seqNext = r.seq + 1
    if (r.order !== undefined && r.scope !== undefined)
      keyAtPosition.set(positionId(r.scope, r.order), k)
  }

  // The first violation that rejected this run (later ones are dropped: the
  // isolate is already being aborted).
  let rejection: Rejection | undefined

  // The position check. An operation is only answered for the position it was
  // recorded at, and a position already held by another key cannot be taken by
  // a new one (that is how a swapped order or a flipped branch shows up even
  // when each key still matches). Returns the record that conflicts.
  const positionConflict = (key: string, scope: string, order: number, existing: BoundaryRecord | undefined): { key: string, record: BoundaryRecord } | undefined => {
    if (existing !== undefined)
      return existing.scope === scope && existing.order === order ? undefined : { key, record: existing }
    const other = keyAtPosition.get(positionId(scope, order))
    return other === undefined ? undefined : { key: other, record: cache[other]! }
  }

  // Reject the run as a replay divergence: the program's durable operations no
  // longer line up with the history, so no answer from the cache can be
  // trusted. `recorded` is handed out as a copy so a caller editing the
  // rejection (redacting it for a log, say) cannot touch the history it
  // persists. The message carries no program-written text.
  const diverge = (
    mismatch: DivergenceRejection['mismatch'],
    key: string,
    attempted: DivergenceRejection['attempted'],
    at: { key: string, record: BoundaryRecord },
  ): Promise<never> => {
    const what = mismatch === 'order'
      ? 'the program issued a durable operation at a different position than recorded'
      : mismatch === 'name'
        ? 'at a recorded boundary the program asked for a different operation'
        : mismatch === 'args'
          ? 'at a recorded boundary the program asked for the same operation with different arguments'
          : 'at a recorded boundary the program asked for a call where the record holds no call to compare (a checkpoint, or a record from an older kernel)'
    const message = `durable-isolates: replay divergence: ${what}. ${DETERMINISM_RULE}`
    const recorded: DivergenceRejection['recorded'] = {
      key: at.key,
      ...(at.record.order === undefined || at.record.scope === undefined ? {} : { scope: at.record.scope, order: at.record.order }),
      ...(at.record.name === undefined || at.record.args === undefined ? {} : { name: at.record.name, args: structuredClone(at.record.args) }),
    }
    rejection ??= { reason: 'divergence', key, mismatch, recorded, attempted, message }
    controller.abort()
    return never()
  }

  // A bridge payload the shim never sends (a program calling a bridge global
  // directly): refuse the run as a protocol fault.
  const protocolFault = (detail: string, at: { source: 'commit', key: string } | { source: 'args', key: string, name: string }): Promise<never> => {
    rejection ??= { reason: 'protocol', ...at, detail, message: `durable-isolates: a bridge payload was not what the kernel shim sends. ${PROTOCOL_RULE}` }
    controller.abort()
    return never()
  }

  // Admit a value into the cache as JSON, or REJECT the run over it. A host
  // value (`{ value }`) is stringified here; a sandbox value (`{ text, invalid }`)
  // was stringified by the shim on the program's real object and arrives as
  // text, or as the serializer's complaint. Either way the stored value is what
  // `JSON.parse` gives back. `at` says where the value came from.
  const admit = (
    input: { value: unknown } | { text: unknown, invalid: unknown },
    at: { source: 'commit', key: string } | { source: NonJsonCallRejection['source'], key: string, name: string },
  ): { ok: true, value: unknown } | { ok: false, protocol?: string } => {
    let text: string | undefined
    let detail: string | undefined
    if ('value' in input) {
      try {
        text = JSON.stringify(input.value)
      } catch (e) {
        // Reading the serializer's complaint can itself throw (a null-prototype
        // throw, a `message` getter that throws) — this must never escape.
        try {
          detail = e instanceof Error ? String(e.message) : String(e)
        } catch {
          detail = 'unserializable value'
        }
      }
    } else if (typeof input.invalid === 'string') {
      detail = input.invalid
    } else if (input.text === undefined || typeof input.text === 'string') {
      text = input.text
    } else {
      return { ok: false, protocol: 'not JSON text' }
    }
    if (detail === undefined) {
      try {
        return { ok: true, value: text === undefined ? undefined : JSON.parse(text) }
      } catch {
        return { ok: false, protocol: 'malformed JSON text' }
      }
    }
    // The message carries no program-written text (the key, the name and the
    // serializer's `detail`, which may quote property names, are in the
    // structured fields).
    const where = at.source === 'args'
      ? 'in an argument of a durable call'
      : at.source === 'result' ? 'in what a global returned' : at.source === 'error' ? 'in what a global threw' : 'in a committed value'
    const message = `durable-isolates: a value ${where} cannot be written as JSON. ${JSON_RULE}`
    // `detail` comes from a serializer (sandbox-side for args/commits): bounded.
    rejection ??= { reason: 'non-json', ...at, detail: detail.slice(0, 1024), message }
    controller.abort()
    return { ok: false }
  }

  // Run one global and record the boundary. Every record a dispatch writes
  // carries the call's `name` and `args` (what the shim forwarded), so the
  // history says WHAT was asked at each key, not only what came back. Always
  // SETTLES (suspension and rejection resolve the sentinel) so the drain can
  // await every dispatch.
  const dispatch = async (key: string, name: string, args: unknown[], argsText: string, scope: string, order: number, seq: number): Promise<CallEnvelope | typeof ABORTED> => {
    keyAtPosition.set(positionId(scope, order), key)
    const global = registry.get(name)
    if (global === undefined) {
      // Plain, persistable record (see the catch below); iso4 rebuilds it as an
      // Error in the sandbox when the bridge re-throws it.
      const error = { name: 'Error', message: `durable-isolates: no global for "${name}"` }
      cache[key] = { seq, status: 'failed', name, args, scope, order, error }
      return { ok: false, error }
    }
    // The global gets its OWN copy: `args` is what the record stores and what
    // every replay is compared against, so a global that defaults or edits an
    // options object in place must not rewrite the history under itself. A
    // second parse of the same text is the cheapest private copy.
    const ownArgs = JSON.parse(argsText) as unknown[]
    let returned: unknown
    try {
      returned = await global(...ownArgs)
    } catch (e) {
      if (e instanceof SuspendIsolate) {
        cache[key] = { seq, status: 'waiting', name, args, scope, order }
        pending.push({ id: key, name, payload: e.payload })
        return ABORTED
      }
      // Record the failure as JSON. An Error is reduced to name + message (its
      // own fields and the host stack are dropped: the cache is text a model
      // reads back, and iso4 synthesizes a fresh stack in the sandbox). The
      // bridge re-throws this and iso4 (>=0.2.2) rebuilds a real Error from it
      // in the sandbox — no reconstruction shim. `Error.isError` checks the
      // internal slot, so an Error from another realm or a DOMException counts
      // and no getter or Proxy trap runs; a `name`/`message` getter that throws
      // falls back to a fixed text (this catch must always settle). A non-Error
      // throw is admitted like any other value.
      let admitted: { ok: true, value: unknown } | { ok: false }
      if (Error.isError(e)) {
        try {
          const { name: errorName, message } = e as Error
          admitted = { ok: true, value: { name: String(errorName), message: String(message) } }
        } catch {
          admitted = { ok: true, value: { name: 'Error', message: 'unreadable error' } }
        }
      } else {
        admitted = admit({ value: e }, { source: 'error', key, name })
      }
      if (!admitted.ok)
        return ABORTED
      // A thrown symbol, function or `undefined` has no JSON reading at all;
      // give it a fixed shape rather than recording an absent error.
      const error = admitted.value === undefined ? { name: 'Error', message: 'non-JSON throw' } : admitted.value
      cache[key] = { seq, status: 'failed', name, args, scope, order, error }
      return { ok: false, error }
    }
    const admitted = admit({ value: returned }, { source: 'result', key, name })
    if (!admitted.ok)
      return ABORTED
    cache[key] = { seq, status: 'completed', name, args, scope, order, value: admitted.value }
    return { ok: true, value: admitted.value }
  }

  // `__di_lookup(key, order?, scope?)` — non-memoized read of the live cache
  // (the checkpoint check). With a position (a `boundary()`), the position
  // check applies; a raw `durableLookup` without one is a plain read.
  const lookupBridge = (...bridgeArgs: unknown[]): unknown => {
    const key = String(bridgeArgs[0])
    const [order, scope] = [bridgeArgs[1], bridgeArgs[2]]
    const record: BoundaryRecord | undefined = cache[key]
    if (order !== undefined || scope !== undefined) {
      if (typeof order !== 'number' || typeof scope !== 'string')
        return protocolFault('malformed position', { source: 'commit', key })
      const conflict = positionConflict(key, scope, order, record)
      if (conflict !== undefined)
        return diverge('order', key, { scope, order }, conflict)
    }
    if (record !== undefined && record.status === 'completed')
      return { hit: true, value: record.value }
    return { hit: false }
  }

  // `__di_commit(key, text, invalid, order, scope)` — record a completed
  // boundary from the sandbox. Only an ack goes back: the shim parses its own
  // copy of the same text, so what the program sees is what the cache holds.
  const commitBridge = (...bridgeArgs: unknown[]): unknown => {
    const key = String(bridgeArgs[0])
    const admitted = admit({ text: bridgeArgs[1], invalid: bridgeArgs[2] }, { source: 'commit', key })
    if (!admitted.ok)
      return admitted.protocol === undefined ? never() : protocolFault(admitted.protocol, { source: 'commit', key })
    const [order, scope] = [bridgeArgs[3], bridgeArgs[4]]
    if (order === undefined && scope === undefined) {
      // A raw `durableCommit`: outside the position check, like a raw lookup.
      cache[key] = { seq: seqNext++, status: 'completed', value: admitted.value }
      return { ok: true }
    }
    if (typeof order !== 'number' || typeof scope !== 'string')
      return protocolFault('malformed position', { source: 'commit', key })
    const conflict = positionConflict(key, scope, order, cache[key])
    if (conflict !== undefined)
      return diverge('order', key, { scope, order }, conflict)
    cache[key] = { seq: seqNext++, status: 'completed', scope, order, value: admitted.value }
    keyAtPosition.set(positionId(scope, order), key)
    return { ok: true }
  }

  // `__di_call(key, name, argsText, invalid, order, scope)` — answer the boundary at `key`
  // from the cache or dispatch its global. Resolves with the boundary's value
  // on success (a JSON value, carried to the sandbox as is) and REJECTS with the
  // recorded error on failure: iso4 (>=0.2.2) delivers a rejecting bridge to the
  // sandbox `catch` faithfully (rebuilt as a real Error with name/message),
  // so no envelope unwrapping or error reconstruction is needed sandbox-side.
  const callBridge = async (...bridgeArgs: unknown[]): Promise<unknown> => {
    const key = String(bridgeArgs[0])
    const name = String(bridgeArgs[1])

    // Args are admitted BEFORE the lookup: an argument JSON refuses is a
    // violation even at a key the cache would have answered.
    const admitted = admit({ text: bridgeArgs[2], invalid: bridgeArgs[3] }, { source: 'args', key, name })
    if (!admitted.ok)
      return admitted.protocol === undefined ? never() : protocolFault(admitted.protocol, { source: 'args', key, name })
    // The shim always sends an array and a position; anything else is a
    // program calling the bridge global directly.
    if (!Array.isArray(admitted.value))
      return protocolFault('args are not a JSON array', { source: 'args', key, name })
    const args = admitted.value
    const [order, scope] = [bridgeArgs[4], bridgeArgs[5]]
    if (typeof order !== 'number' || typeof scope !== 'string')
      return protocolFault('missing issue position', { source: 'args', key, name })

    const existing = cache[key]
    // Position first: the call must sit where the history has it.
    const conflict = positionConflict(key, scope, order, existing)
    if (conflict !== undefined)
      return diverge('order', key, { name, args, scope, order }, conflict)
    if (existing !== undefined) {
      // A recorded key is only answered (or re-thrown, or re-dispatched) for
      // the SAME call it was recorded for.
      const mismatch = existing.name === undefined || existing.args === undefined
        ? 'no-call'
        // Fast path: the sandbox's own text usually reproduces the recorded args
        // byte for byte; the sorted-key compare only runs when it does not.
        : existing.name !== name ? 'name' : JSON.stringify(existing.args) !== bridgeArgs[2] && stableStringify(existing.args) !== stableStringify(args) ? 'args' : undefined
      if (mismatch !== undefined)
        return diverge(mismatch, key, { name, args, scope, order }, { key, record: existing })
      if (existing.status === 'completed')
        return existing.value
      if (existing.status === 'failed')
        throw existing.error
      // waiting → fall through and re-dispatch (existing seq reused)
    }

    const dispatched = dispatch(key, name, args, bridgeArgs[2] as string, scope, order, existing?.seq ?? seqNext++)
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
    // A waiting record written this run also wins over the isolate finishing
    // (a program that never awaited the suspending call, or threw afterwards):
    // the operation is parked in host state and must be reported, and a
    // resume answers the finished parts from the cache anyway.
    if (result.status === 'aborted' || pending.length > 0)
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
