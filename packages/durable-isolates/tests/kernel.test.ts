import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createSafeFetch } from '@iso4/fetch'
import type { BoundaryCache, DurableIsolates, DurableIsolatesRunner, ExecuteResult, PerExecuteGlobals } from '../src'
import { durableIsolates, KERNEL_BRIDGE_GLOBALS, NonJsonValueError, SuspendIsolate, toJson } from '../src'

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
  host = durableIsolates()
  runner = await host.prepare({ modules: { tools: { shim: SHIM } } })
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
    const withDefault = await host.prepare({
      modules: { tools: { shim: SHIM, globals: { who: () => 'default' } } },
    })
    const code = `import { call } from 'tools'; export default await call('who', {})`

    const def = await withDefault.execute({ code, cache: {} }).result
    expect(def.outcome === 'completed' && def.result).toBe('default')

    const overridden = await withDefault.execute({ code, cache: {}, globals: { who: () => 'per-run' } }).result
    expect(overridden.outcome === 'completed' && overridden.result).toBe('per-run')
  }, 15_000)
})

describe('boundary records carry the call (name + args)', () => {
  test('completed: the record holds the dispatched name and the forwarded args', async () => {
    const globals: PerExecuteGlobals = { echo: (a, b) => ({ a, b }) }
    const code = `import { call } from 'tools'; export default await call('echo', 'p', { n: 1, tags: ['x'] })`

    const r = await runner.execute({ code, cache: {}, globals }).result
    expect(r.outcome).toBe('completed')
    expect(r.cache['echo#0']).toEqual({
      seq: 0,
      status: 'completed',
      name: 'echo',
      args: ['p', { n: 1, tags: ['x'] }],
      value: { a: 'p', b: { n: 1, tags: ['x'] } },
    })
  }, 15_000)

  test('failed: a throwing global records name and args next to the error', async () => {
    const globals: PerExecuteGlobals = {
      boom: () => {
        throw new TypeError('nope')
      },
    }
    const code = `import { call } from 'tools'
      try { await call('boom', 7) } catch {}
      export default 'survived'`

    const r = await runner.execute({ code, cache: {}, globals }).result
    expect(r.outcome).toBe('completed')
    expect(r.cache['boom#0']).toEqual({
      seq: 0,
      status: 'failed',
      name: 'boom',
      args: [7],
      error: { name: 'TypeError', message: 'nope' },
    })
  }, 15_000)

  test('failed (no global): the missing name and the args are still recorded', async () => {
    const code = `import { call } from 'tools'
      try { await call('missing', 'a', 1) } catch {}
      export default 'survived'`

    const r = await runner.execute({ code, cache: {}, globals: {} }).result
    expect(r.outcome).toBe('completed')
    expect(r.cache['missing#0']).toEqual({
      seq: 0,
      status: 'failed',
      name: 'missing',
      args: ['a', 1],
      error: { name: 'Error', message: 'durable-isolates: no global for "missing"' },
    })
  }, 15_000)

  test('waiting: the record holds the args the resume re-dispatch forwards again', async () => {
    const seen: unknown[][] = []
    let approved = false
    const globals: PerExecuteGlobals = {
      gate: (...args) => {
        seen.push(args)
        if (!approved)
          throw new SuspendIsolate({ need: 'approval' })
        return 'opened'
      },
    }
    const code = `import { call } from 'tools'; export default await call('gate', { subject: 's-1' })`

    const r1 = await runner.execute({ code, cache: {}, globals }).result
    expect(r1.outcome).toBe('suspended')
    expect(r1.cache['gate#0']).toEqual({ seq: 0, status: 'waiting', name: 'gate', args: [{ subject: 's-1' }] })

    approved = true
    const r2 = await runner.execute({ code, cache: r1.cache, globals }).result
    expect(r2.outcome).toBe('completed')
    expect(r2.cache['gate#0']).toEqual({ seq: 0, status: 'completed', name: 'gate', args: [{ subject: 's-1' }], value: 'opened' })
    expect(seen).toEqual([[{ subject: 's-1' }], [{ subject: 's-1' }]]) // same args both dispatches
  }, 15_000)

  test('commit records (boundary / durableCommit) carry neither name nor args', async () => {
    const code = `import { boundary, durableCommit } from 'durable-isolates:internal'
      const a = await boundary('scope', async () => 'in-sandbox')
      await durableCommit('manual', { ok: true })
      export default a`

    const r = await runner.execute({ code, cache: {}, globals: {} }).result
    expect(r.outcome).toBe('completed')
    expect(r.cache.scope).toEqual({ seq: 0, status: 'completed', value: 'in-sandbox' })
    expect(r.cache.manual).toEqual({ seq: 1, status: 'completed', value: { ok: true } })
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
    expect(r1.cache['slow#0']).toEqual({ seq: 0, status: 'completed', name: 'slow', args: [{}], value: 'expensive-io' }) // drained write kept

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
    expect(r1.error.message).toContain('kaboom')
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

  test('a host throw reaches the sandbox catch as a real Error with name + message only', async () => {
    const globals: PerExecuteGlobals = {
      boom: () => {
        throw Object.assign(new Error('payment declined'), { name: 'PaymentError', status: 402, cause: new Response('x') })
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
    // name/message survive and it is rebuilt as a real Error in-sandbox; own
    // fields (JSON or not) are dropped — the record is text a model reads back.
    expect(r.result).toEqual({ name: 'PaymentError', message: 'payment declined', status: undefined, isError: true })
    expect(r.cache['boom#0']).toEqual({
      seq: 0,
      status: 'failed',
      name: 'boom',
      args: [{}],
      error: { name: 'PaymentError', message: 'payment declined' },
    })
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
    const err = r.error
    expect(err.name).toBe('PaymentError')
    expect(err.message).toBe('boom')
    expect(err.fields?.status).toBeUndefined() // own fields are not recorded, so none reach the run-level error
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

describe('e2e: @iso4/fetch byte bodies', () => {
  // Shared fetch wiring: `decode` chooses whether the middleware hands the kernel
  // raw bytes (what a real HTTP body is) or text.
  const fetchGlobals = (decode: boolean): PerExecuteGlobals => ({
    fetch: createSafeFetch({
      pinDns: false,
      rules: {
        host: 'example.test',
        httpsOnly: true,
        routes: [{ path: '/**' }],
        middleware: async () => {
          const bytes = new TextEncoder().encode('hello')
          return { status: 200, headers: { 'content-type': 'text/plain' }, body: decode ? new TextDecoder().decode(bytes) : bytes }
        },
      },
    }).handler,
  })
  const code = `import { call } from 'tools'
    export default await call('fetch', 'https://example.test/file').then((r) => r.body)`

  test('a raw byte body is rejected — the kernel does not store binary', async () => {
    const r = await runner.execute({ code, cache: {}, globals: fetchGlobals(false) }).result
    expect(r.outcome).toBe('rejected')
    if (r.outcome !== 'rejected')
      return
    expect(r.rejection).toMatchObject({ reason: 'non-json', source: 'result', name: 'fetch', path: '$.body', found: 'Uint8Array' })
  }, 20_000)

  test('converting the body to text in the middleware is the fix', async () => {
    const r = await runner.execute({ code, cache: {}, globals: fetchGlobals(true) }).result
    expect(r.outcome).toBe('completed')
    if (r.outcome !== 'completed')
      return
    expect(r.result).toBe('hello')
  }, 20_000)
})

describe('toJson (the JSON check + normalization)', () => {
  test('accepts JSON and returns a normalized copy; undefined follows JSON rules', () => {
    const value = { a: 1, b: 'two', c: [true, null, undefined], d: { e: undefined, f: -0.5 }, g: Object.create(null) }
    expect(toJson(value)).toEqual({ a: 1, b: 'two', c: [true, null, null], d: { f: -0.5 }, g: {} })
    expect(toJson(undefined)).toBeUndefined()
    expect(toJson(null)).toBeNull()
    expect(toJson('s')).toBe('s')
  })

  test('shared references are fine; cycles are not', () => {
    const shared = { x: 1 }
    expect(toJson({ a: shared, b: shared })).toEqual({ a: { x: 1 }, b: { x: 1 } })
    const cyclic: Record<string, unknown> = { name: 'loop' }
    cyclic.self = cyclic
    expect(() => toJson(cyclic)).toThrow(new NonJsonValueError('$.self', 'circular reference'))
  })

  test.each([
    ['a Date', { at: new Date(0) }, '$.at', 'Date'],
    ['a Map', new Map(), '$', 'Map'],
    ['a Set in an array', [new Set()], '$[0]', 'Set'],
    ['a RegExp', { re: /x/ }, '$.re', 'RegExp'],
    ['bytes', { body: new Uint8Array(2) }, '$.body', 'Uint8Array'],
    ['a bigint', [1, 2n], '$[1]', 'bigint'],
    ['NaN', { n: Number.NaN }, '$.n', 'NaN'],
    ['Infinity', [Number.POSITIVE_INFINITY], '$[0]', 'Infinity'],
    ['-Infinity', Number.NEGATIVE_INFINITY, '$', '-Infinity'],
    ['a function', { fn: () => 1 }, '$.fn', 'function'],
    ['a symbol', [Symbol('s')], '$[0]', 'symbol'],
    ['an Error', new TypeError('x'), '$', 'TypeError'],
    ['a class instance, deep', { items: [0, 1, { at: new (class Money {})() }] }, '$.items[2].at', 'Money'],
    ['a non-identifier key', { 'odd key': new Date(0) }, '$["odd key"]', 'Date'],
    ['a sparse array', { list: [1, , 3] }, '$.list', 'sparse array'], // eslint-disable-line no-sparse-arrays -- the point of the case
    ['a huge sparse array (never iterated)', Object.assign([], { length: 2 ** 32 - 1 }), '$', 'sparse array'],
    ['an object with toJSON', { toJSON: () => 1 }, '$.toJSON', 'function'],
  ])('rejects %s with the path and what was found', (_label, value, path, found) => {
    expect(() => toJson(value)).toThrow(new NonJsonValueError(path, found))
  })

  test('-0 becomes 0, as JSON does', () => {
    expect(Object.is(toJson(-0), 0)).toBe(true)
    expect(Object.is((toJson([-0]) as number[])[0], 0)).toBe(true)
  })

  test('an own __proto__ key stays an own key and never re-points the copy', () => {
    const out = toJson(JSON.parse('{"__proto__":{"isAdmin":true},"a":1}')) as Record<string, unknown>
    expect(Object.keys(out)).toEqual(['__proto__', 'a'])
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect((out as { isAdmin?: unknown }).isAdmin).toBeUndefined()
    expect(JSON.stringify(out)).toBe('{"__proto__":{"isAdmin":true},"a":1}')
  })

  test('a throwing getter and a value too deep to walk are reported, not thrown through', () => {
    const trap = { items: [{ get at() {
      throw new Error('getter boom')
    } }] }
    expect(() => toJson(trap)).toThrow(new NonJsonValueError('$.items[0].at', 'unreadable value'))

    let deep: unknown = 'leaf'
    for (let i = 0; i < 100_000; i++)
      deep = { d: deep }
    let caught: unknown
    try {
      toJson(deep)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(NonJsonValueError)
    expect((caught as NonJsonValueError).found).toBe('nesting too deep to walk')
    expect((caught as NonJsonValueError).path.startsWith('$.d.d.d')).toBe(true)
  })
})

describe('JSON-only boundaries (rejected outcome)', () => {
  test('a global returning a non-JSON value rejects the run; nothing is recorded at the key', async () => {
    const globals: PerExecuteGlobals = { now: () => ({ items: [0, 1, { at: new Date(0) }] }) }
    const code = `import { call } from 'tools'; export default await call('now', {})`

    const r = await runner.execute({ code, cache: {}, globals }).result
    expect(r.outcome).toBe('rejected')
    if (r.outcome !== 'rejected')
      return
    expect(r.rejection).toEqual({
      reason: 'non-json',
      source: 'result',
      key: 'now#0',
      name: 'now',
      path: '$.items[2].at',
      found: 'Date',
      message: expect.stringContaining('non-JSON value in what a global returned: Date at $.items[2].at'),
    })
    expect(r.rejection.message).toContain('Only JSON values')
    expect(r.cache).toEqual({}) // not recorded — fix the global and run the same cache again
    expect(r.run.status).toBe('aborted')
  }, 15_000)

  test('a non-JSON argument from the sandbox rejects the run before any lookup', async () => {
    let calls = 0
    const globals: PerExecuteGlobals = {
      save: () => {
        calls += 1
        return 'ok'
      },
    }
    const code = `import { call } from 'tools'; export default await call('save', { when: new Date(0) })`

    const r = await runner.execute({ code, cache: {}, globals }).result
    expect(r.outcome).toBe('rejected')
    if (r.outcome !== 'rejected')
      return
    expect(r.rejection).toMatchObject({ reason: 'non-json', source: 'args', key: 'save#0', name: 'save', path: '$[0].when', found: 'Date' })
    expect(r.rejection.message).toContain('non-JSON value in an argument of a durable call: Date at $[0].when')
    expect(r.rejection.message).not.toContain('save') // no program-written text in the message
    expect(calls).toBe(0) // the global never ran
    expect(r.cache).toEqual({})
  }, 15_000)

  test('a global throwing a non-Error, non-JSON value rejects the run', async () => {
    const globals: PerExecuteGlobals = {
      boom: () => {
        throw new Map([['code', 'DENY']])
      },
    }
    const code = `import { call } from 'tools'; export default await call('boom', {})`

    const r = await runner.execute({ code, cache: {}, globals }).result
    expect(r.outcome).toBe('rejected')
    if (r.outcome !== 'rejected')
      return
    expect(r.rejection).toMatchObject({ reason: 'non-json', source: 'error', key: 'boom#0', name: 'boom', path: '$', found: 'Map' })
    expect(r.rejection.message).toContain('non-JSON value in what a global threw: Map at $')
  }, 15_000)

  test('a boundary() body returning a non-JSON value rejects the run at the commit', async () => {
    const code = `import { boundary } from 'durable-isolates:internal'
      export default await boundary('total', async () => ({ amount: 10n }))`

    const r = await runner.execute({ code, cache: {}, globals: {} }).result
    expect(r.outcome).toBe('rejected')
    if (r.outcome !== 'rejected')
      return
    expect(r.rejection).toEqual({
      reason: 'non-json',
      source: 'commit',
      key: 'total',
      path: '$.amount',
      found: 'bigint',
      message: expect.stringContaining('non-JSON value in a committed value: bigint at $.amount'),
    })
    expect(r.cache).toEqual({})
  }, 15_000)

  test('values are JSON-normalized on the FIRST run: undefined → dropped / null, same as replay', async () => {
    const globals: PerExecuteGlobals = { load: () => [1, undefined, { a: undefined, b: 2 }] }
    const code = `import { call } from 'tools'
      import { boundary } from 'durable-isolates:internal'
      const fromGlobal = await call('load', {})
      const fromBody = await boundary('body', () => ({ list: [undefined, 'x'], gone: undefined }))
      export default { fromGlobal, fromBody, nothing: await boundary('nothing', () => undefined) }`

    const r1 = await runner.execute({ code, cache: {}, globals }).result
    expect(r1.outcome).toBe('completed')
    if (r1.outcome !== 'completed')
      return
    const expected = { fromGlobal: [1, null, { b: 2 }], fromBody: { list: [null, 'x'] }, nothing: undefined }
    expect(r1.result).toEqual(expected) // first run already sees the JSON shape
    expect(r1.cache['load#0']).toMatchObject({ value: [1, null, { b: 2 }] })
    expect(r1.cache.body).toMatchObject({ value: { list: [null, 'x'] } })
    expect(r1.cache.nothing).toEqual({ seq: 2, status: 'completed' }) // a bare undefined is an absent value

    // A store round trip changes nothing: the replay reads back the same values.
    const roundTripped = JSON.parse(JSON.stringify(r1.cache)) as typeof r1.cache
    const r2 = await runner.execute({ code, cache: roundTripped, globals }).result
    expect(r2.outcome).toBe('completed')
    if (r2.outcome !== 'completed')
      return
    expect(r2.result).toEqual(expected)
  }, 15_000)

  test('a sandbox try/catch around the violating call cannot swallow the rejection', async () => {
    const globals: PerExecuteGlobals = { now: () => new Date(0) }
    const code = `import { call } from 'tools'
      let out = 'not reached'
      try { await call('now', {}) } catch (e) { out = 'caught: ' + e.message }
      export default out`

    const r = await runner.execute({ code, cache: {}, globals }).result
    expect(r.outcome).toBe('rejected')
    if (r.outcome !== 'rejected')
      return
    expect(r.rejection).toMatchObject({ source: 'result', key: 'now#0', found: 'Date' })
  }, 15_000)

  test('a parallel branch in flight at rejection is drained and kept; the first violation wins', async () => {
    let slowRuns = 0
    const globals: PerExecuteGlobals = {
      slow: async () => {
        slowRuns += 1
        await new Promise((resolve) => {
          setTimeout(resolve, 100)
        })
        return 'io-result'
      },
      bad: () => new Map(),
      alsoBad: () => new Set(),
    }
    const code = `import { call } from 'tools'
      export default await Promise.all([call('slow', {}), call('bad', {}), call('alsoBad', {})])`

    const r1 = await runner.execute({ code, cache: {}, globals }).result
    expect(r1.outcome).toBe('rejected')
    if (r1.outcome !== 'rejected')
      return
    expect(r1.rejection).toMatchObject({ key: 'bad#0', found: 'Map' })
    expect(r1.cache['slow#0']).toMatchObject({ status: 'completed', value: 'io-result' }) // drained write kept
    expect(r1.cache['bad#0']).toBeUndefined()
    expect(r1.cache['alsoBad#0']).toBeUndefined()

    // Fix the globals, run the same cache: the drained IO is not redone.
    const fixed: PerExecuteGlobals = { ...globals, bad: () => 'b', alsoBad: () => 'c' }
    const r2 = await runner.execute({ code, cache: r1.cache, globals: fixed }).result
    expect(r2.outcome).toBe('completed')
    if (r2.outcome !== 'completed')
      return
    expect(r2.result).toEqual(['io-result', 'b', 'c'])
    expect(slowRuns).toBe(1)
  }, 15_000)

  test('args are checked even at a key the cache would have answered', async () => {
    const globals: PerExecuteGlobals = { p: () => 'cached' }
    const first = `import { step } from 'tools'; export default await step('k', 'p', 'fine')`
    const r1 = await runner.execute({ code: first, cache: {}, globals }).result
    expect(r1.outcome).toBe('completed')

    const changed = `import { step } from 'tools'; export default await step('k', 'p', new Date(0))`
    const r2 = await runner.execute({ code: changed, cache: r1.cache, globals }).result
    expect(r2.outcome).toBe('rejected')
    if (r2.outcome !== 'rejected')
      return
    expect(r2.rejection).toMatchObject({ source: 'args', key: 'k', path: '$[0]', found: 'Date' })
  }, 15_000)

  test('a program that never awaits the violating call is still rejected', async () => {
    const globals: PerExecuteGlobals = { bad: () => new Map() }
    const code = `import { call } from 'tools'
      call('bad', {}) // fire and forget
      export default 'done'`

    const r = await runner.execute({ code, cache: {}, globals }).result
    expect(r.outcome).toBe('rejected')
    if (r.outcome !== 'rejected')
      return
    expect(r.rejection).toMatchObject({ source: 'result', key: 'bad#0', found: 'Map' })
  }, 15_000)

  test('a sparse array from the sandbox is rejected without being iterated', async () => {
    const globals: PerExecuteGlobals = { echo: (v) => v }
    const code = `import { call } from 'tools'
      const a = []; a.length = 2 ** 32 - 1
      export default await call('echo', a)`

    const started = Date.now()
    const r = await runner.execute({ code, cache: {}, globals }).result
    expect(r.outcome).toBe('rejected')
    if (r.outcome !== 'rejected')
      return
    expect(r.rejection).toMatchObject({ source: 'args', path: '$[0]', found: 'sparse array' })
    expect(Date.now() - started).toBeLessThan(2_000)
  }, 15_000)

  test('an Error with a non-string message is recorded as text', async () => {
    const globals: PerExecuteGlobals = {
      boom: () => {
        throw Object.assign(new Error('x'), { message: { d: new Date(0) } })
      },
    }
    const code = `import { call } from 'tools'
      try { await call('boom', {}) } catch {}
      export default 'survived'`

    const r = await runner.execute({ code, cache: {}, globals }).result
    expect(r.outcome).toBe('completed')
    expect(r.cache['boom#0']).toMatchObject({ status: 'failed', error: { name: 'Error', message: '[object Object]' } })
  }, 15_000)
})

describe('prototype-named keys are plain cache entries', () => {
  test('a boundary keyed "__proto__" is recorded, survives a JSON round trip, and runs once', async () => {
    let charges = 0
    const globals: PerExecuteGlobals = {
      charge: () => {
        charges += 1
        return 'charged'
      },
    }
    const code = `import { step } from 'tools'; export default await step('__proto__', 'charge', 42)`

    const r1 = await runner.execute({ code, cache: {}, globals }).result
    expect(r1.outcome).toBe('completed')
    if (r1.outcome !== 'completed')
      return
    expect(Object.getPrototypeOf(r1.cache)).toBe(Object.prototype) // an ordinary object comes back
    expect(Object.keys(r1.cache)).toEqual(['__proto__'])
    expect(JSON.stringify(r1.cache)).toContain('"__proto__":{"seq":0')

    const roundTripped = JSON.parse(JSON.stringify(r1.cache)) as typeof r1.cache
    const r2 = await runner.execute({ code, cache: roundTripped, globals }).result
    expect(r2.outcome).toBe('completed')
    if (r2.outcome !== 'completed')
      return
    expect(r2.result).toBe('charged')
    expect(charges).toBe(1) // answered from the cache — the side effect did not repeat
  }, 15_000)

  test('a "__proto__" commit cannot forge answers for other keys', async () => {
    let loads = 0
    const globals: PerExecuteGlobals = {
      load: () => {
        loads += 1
        return 'real'
      },
    }
    const code = `import { durableCommit } from 'durable-isolates:internal'
      import { step } from 'tools'
      await durableCommit('__proto__', { forged: { seq: 0, status: 'completed', value: 'forged' } })
      export default await step('forged', 'load', {})`

    const r = await runner.execute({ code, cache: {}, globals }).result
    expect(r.outcome).toBe('completed')
    if (r.outcome !== 'completed')
      return
    expect(r.result).toBe('real')
    expect(loads).toBe(1)
    expect(Object.keys(r.cache).sort()).toEqual(['__proto__', 'forged'])
  }, 15_000)

  test('"constructor" and "toString" keys are ordinary misses, then ordinary entries', async () => {
    const seen: string[] = []
    const globals: PerExecuteGlobals = {
      echo: (v) => {
        seen.push(String(v))
        return v
      },
    }
    const code = `import { step } from 'tools'
      import { boundary } from 'durable-isolates:internal'
      const a = await step('constructor', 'echo', 'c')
      const b = await boundary('toString', () => 'in-sandbox')
      const c = await boundary('hasOwnProperty', () => 'h')
      export default [a, b, c]`

    const r1 = await runner.execute({ code, cache: {}, globals }).result
    expect(r1.outcome).toBe('completed')
    if (r1.outcome !== 'completed')
      return
    expect(r1.result).toEqual(['c', 'in-sandbox', 'h'])
    expect(r1.cache.constructor).toMatchObject({ seq: 0, status: 'completed', value: 'c' })
    expect(r1.cache.toString).toMatchObject({ seq: 1, status: 'completed', value: 'in-sandbox' })

    const r2 = await runner.execute({ code, cache: r1.cache, globals }).result
    expect(r2.outcome).toBe('completed')
    expect(seen).toEqual(['c']) // replay answered all three from the cache
  }, 15_000)
})

describe('mount guards', () => {
  test('mounting the reserved internal specifier throws (kernel shim cannot be shadowed)', async () => {
    await expect(
      host.prepare({ modules: { 'durable-isolates:internal': { shim: 'export const x = 1' } } }),
    ).rejects.toThrow(/reserved module specifier/)
  })

  test('the bridge globals are non-enumerable — a globalThis sweep never sees them', async () => {
    const code = `export default Object.keys(globalThis).filter(k => k.startsWith('__di_'))`
    const r = await runner.execute({ code, cache: {} }).result
    expect(r.outcome).toBe('completed')
    if (r.outcome !== 'completed')
      return
    expect(r.result).toEqual([])
  }, 15_000)
})

describe('sandbox access (getSandbox)', () => {
  test('lazy: nothing is created until prepare/getSandbox; dispose before then is a no-op', async () => {
    const di = durableIsolates()
    await expect(di.dispose()).resolves.toBeUndefined()
  })

  test('getSandbox() creates the sandbox before any run and is the one prepare uses', async () => {
    const di = durableIsolates()
    try {
      const sandbox = await di.getSandbox()
      expect(await di.getSandbox()).toBe(sandbox)
      const stats = await sandbox.stats() // scrapeable before the first prepare/run
      expect(stats.activeRuns).toBe(0)

      const r = await di.prepare({ modules: { tools: { shim: SHIM } } })
      expect(await di.getSandbox()).toBe(sandbox)
      // `stats().prefixes` lists a prefix once it has an instance — warm one.
      expect((await r.execute({ code: `export default 1`, cache: {} }).result).outcome).toBe('completed')
      expect(Object.keys((await sandbox.stats()).prefixes)).toContain(r.prefixId)
    } finally {
      await di.dispose()
    }
  }, 30_000)

  test('dispose() tears the sandbox down; the next getSandbox() creates a fresh one', async () => {
    const di = durableIsolates()
    const first = await di.getSandbox()
    await di.prepare({ modules: { tools: { shim: SHIM } } })
    await di.dispose()
    expect(first.alive).toBe(false)

    const second = await di.getSandbox()
    try {
      expect(second).not.toBe(first)
      expect(second.alive).toBe(true)
    } finally {
      await di.dispose()
    }
  }, 30_000)
})

describe('iso4 error codes pass through verbatim', () => {
  const codeOf = (r: ExecuteResult): string | undefined =>
    r.outcome === 'failed' ? r.error.code : undefined

  test('ERR_CPU_TIMEOUT', async () => {
    const r = await runner.execute({ code: `while (true) {}`, cache: {}, limits: { cpuTimeMs: 50 } }).result
    expect(codeOf(r)).toBe('ERR_CPU_TIMEOUT')
  }, 15_000)

  test('ERR_WALL_TIMEOUT — and the durable call in flight is still drained into the cache', async () => {
    const globals: PerExecuteGlobals = { slow: () => new Promise((resolve) => {
      setTimeout(resolve, 300, 'late')
    }) }
    const code = `import { step } from 'tools'; export default await step('s', 'slow')`
    const r = await runner.execute({ code, cache: {}, globals, limits: { wallTimeMs: 100 } }).result
    expect(codeOf(r)).toBe('ERR_WALL_TIMEOUT')
    expect(r.cache.s).toMatchObject({ status: 'completed', value: 'late' })
  }, 15_000)

  test('ERR_BRIDGE_CALL_LIMIT_EXCEEDED', async () => {
    const globals: PerExecuteGlobals = { ping: () => 'pong' }
    const code = `import { call } from 'tools'; for (let i = 0; i < 5; i++) await call('ping'); export default 1`
    const r = await runner.execute({ code, cache: {}, globals, limits: { maxBridgeCalls: 2 } }).result
    expect(codeOf(r)).toBe('ERR_BRIDGE_CALL_LIMIT_EXCEEDED')
  }, 15_000)

  test('ERR_MEMORY_LIMIT', async () => {
    const di = durableIsolates({ sandbox: { memoryMb: { hard: 16 } } })
    try {
      const r = await (await di.prepare({ modules: {} })).execute({
        code: `const a = []; while (true) a.push(new Array(1e6).fill(1))`,
        cache: {},
      }).result
      expect(codeOf(r)).toBe('ERR_MEMORY_LIMIT')
    } finally {
      await di.dispose()
    }
  }, 30_000)

  test('ERR_QUEUE_FULL — a capacity refusal is a failed outcome, not a rejection', async () => {
    const di = durableIsolates({ sandbox: { maxConcurrentRuns: 1, maxQueuedRuns: 0 } })
    try {
      const r = await di.prepare({ modules: { tools: { shim: SHIM } } })
      let release!: (v: string) => void
      let entered!: () => void
      const running = new Promise<void>((resolve) => {
        entered = resolve
      })
      const globals: PerExecuteGlobals = {
        hold: () => {
          entered()
          return new Promise<string>((resolve) => {
            release = resolve
          })
        },
      }
      const code = `import { step } from 'tools'; export default await step('h', 'hold')`
      const first = r.execute({ code, cache: {}, globals })
      await running // the one slot is now held

      const refused = await r.execute({ code: `export default 1`, cache: {} }).result
      expect(codeOf(refused)).toBe('ERR_QUEUE_FULL')

      release('done')
      expect((await first.result).outcome).toBe('completed')
    } finally {
      await di.dispose()
    }
  }, 30_000)
})

describe('per-run metrics (iso4 result passed through as `run`)', () => {
  test('completed: RunSuccess verbatim — clocks, heap, logs, kernel bridge calls', async () => {
    const globals: PerExecuteGlobals = { ping: () => 'pong' }
    const code = `import { call } from 'tools'; console.log('hi'); export default await call('ping')`
    const r = await runner.execute({ code, cache: {}, globals }).result
    expect(r.outcome).toBe('completed')
    if (r.outcome !== 'completed')
      return
    expect(r.run.status).toBe('completed')
    expect(r.run.exports.default).toBe(r.result)
    expect(r.run.cpuTimeMs).toBeLessThanOrEqual(r.run.wallTimeMs)
    expect(r.run.wallTimeMs).toBeLessThanOrEqual(r.run.durationMs)
    expect(typeof r.run.heapUsedBytes).toBe('number') // prefix runs report it
    expect(r.run.stdout).toEqual(['hi'])
    // The durable call crosses as the kernel's `__di_call` — filterable.
    expect(r.run.bridgeCalls.map((c) => c.name)).toEqual(['__di_call'])
    expect(r.run.bridgeCalls.filter((c) => !KERNEL_BRIDGE_GLOBALS.some((n) => n === c.name))).toEqual([])

    // A replay answered from the cache still round-trips the bridge.
    const replay = await runner.execute({ code, cache: r.cache, globals }).result
    expect(replay.run.bridgeCalls.map((c) => c.name)).toEqual(['__di_call'])
  }, 15_000)

  test('checkpoints show up as `__di_lookup` / `__di_commit`', async () => {
    const code = `import { boundary } from 'durable-isolates:internal'
      export default await boundary('b', async () => 1)`
    const r = await runner.execute({ code, cache: {} }).result
    expect(r.outcome).toBe('completed')
    expect(r.run.bridgeCalls.map((c) => c.name)).toEqual(['__di_lookup', '__di_commit'])
  }, 15_000)

  test('failed: RunFailure verbatim — `run.error` is `error`, numbers up to the failure', async () => {
    const r = await runner.execute({ code: `while (true) {}`, cache: {}, limits: { cpuTimeMs: 50 } }).result
    expect(r.outcome).toBe('failed')
    if (r.outcome !== 'failed')
      return
    expect(r.run.status).toBe('failed')
    expect(r.run.error).toBe(r.error)
    expect(r.run.cpuTimeMs).toBeGreaterThan(0)
    expect(typeof r.run.wallTimeMs).toBe('number')
    expect(typeof r.run.durationMs).toBe('number')
  }, 15_000)

  test('failed before admission (ERR_QUEUE_FULL): no `queueWaitMs`', async () => {
    const di = durableIsolates({ sandbox: { maxConcurrentRuns: 1, maxQueuedRuns: 0 } })
    try {
      const r = await di.prepare({ modules: { tools: { shim: SHIM } } })
      let release!: (v: string) => void
      let entered!: () => void
      const running = new Promise<void>((resolve) => {
        entered = resolve
      })
      const globals: PerExecuteGlobals = {
        hold: () => {
          entered()
          return new Promise<string>((resolve) => {
            release = resolve
          })
        },
      }
      const first = r.execute({ code: `import { step } from 'tools'; export default await step('h', 'hold')`, cache: {}, globals })
      await running

      const refused = await r.execute({ code: `export default 1`, cache: {} }).result
      expect(refused.outcome).toBe('failed')
      if (refused.outcome !== 'failed')
        return
      expect(refused.run.error.code).toBe('ERR_QUEUE_FULL')
      expect(refused.run.queueWaitMs).toBeUndefined()

      release('done')
      await first.result
    } finally {
      await di.dispose()
    }
  }, 30_000)

  test('suspended: iso4\'s aborted arm with the numbers up to the pause', async () => {
    const globals: PerExecuteGlobals = {
      load: () => 'x',
      approve: () => {
        throw new SuspendIsolate({ need: 'approval' })
      },
    }
    const code = `import { call } from 'tools'
      await call('load')
      export default await call('approve')`
    const r = await runner.execute({ code, cache: {}, globals }).result
    expect(r.outcome).toBe('suspended')
    if (r.outcome !== 'suspended')
      return
    expect(r.run.status).toBe('aborted')
    expect(r.run.bridgeCalls.map((c) => c.name)).toEqual(['__di_call', '__di_call'])
    expect(r.run.bridgeCalls[0]?.ok).toBe(true)
    expect(r.run.bridgeCalls[1]?.ok).toBe(false) // the suspending call never answered
    expect(r.run.durationMs).toBeGreaterThan(0)
    expect(r.run.cpuTimeMs).toBeLessThanOrEqual(r.run.wallTimeMs)
  }, 15_000)

  test('external suspend(): the aborted arm too', async () => {
    let started!: () => void
    const startedOnce = new Promise<void>((resolve) => {
      started = resolve
    })
    const globals: PerExecuteGlobals = {
      slow: async () => {
        started()
        await new Promise((resolve) => {
          setTimeout(resolve, 100)
        })
        return 'io'
      },
    }
    const handle = runner.execute({ code: `import { call } from 'tools'; export default await call('slow')`, cache: {}, globals })
    await startedOnce
    const r = await handle.suspend()
    expect(r.outcome).toBe('suspended')
    expect(r.run.status).toBe('aborted')
    expect(r.run.bridgeCalls.map((c) => c.name)).toEqual(['__di_call'])
  }, 15_000)
})
