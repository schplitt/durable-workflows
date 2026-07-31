import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createSafeFetch } from '@iso4/fetch'
import type { BoundaryCache, DurableIsolates, DurableIsolatesRunner, PerExecuteGlobals } from '../src'
import { durableIsolates, SuspendIsolate } from '../src'

// A mounted module whose shim forms the key IN THE SANDBOX two ways:
//  - `call(name, …)` auto-keys with an in-sandbox per-name counter (mc8yp style)
//  - `step(key, name, …)` takes the key directly (workflow-author style)
const SHIM = /* js */ `
import { durableCall } from 'durable-isolates:internal'
const counters = Object.create(null)
export const call = (name, ...args) => {
  const n = (counters[name] = (counters[name] || 0) + 1) - 1
  return durableCall(name + '#' + n, name, ...args)
}
export const step = (key, name, ...args) => durableCall(key, name, ...args)
`

let host: DurableIsolates
let runner: DurableIsolatesRunner

beforeAll(async () => {
  host = durableIsolates({ sandbox: { maxIsolates: 4 } })
  runner = await host.hydrate({ modules: { tools: { shim: SHIM } } })
}, 30_000)

afterAll(async () => {
  await host.dispose()
})

describe('durable calls (key from the sandbox)', () => {
  test('auto-keyed call: completes, caches; global runs once across replays', async () => {
    let pings = 0
    const globals: PerExecuteGlobals = {
      ping: () => {
        pings += 1
        return 'pong'
      },
    }
    const code = `import { call } from 'tools'; export default await call('ping', {})`

    const r1 = await runner.execute({ code, cache: {}, globals }).result
    expect(r1.outcome).toBe('completed')
    if (r1.outcome !== 'completed')
      return
    expect(r1.result).toBe('pong')
    expect(Object.keys(r1.cache)).toEqual(['ping#0'])
    expect(pings).toBe(1)

    const r2 = await runner.execute({ code, cache: r1.cache, globals }).result
    expect(r2.outcome).toBe('completed')
    if (r2.outcome !== 'completed')
      return
    expect(r2.result).toBe('pong')
    expect(pings).toBe(1) // cached — global NOT re-invoked
  }, 15_000)

  test('explicit key via step(): the sandbox-supplied key is the boundary id', async () => {
    let runs = 0
    const globals: PerExecuteGlobals = {
      compute: () => {
        runs += 1
        return 42
      },
    }
    const code = `import { step } from 'tools'; export default await step('load-report', 'compute', {})`

    const r1 = await runner.execute({ code, cache: {}, globals }).result
    expect(r1.outcome).toBe('completed')
    if (r1.outcome !== 'completed')
      return
    expect(r1.result).toBe(42)
    expect(Object.keys(r1.cache)).toEqual(['load-report'])

    const r2 = await runner.execute({ code, cache: r1.cache, globals }).result
    expect(r2.outcome).toBe('completed')
    expect(runs).toBe(1) // cached by the explicit key
  }, 15_000)

  test('forwards all args; repeated names get distinct keys', async () => {
    const seen: unknown[] = []
    const globals: PerExecuteGlobals = {
      echo: (a, b) => {
        seen.push([a, b])
        return { a, b }
      },
    }
    const code = `import { call } from 'tools'
      const x = await call('echo', 'p', 1)
      const y = await call('echo', 'q', 2)
      export default [x, y]`

    const r1 = await runner.execute({ code, cache: {}, globals }).result
    expect(r1.outcome).toBe('completed')
    if (r1.outcome !== 'completed')
      return
    expect(r1.result).toEqual([{ a: 'p', b: 1 }, { a: 'q', b: 2 }])
    expect(Object.keys(r1.cache)).toEqual(['echo#0', 'echo#1'])
    expect(seen).toEqual([['p', 1], ['q', 2]])
  }, 15_000)

  test('parallel leaf calls: keys form in source order, both settle', async () => {
    const globals: PerExecuteGlobals = {
      echo: async (v) => {
        await new Promise((resolve) => {
          setTimeout(resolve, 20)
        })
        return v
      },
    }
    const code = `import { call } from 'tools'
      const [a, b] = await Promise.all([call('echo', 'first'), call('echo', 'second')])
      export default [a, b]`

    const r1 = await runner.execute({ code, cache: {}, globals }).result
    expect(r1.outcome).toBe('completed')
    if (r1.outcome !== 'completed')
      return
    expect(r1.result).toEqual(['first', 'second'])
    // keys were formed synchronously in source order, regardless of completion order
    expect(r1.cache['echo#0']).toMatchObject({ status: 'completed', value: 'first' })
    expect(r1.cache['echo#1']).toMatchObject({ status: 'completed', value: 'second' })
  }, 15_000)

  test('a per-execute global overrides the module default (per-run auth)', async () => {
    const withDefault = await host.hydrate({
      modules: { tools: { shim: SHIM, globals: { who: () => 'default' } } },
    })
    const code = `import { call } from 'tools'; export default await call('who', {})`

    const def = await withDefault.execute({ code, cache: {} }).result
    expect(def.outcome === 'completed' && def.result).toBe('default')

    const overridden = await withDefault.execute({ code, cache: {}, globals: { who: () => 'per-run' } }).result
    expect(overridden.outcome === 'completed' && overridden.result).toBe('per-run')
  }, 15_000)
})

describe('suspension (SuspendIsolate + re-dispatch resume)', () => {
  test('explicit gate: the global returns the stored answer on re-dispatch', async () => {
    let loads = 0
    let approves = 0
    let answer: { approved: boolean } | undefined
    const globals: PerExecuteGlobals = {
      load: () => {
        loads += 1
        return { title: 't' }
      },
      approve: () => {
        approves += 1
        if (answer === undefined)
          throw new SuspendIsolate({ need: 'approval' })
        return answer
      },
    }
    const code = `import { call } from 'tools'
      const a = await call('load', {})
      const b = await call('approve', { subject: a.title })
      export default { a, b }`

    const r1 = await runner.execute({ code, cache: {}, globals }).result
    expect(r1.outcome).toBe('suspended')
    if (r1.outcome !== 'suspended')
      return
    const [pending] = r1.pending
    if (pending === undefined)
      throw new Error('expected a pending operation')
    expect(pending.id).toBe('approve#0')
    expect(pending.name).toBe('approve')
    expect(pending.payload).toEqual({ need: 'approval' })
    expect(loads).toBe(1)
    expect(approves).toBe(1)

    answer = { approved: true } // host state — the global returns it on re-dispatch
    const r2 = await runner.execute({ code, cache: r1.cache, globals }).result
    expect(r2.outcome).toBe('completed')
    if (r2.outcome !== 'completed')
      return
    expect(r2.result).toEqual({ a: { title: 't' }, b: { approved: true } })
    expect(loads).toBe(1) // read cached — NOT re-invoked
    expect(approves).toBe(2) // the answer entered the cache through the live re-dispatch

    const r3 = await runner.execute({ code, cache: r2.cache, globals }).result
    expect(r3.outcome).toBe('completed')
    expect(approves).toBe(2) // now settled in the cache — no further dispatch
  }, 15_000)

  test('implicit gate: gated call suspends, then does the real work on resume', async () => {
    let approved = false
    let dispatches = 0
    const globals: PerExecuteGlobals = {
      del: () => {
        dispatches += 1
        if (!approved)
          throw new SuspendIsolate({ op: 'DELETE' })
        return { deleted: true }
      },
    }
    const code = `import { call } from 'tools'; export default await call('del', {})`

    const r1 = await runner.execute({ code, cache: {}, globals }).result
    expect(r1.outcome).toBe('suspended')
    if (r1.outcome !== 'suspended')
      return
    expect(dispatches).toBe(1)
    expect(r1.pending[0]?.id).toBe('del#0')
    expect(r1.pending[0]?.payload).toEqual({ op: 'DELETE' })

    approved = true // app state — same cache, just re-run
    const r2 = await runner.execute({ code, cache: r1.cache, globals }).result
    expect(r2.outcome).toBe('completed')
    if (r2.outcome !== 'completed')
      return
    expect(r2.result).toEqual({ deleted: true })
    expect(dispatches).toBe(2) // waiting → re-dispatched; the DELETE ran exactly once
  }, 15_000)

  test('denial: the global throws on re-dispatch, catchable in the sandbox', async () => {
    let denied = false
    const globals: PerExecuteGlobals = {
      del: () => {
        if (denied) {
          const e = new Error('user declined')
          e.name = 'Declined'
          throw e
        }
        throw new SuspendIsolate({ op: 'DELETE' })
      },
    }
    const code = `import { call } from 'tools'
      let msg = 'none'
      try { await call('del', {}) } catch (e) { msg = e.name + ': ' + e.message }
      export default msg`

    const r1 = await runner.execute({ code, cache: {}, globals }).result
    expect(r1.outcome).toBe('suspended')
    if (r1.outcome !== 'suspended')
      return

    denied = true
    const r2 = await runner.execute({ code, cache: r1.cache, globals }).result
    expect(r2.outcome).toBe('completed')
    if (r2.outcome !== 'completed')
      return
    expect(r2.result).toBe('Declined: user declined')
  }, 15_000)

  test('a parallel branch in flight at suspension is drained and kept', async () => {
    let slowRuns = 0
    const globals: PerExecuteGlobals = {
      slow: async () => {
        slowRuns += 1
        await new Promise((resolve) => {
          setTimeout(resolve, 100)
        })
        return 'io-result'
      },
      gate: () => {
        throw new SuspendIsolate({ need: 'ok' })
      },
    }
    const code = `import { call } from 'tools'
      const [a, b] = await Promise.all([call('slow', {}), call('gate', {})])
      export default [a, b]`

    const r1 = await runner.execute({ code, cache: {}, globals }).result
    expect(r1.outcome).toBe('suspended')
    if (r1.outcome !== 'suspended')
      return
    // the suspension aborted the isolate, but the slow branch's IO was drained in
    expect(r1.cache['slow#0']).toMatchObject({ status: 'completed', value: 'io-result' })
    expect(r1.cache['gate#0']?.status).toBe('waiting')
    expect(slowRuns).toBe(1)

    const r2 = await runner.execute({
      code,
      cache: r1.cache,
      globals: { ...globals, gate: () => 'approved' },
    }).result
    expect(r2.outcome).toBe('completed')
    if (r2.outcome !== 'completed')
      return
    expect(r2.result).toEqual(['io-result', 'approved'])
    expect(slowRuns).toBe(1) // the IO was never redone
  }, 15_000)

  test('a sandbox try/catch around the suspending call cannot swallow it', async () => {
    let approves = 0
    const globals: PerExecuteGlobals = {
      approve: () => {
        approves += 1
        throw new SuspendIsolate({})
      },
    }
    const code = `import { call } from 'tools'
      let swallowed = false
      try { await call('approve', {}) } catch { swallowed = true }
      export default { swallowed }`

    const r1 = await runner.execute({ code, cache: {}, globals }).result
    expect(r1.outcome).toBe('suspended')
    if (r1.outcome !== 'suspended')
      return
    expect(r1.pending).toHaveLength(1)
    expect(approves).toBe(1)
  }, 15_000)

  test('bare re-execution re-dispatches and re-suspends with the same id', async () => {
    let dispatches = 0
    const globals: PerExecuteGlobals = {
      gate: () => {
        dispatches += 1
        throw new SuspendIsolate({})
      },
    }
    const code = `import { call } from 'tools'; export default await call('gate', {})`

    const r1 = await runner.execute({ code, cache: {}, globals }).result
    expect(r1.outcome).toBe('suspended')
    if (r1.outcome !== 'suspended')
      return

    const r2 = await runner.execute({ code, cache: r1.cache, globals }).result
    expect(r2.outcome).toBe('suspended')
    if (r2.outcome !== 'suspended')
      return
    expect(r2.pending[0]?.id).toBe(r1.pending[0]?.id) // same boundary, same id
    expect(dispatches).toBe(2)
  }, 15_000)
})

describe('checkpoints (lookup / commit / boundary)', () => {
  test('lookup+commit: the committed value survives eviction of the work that produced it', async () => {
    let produces = 0
    const globals: PerExecuteGlobals = {
      produce: () => {
        produces += 1
        return `v${produces}`
      },
    }
    const code = `import { call } from 'tools'
      import { durableLookup, durableCommit } from 'durable-isolates:internal'
      const r = await durableLookup('memo')
      let v
      if (r.hit) { v = r.value }
      else { v = await call('produce', {}); await durableCommit('memo', v) }
      export default v`

    const r1 = await runner.execute({ code, cache: {}, globals }).result
    expect(r1.outcome).toBe('completed')
    if (r1.outcome !== 'completed')
      return
    expect(r1.result).toBe('v1')
    expect(Object.keys(r1.cache).sort()).toEqual(['memo', 'produce#0'])

    // Evict the inner work; the checkpoint alone answers the replay.
    const surgically: BoundaryCache = { ...r1.cache }
    delete surgically['produce#0']
    const r2 = await runner.execute({ code, cache: surgically, globals }).result
    expect(r2.outcome).toBe('completed')
    if (r2.outcome !== 'completed')
      return
    expect(r2.result).toBe('v1') // from the commit, not re-produced
    expect(produces).toBe(1)
  }, 15_000)

  test('boundary(): scope suspends inside, resumes, commits, then skips its body wholesale', async () => {
    let approved = false
    let probes = 0
    let gates = 0
    const globals: PerExecuteGlobals = {
      probe: () => {
        probes += 1
        return 41
      },
      gate: () => {
        gates += 1
        if (!approved)
          throw new SuspendIsolate({ need: 'ok' })
        return true
      },
    }
    const code = `import { boundary, durableCall, nextKey } from 'durable-isolates:internal'
      export default await boundary('scope', async () => {
        const a = await durableCall(nextKey('probe'), 'probe', {})
        await durableCall(nextKey('gate'), 'gate', {})
        return a + 1
      })`

    const r1 = await runner.execute({ code, cache: {}, globals }).result
    expect(r1.outcome).toBe('suspended')
    if (r1.outcome !== 'suspended')
      return
    expect(r1.pending[0]?.id).toBe('scope/gate#0') // inner keys are scope-prefixed
    expect(probes).toBe(1)

    approved = true
    const r2 = await runner.execute({ code, cache: r1.cache, globals }).result
    expect(r2.outcome).toBe('completed')
    if (r2.outcome !== 'completed')
      return
    expect(r2.result).toBe(42)
    expect(probes).toBe(1) // inner probe fast-pathed on the resume replay
    expect(r2.cache.scope).toEqual({ seq: expect.any(Number), status: 'completed', value: 42 })

    // Evict the inner records: the committed scope must skip its body wholesale.
    const pruned: BoundaryCache = { scope: r2.cache.scope! }
    const r3 = await runner.execute({ code, cache: pruned, globals }).result
    expect(r3.outcome).toBe('completed')
    if (r3.outcome !== 'completed')
      return
    expect(r3.result).toBe(42)
    expect(probes).toBe(1) // body never ran
    expect(gates).toBe(2) // once suspended, once for real — never again
  }, 15_000)

  test('nested boundary: keys concatenate; the outer commit alone answers replays', async () => {
    let probes = 0
    const globals: PerExecuteGlobals = {
      probe: () => {
        probes += 1
        return 41
      },
    }
    const code = `import { boundary, durableCall, nextKey } from 'durable-isolates:internal'
      export default await boundary('outer', async () => {
        const a = await boundary('inner', async () => {
          return await durableCall(nextKey('probe'), 'probe', {})
        })
        return a + 1
      })`

    const r1 = await runner.execute({ code, cache: {}, globals }).result
    expect(r1.outcome).toBe('completed')
    if (r1.outcome !== 'completed')
      return
    expect(r1.result).toBe(42)
    expect(Object.keys(r1.cache).sort()).toEqual(['outer', 'outer/inner', 'outer/inner/probe#0'])

    const pruned: BoundaryCache = { outer: r1.cache.outer! }
    const r2 = await runner.execute({ code, cache: pruned, globals }).result
    expect(r2.outcome).toBe('completed')
    if (r2.outcome !== 'completed')
      return
    expect(r2.result).toBe(42)
    expect(probes).toBe(1) // neither body ever re-ran
  }, 15_000)

  test('parallel nested boundaries: async context keeps each branch prefix isolated', async () => {
    let probes = 0
    const globals: PerExecuteGlobals = {
      probe: () => {
        probes += 1
        return 'ok'
      },
    }
    // Two nested branches run concurrently under Promise.all, interleaving at
    // several await points. A shared module-level prefix would cross-contaminate
    // (both keys would become `charge/refund/validate/...`); the ambient prefix
    // is carried through iso4 AsyncLocalStorage, so each branch keys under itself.
    const code = `import { boundary, durableCall, nextKey } from 'durable-isolates:internal'
      const branch = (name) => boundary(name, async () => {
        await Promise.resolve(); await Promise.resolve()
        return await boundary('validate', async () => {
          await Promise.resolve()
          return await durableCall(nextKey('probe'), 'probe', {})
        })
      })
      const [a, b] = await Promise.all([branch('charge'), branch('refund')])
      export default [a, b]`

    const r1 = await runner.execute({ code, cache: {}, globals }).result
    expect(r1.outcome).toBe('completed')
    if (r1.outcome !== 'completed')
      return
    expect(r1.result).toEqual(['ok', 'ok'])
    expect(Object.keys(r1.cache).sort()).toEqual([
      'charge',
      'charge/validate',
      'charge/validate/probe#0',
      'refund',
      'refund/validate',
      'refund/validate/probe#0',
    ])
    expect(probes).toBe(2)

    // The outer commits alone answer the replay — both bodies skip wholesale.
    const pruned: BoundaryCache = { charge: r1.cache.charge!, refund: r1.cache.refund! }
    const r2 = await runner.execute({ code, cache: pruned, globals }).result
    expect(r2.outcome).toBe('completed')
    if (r2.outcome !== 'completed')
      return
    expect(r2.result).toEqual(['ok', 'ok'])
    expect(probes).toBe(2) // neither body re-ran
  }, 15_000)
})

describe('external suspension (handle.suspend())', () => {
  test('suspend() drains the in-flight dispatch, records it, and the resume fast-paths it', async () => {
    let slowRuns = 0
    let started: () => void
    const startedOnce = new Promise<void>((resolve) => {
      started = resolve
    })
    const globals: PerExecuteGlobals = {
      slow: async () => {
        slowRuns += 1
        started()
        await new Promise((resolve) => {
          setTimeout(resolve, 150)
        })
        return 'expensive-io'
      },
    }
    const code = `import { call } from 'tools'; export default await call('slow', {})`

    const handle = runner.execute({ code, cache: {}, globals })
    await startedOnce
    const r1 = await handle.suspend() // server teardown mid-dispatch
    expect(r1.outcome).toBe('suspended')
    if (r1.outcome !== 'suspended')
      return
    expect(r1.pending).toEqual([]) // nothing waits on the outside — we stopped it
    expect(r1.cache['slow#0']).toEqual({ seq: 0, status: 'completed', value: 'expensive-io' }) // drained write kept

    const r2 = await runner.execute({ code, cache: r1.cache, globals }).result
    expect(r2.outcome).toBe('completed')
    if (r2.outcome !== 'completed')
      return
    expect(r2.result).toBe('expensive-io')
    expect(slowRuns).toBe(1) // the IO was never redone
  }, 15_000)

  test('suspend() after completion is a no-op resolving the completed result', async () => {
    const globals: PerExecuteGlobals = { ping: () => 'pong' }
    const code = `import { call } from 'tools'; export default await call('ping', {})`

    const handle = runner.execute({ code, cache: {}, globals })
    const r1 = await handle.result
    expect(r1.outcome).toBe('completed')

    const r2 = await handle.suspend() // already done — nothing to abort or drain
    expect(r2).toBe(r1)
  }, 15_000)

  test('a run suspended on approval is inert — suspend() has nothing to drain', async () => {
    const globals: PerExecuteGlobals = {
      gate: () => {
        throw new SuspendIsolate({})
      },
    }
    const code = `import { call } from 'tools'; export default await call('gate', {})`

    const r1 = await runner.execute({ code, cache: {}, globals }).result
    expect(r1.outcome).toBe('suspended')
    if (r1.outcome !== 'suspended')
      return
    expect(r1.pending).toHaveLength(1)
    expect(r1.cache['gate#0']?.status).toBe('waiting')
  }, 15_000)
})

describe('error plane', () => {
  test('a failed call is recorded and re-throws deterministically (global once)', async () => {
    let booms = 0
    const globals: PerExecuteGlobals = {
      boom: () => {
        booms += 1
        throw new Error('kaboom')
      },
    }
    const code = `import { call } from 'tools'; export default await call('boom', {})`

    const r1 = await runner.execute({ code, cache: {}, globals }).result
    expect(r1.outcome).toBe('failed')
    if (r1.outcome !== 'failed')
      return
    expect((r1.error as { message?: string }).message).toContain('kaboom')
    expect(booms).toBe(1)

    const r2 = await runner.execute({ code, cache: r1.cache, globals }).result
    expect(r2.outcome).toBe('failed')
    expect(booms).toBe(1) // re-thrown from the cache
  }, 15_000)

  test('retry is cache surgery: delete the failed entry to re-execute that boundary', async () => {
    let attempts = 0
    const globals: PerExecuteGlobals = {
      flaky: () => {
        attempts += 1
        if (attempts === 1)
          throw new Error('transient')
        return 'ok'
      },
    }
    const code = `import { call } from 'tools'; export default await call('flaky', {})`

    const r1 = await runner.execute({ code, cache: {}, globals }).result
    expect(r1.outcome).toBe('failed')
    if (r1.outcome !== 'failed')
      return
    expect(r1.cache['flaky#0']?.status).toBe('failed')

    const retried: BoundaryCache = { ...r1.cache }
    delete retried['flaky#0'] // the caller's retry policy decided to re-execute
    const r2 = await runner.execute({ code, cache: retried, globals }).result
    expect(r2.outcome).toBe('completed')
    if (r2.outcome !== 'completed')
      return
    expect(r2.result).toBe('ok')
    expect(attempts).toBe(2)
  }, 15_000)

  test('a durable failure preserves the error name in the in-sandbox catch', async () => {
    const globals: PerExecuteGlobals = {
      boom: () => {
        const e = new Error('nope')
        e.name = 'NonRetryableError'
        throw e
      },
    }
    const code = `import { call } from 'tools'
      let name = 'none'
      try { await call('boom', {}) } catch (e) { name = e.name }
      export default name`

    const r = await runner.execute({ code, cache: {}, globals }).result
    expect(r.outcome).toBe('completed')
    if (r.outcome !== 'completed')
      return
    expect(r.result).toBe('NonRetryableError') // carried via the bridge, not flattened
  }, 15_000)

  test('a host throw reaches the sandbox catch as a real Error with ALL own fields', async () => {
    const globals: PerExecuteGlobals = {
      boom: () => {
        throw Object.assign(new Error('payment declined'), { name: 'PaymentError', status: 402 })
      },
    }
    const code = `import { call } from 'tools'
      let out
      try { await call('boom', {}) } catch (e) {
        out = { name: e.name, message: e.message, status: e.status, isError: e instanceof Error }
      }
      export default out`

    const r = await runner.execute({ code, cache: {}, globals }).result
    expect(r.outcome).toBe('completed')
    if (r.outcome !== 'completed')
      return
    // name/message + the custom `status` survive; rebuilt as a real Error in-sandbox.
    expect(r.result).toEqual({ name: 'PaymentError', message: 'payment declined', status: 402, isError: true })
    // Recorded as plain, persistable data with the host stack stripped.
    const failed = Object.values(r.cache).find((rec) => rec.status === 'failed')
    expect(failed?.status).toBe('failed')
    if (failed?.status !== 'failed')
      return
    expect(failed.error).toEqual({ name: 'PaymentError', message: 'payment declined', status: 402 })
  }, 15_000)

  test('a non-Error host throw crosses without an assumed shape', async () => {
    const globals: PerExecuteGlobals = {
      boom: () => {
        // eslint-disable-next-line no-throw-literal -- exercising a non-Error throw on purpose
        throw { code: 'DENY', reason: 'nope' }
      },
    }
    const code = `import { call } from 'tools'
      let out
      try { await call('boom', {}) } catch (e) { out = { code: e.code, reason: e.reason } }
      export default out`

    const r = await runner.execute({ code, cache: {}, globals }).result
    expect(r.outcome).toBe('completed')
    if (r.outcome !== 'completed')
      return
    expect(r.result).toEqual({ code: 'DENY', reason: 'nope' })
  }, 15_000)

  test('an uncaught host throw surfaces as a structured run-level failure', async () => {
    const globals: PerExecuteGlobals = {
      boom: () => {
        throw Object.assign(new Error('boom'), { name: 'PaymentError', status: 402 })
      },
    }
    const code = `import { call } from 'tools'; export default await call('boom', {})`

    const r = await runner.execute({ code, cache: {}, globals }).result
    expect(r.outcome).toBe('failed')
    if (r.outcome !== 'failed')
      return
    const err = r.error as { name?: string, message?: string, fields?: Record<string, unknown> }
    expect(err.name).toBe('PaymentError')
    expect(err.message).toBe('boom')
    expect(err.fields?.status).toBe(402) // iso4 nests non-reserved props under `fields`
  }, 15_000)

  test('a changed program just misses and runs — determinism is a contract, not a check', async () => {
    let bs = 0
    const globals: PerExecuteGlobals = { a: () => 1, b: () => {
      bs += 1
      return 2
    } }

    const r1 = await runner.execute({ code: `import { call } from 'tools'; export default await call('a', {})`, cache: {}, globals }).result
    expect(r1.outcome).toBe('completed')
    if (r1.outcome !== 'completed')
      return

    const r2 = await runner.execute({ code: `import { call } from 'tools'; export default await call('b', {})`, cache: r1.cache, globals }).result
    expect(r2.outcome).toBe('completed')
    if (r2.outcome !== 'completed')
      return
    expect(r2.result).toBe(2)
    expect(bs).toBe(1) // the abandoned 'a#0' record lingers harmlessly
    expect(Object.keys(r2.cache).sort()).toEqual(['a#0', 'b#0'])
  }, 15_000)
})

// real @iso4/fetch as a mounted global; the shim keys it, the middleware gates
describe('e2e: @iso4/fetch mounted durably', () => {
  test('cached read + consent-gated DELETE that suspends then runs on approval', async () => {
    let approved = false
    let gets = 0
    let deletes = 0

    const globals: PerExecuteGlobals = {
      fetch: createSafeFetch({
        pinDns: false,
        rules: {
          host: 'example.test',
          httpsOnly: true,
          routes: [{ path: '/**' }],
          middleware: async (fctx) => {
            const method = fctx.req.method
            const path = new URL(fctx.req.url).pathname
            if (method === 'GET')
              gets += 1
            if (method === 'DELETE') {
              deletes += 1
              if (!approved)
                throw new SuspendIsolate({ method, path })
            }
            return { status: 200, headers: { 'content-type': 'application/json' }, body: { ok: true, method, path } }
          },
        },
      }).handler,
    }

    const code = `import { call } from 'tools'
      const read = await call('fetch', 'https://example.test/inventory').then((r) => r.body)
      const del = await call('fetch', 'https://example.test/inventory/42', { method: 'DELETE' }).then((r) => r.body)
      export default { read, del }`

    const r1 = await runner.execute({ code, cache: {}, globals }).result
    expect(r1.outcome).toBe('suspended')
    if (r1.outcome !== 'suspended')
      return
    expect(r1.pending[0]?.payload).toEqual({ method: 'DELETE', path: '/inventory/42' })
    expect(gets).toBe(1)
    expect(deletes).toBe(1)

    approved = true
    const r2 = await runner.execute({ code, cache: r1.cache, globals }).result
    expect(r2.outcome).toBe('completed')
    if (r2.outcome !== 'completed')
      return
    expect(r2.result).toEqual({
      read: { ok: true, method: 'GET', path: '/inventory' },
      del: { ok: true, method: 'DELETE', path: '/inventory/42' },
    })
    expect(gets).toBe(1) // GET cached — NOT re-fetched on resume
    expect(deletes).toBe(2) // DELETE re-dispatched and ran once
  }, 20_000)
})

describe('mount guards', () => {
  test('mounting the reserved internal specifier throws (kernel shim cannot be shadowed)', async () => {
    await expect(
      host.hydrate({ modules: { 'durable-isolates:internal': { shim: 'export const x = 1' } } }),
    ).rejects.toThrow(/reserved module specifier/)
  })
})
