import { runInNewContext } from 'node:vm'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createSafeFetch } from '@iso4/fetch'
import type { BoundaryCache, DurableIsolates, DurableIsolatesRunner, ExecuteResult, PerExecuteGlobals } from '../src'
import { durableIsolates, KERNEL_BRIDGE_GLOBALS, SuspendIsolate } from '../src'

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

  test('parallel leaf calls: keys form in source order even when the second completes first', async () => {
    const globals: PerExecuteGlobals = {
      echo: async (v) => {
        await new Promise((resolve) => {
          setTimeout(resolve, v === 'first' ? 40 : 5) // the second call finishes first
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

  test('a run suspended on approval is inert — suspend() has nothing to drain and resolves the same result', async () => {
    const globals: PerExecuteGlobals = {
      gate: () => {
        throw new SuspendIsolate({})
      },
    }
    const code = `import { call } from 'tools'; export default await call('gate', {})`

    const handle = runner.execute({ code, cache: {}, globals })
    const r1 = await handle.result
    expect(r1.outcome).toBe('suspended')
    if (r1.outcome !== 'suspended')
      return
    expect(r1.pending).toHaveLength(1)
    expect(r1.cache['gate#0']?.status).toBe('waiting')
    expect(await handle.suspend()).toBe(r1) // nothing in flight; the settled result comes back
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
    const code = `import { call } from 'tools'
      let out
      try { await call('boom', {}) } catch (e) { out = [e.name, e.message] }
      export default out`

    const r1 = await runner.execute({ code, cache: {}, globals }).result
    expect(r1.outcome === 'completed' && r1.result).toEqual(['Error', 'kaboom'])
    expect(booms).toBe(1)

    const r2 = await runner.execute({ code, cache: r1.cache, globals }).result
    expect(r2.outcome === 'completed' && r2.result).toEqual(['Error', 'kaboom']) // the SAME error, re-thrown from the cache
    expect(booms).toBe(1)
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
    expect(r.cache['boom#0']).toMatchObject({ status: 'failed', error: { code: 'DENY', reason: 'nope' } })
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

  test('a changed program at an UNRECORDED key just misses and runs — keys are not policed', async () => {
    let bs = 0
    const globals: PerExecuteGlobals = { a: () => 1, b: () => {
      bs += 1
      return 2
    } }

    const r1 = await runner.execute({ code: `import { call } from 'tools'; export default await call('a', {})`, cache: {}, globals }).result
    expect(r1.outcome).toBe('completed')
    if (r1.outcome !== 'completed')
      return

    // 'b#0' is a fresh key: nothing to compare against, so it runs. The
    // abandoned 'a#0' record lingers harmlessly (a recorded key is only checked
    // when the program asks for it).
    const r2 = await runner.execute({ code: `import { call } from 'tools'; export default await call('b', {})`, cache: r1.cache, globals }).result
    expect(r2.outcome).toBe('completed')
    if (r2.outcome !== 'completed')
      return
    expect(r2.result).toBe(2)
    expect(bs).toBe(1)
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
          const bytes = new TextEncoder().encode('hi')
          return { status: 200, headers: { 'content-type': 'text/plain' }, body: decode ? new TextDecoder().decode(bytes) : bytes }
        },
      },
    }).handler,
  })
  const code = `import { call } from 'tools'
    export default await call('fetch', 'https://example.test/file').then((r) => r.body)`

  test('a raw byte body is stored the way JSON writes a Uint8Array — an index object', async () => {
    const r = await runner.execute({ code, cache: {}, globals: fetchGlobals(false) }).result
    expect(r.outcome).toBe('completed')
    if (r.outcome !== 'completed')
      return
    expect(r.result).toEqual({ 0: 104, 1: 105 }) // not bytes any more: decode in the middleware instead
  }, 20_000)

  test('converting the body to text in the middleware keeps it usable', async () => {
    const r = await runner.execute({ code, cache: {}, globals: fetchGlobals(true) }).result
    expect(r.outcome).toBe('completed')
    if (r.outcome !== 'completed')
      return
    expect(r.result).toBe('hi')
  }, 20_000)
})

describe('values cross as JSON (converted like JSON.stringify, same on every run)', () => {
  test('a host result is read back from JSON: Date → ISO string, Map → {}, NaN → null, class → fields, function dropped', async () => {
    class Money {
      cents: number
      constructor(cents: number) {
        this.cents = cents
      }

      toJSON() {
        return { amount: this.cents / 100 }
      }
    }
    const globals: PerExecuteGlobals = {
      load: () => ({ at: new Date(0), m: new Map([['k', 1]]), n: Number.NaN, money: new Money(500), fn: () => 1, bytes: new Uint8Array([1]) }),
    }
    const code = `import { call } from 'tools'; export default await call('load', {})`
    const expected = { at: '1970-01-01T00:00:00.000Z', m: {}, n: null, money: { amount: 5 }, bytes: { 0: 1 } }

    const r1 = await runner.execute({ code, cache: {}, globals }).result
    expect(r1.outcome).toBe('completed')
    if (r1.outcome !== 'completed')
      return
    expect(r1.result).toEqual(expected) // the first run already sees the JSON shape
    expect(r1.cache['load#0']).toMatchObject({ value: expected })

    const roundTripped = JSON.parse(JSON.stringify(r1.cache)) as typeof r1.cache
    const r2 = await runner.execute({ code, cache: roundTripped, globals }).result
    expect(r2.outcome).toBe('completed')
    if (r2.outcome !== 'completed')
      return
    expect(r2.result).toEqual(expected) // and so does every replay
  }, 15_000)

  test('sandbox args are written as JSON on the real object: toJSON honoured, class flattened, getter read once', async () => {
    const seen: unknown[] = []
    const globals: PerExecuteGlobals = {
      save: (...args) => {
        seen.push(args)
        return 'saved'
      },
    }
    const code = `import { call } from 'tools'
      class Req { constructor() { this.id = 1 } toJSON() { return { id: 'req-1' } } }
      let reads = 0
      const opts = { get n() { return ++reads }, when: new Date(0), cb() {}, list: [undefined, Symbol('s')] }
      const out = await call('save', new Req(), opts)
      export default { out, reads }`

    const r = await runner.execute({ code, cache: {}, globals }).result
    expect(r.outcome).toBe('completed')
    if (r.outcome !== 'completed')
      return
    expect(r.result).toEqual({ out: 'saved', reads: 1 })
    const args = [{ id: 'req-1' }, { n: 1, when: '1970-01-01T00:00:00.000Z', list: [null, null] }]
    expect(seen).toEqual([args]) // the global gets the JSON reading
    expect(r.cache['save#0']).toMatchObject({ args }) // and so does the record
  }, 15_000)

  test('a boundary() body value is read back from JSON before the program sees it', async () => {
    const code = `import { boundary } from 'durable-isolates:internal'
      class Money { constructor(c) { this.cents = c } toJSON() { return { amount: this.cents / 100 } } }
      let reads = 0
      const v = await boundary('m', () => ({ money: new Money(500), get a() { return ++reads }, gone: undefined, list: [undefined, -0] }))
      export default { v, reads }`

    const r = await runner.execute({ code, cache: {}, globals: {} }).result
    expect(r.outcome).toBe('completed')
    if (r.outcome !== 'completed')
      return
    const expected = { money: { amount: 5 }, a: 1, list: [null, 0] }
    expect(r.result).toEqual({ v: expected, reads: 1 })
    expect(r.cache.m).toMatchObject({ value: expected })
    expect(Object.is((r.cache.m as { value: { list: number[] } }).value.list[1], 0)).toBe(true) // -0 → 0
  }, 15_000)

  test('a bare undefined is an absent value, on the first run and after a store round trip', async () => {
    const globals: PerExecuteGlobals = { nothing: () => undefined }
    const code = `import { call } from 'tools'
      import { boundary } from 'durable-isolates:internal'
      export default { a: await call('nothing', {}), b: await boundary('b', () => undefined) }`

    const r1 = await runner.execute({ code, cache: {}, globals }).result
    expect(r1.outcome).toBe('completed')
    if (r1.outcome !== 'completed')
      return
    expect(r1.result).toEqual({ a: undefined, b: undefined })
    expect(r1.cache.b).toEqual({ seq: 1, status: 'completed' })

    const roundTripped = JSON.parse(JSON.stringify(r1.cache)) as typeof r1.cache
    const r2 = await runner.execute({ code, cache: roundTripped, globals }).result
    expect(r2.outcome).toBe('completed')
    if (r2.outcome !== 'completed')
      return
    expect(r2.result).toEqual({ a: undefined, b: undefined })
  }, 15_000)

  test('an own __proto__ key in a sandbox value reaches the global as data, not as a prototype', async () => {
    let inside: unknown
    const globals: PerExecuteGlobals = {
      inspect: (o) => {
        inside = { keys: Object.keys(o as object), isAdmin: (o as { isAdmin?: unknown }).isAdmin }
        return 'ok'
      },
    }
    const code = `import { call } from 'tools'; export default await call('inspect', JSON.parse('{"__proto__":{"isAdmin":true},"a":1}'))`

    const r = await runner.execute({ code, cache: {}, globals }).result
    expect(r.outcome).toBe('completed')
    expect(inside).toEqual({ keys: ['__proto__', 'a'], isAdmin: undefined })
  }, 15_000)

  test('lossy host results are recorded as JSON reads them, identically on replay: Error → {}, Response → {}, -0 → 0', async () => {
    const globals: PerExecuteGlobals = {
      load: () => ({ err: new Error('boom'), res: new Response('hi'), zero: -0, proto: JSON.parse('{"__proto__":{"x":1},"y":2}') }),
    }
    const code = `import { call } from 'tools'; export default await call('load', {})`
    const expected = { err: {}, res: {}, zero: 0, proto: { ['__proto__']: { x: 1 }, y: 2 } }

    const r1 = await runner.execute({ code, cache: {}, globals }).result
    expect(r1.outcome).toBe('completed')
    if (r1.outcome !== 'completed')
      return
    expect(r1.result).toEqual(expected)
    expect(Object.keys((r1.result as { proto: object }).proto)).toEqual(['__proto__', 'y'])
    expect(Object.is((r1.result as { zero: number }).zero, 0)).toBe(true)

    const roundTripped = JSON.parse(JSON.stringify(r1.cache)) as typeof r1.cache
    const r2 = await runner.execute({ code, cache: roundTripped, globals }).result
    expect(r2.outcome).toBe('completed')
    if (r2.outcome !== 'completed')
      return
    expect(r2.result).toEqual(expected)
    expect(Object.keys((r2.result as { proto: object }).proto)).toEqual(['__proto__', 'y'])
  }, 15_000)
})

describe('what JSON refuses rejects the run (bigint, cycles)', () => {
  test('a global returning a bigint rejects the run; nothing is recorded at the key', async () => {
    const globals: PerExecuteGlobals = { count: () => ({ items: [0, 1, { total: 10n }] }) }
    const code = `import { call } from 'tools'; export default await call('count', {})`

    const r = await runner.execute({ code, cache: {}, globals }).result
    expect(r.outcome).toBe('rejected')
    if (r.outcome !== 'rejected')
      return
    expect(r.rejection).toEqual({
      reason: 'non-json',
      source: 'result',
      key: 'count#0',
      name: 'count',
      detail: expect.stringContaining('BigInt'),
      message: expect.stringContaining('a value in what a global returned cannot be written as JSON'),
    })
    expect(r.rejection.message).toContain('no bigint, no circular structure')
    expect(r.cache).toEqual({}) // not recorded — fix the global and run the same cache again
    expect(r.run.status).toBe('aborted')
  }, 15_000)

  test('a cyclic argument from the sandbox rejects the run before any lookup; the global never runs', async () => {
    let calls = 0
    const globals: PerExecuteGlobals = {
      save: () => {
        calls += 1
        return 'ok'
      },
    }
    const code = `import { call } from 'tools'
      const o = { name: 'loop' }; o.self = o
      export default await call('save', o)`

    const r = await runner.execute({ code, cache: {}, globals }).result
    expect(r.outcome).toBe('rejected')
    if (r.outcome !== 'rejected')
      return
    expect(r.rejection).toMatchObject({ reason: 'non-json', source: 'args', key: 'save#0', name: 'save', detail: expect.stringContaining('circular') })
    expect(r.rejection.message).toContain('a value in an argument of a durable call cannot be written as JSON')
    expect(r.rejection.message).not.toContain('save') // no program-written text in the message
    expect(r.rejection.message).not.toContain('self')
    expect(calls).toBe(0)
    expect(r.cache).toEqual({})
  }, 15_000)

  test('a global throwing a non-Error value JSON refuses rejects the run', async () => {
    const globals: PerExecuteGlobals = {
      boom: () => {
        // eslint-disable-next-line no-throw-literal -- exercising a non-Error throw on purpose
        throw { code: 1n }
      },
    }
    const code = `import { call } from 'tools'; export default await call('boom', {})`

    const r = await runner.execute({ code, cache: {}, globals }).result
    expect(r.outcome).toBe('rejected')
    if (r.outcome !== 'rejected')
      return
    expect(r.rejection).toMatchObject({ reason: 'non-json', source: 'error', key: 'boom#0', name: 'boom' })
    expect(r.rejection.message).toContain('in what a global threw')
  }, 15_000)

  test('a boundary() body returning a bigint rejects the run at the commit', async () => {
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
      detail: expect.stringContaining('BigInt'),
      message: expect.stringContaining('a value in a committed value cannot be written as JSON'),
    })
    expect(r.cache).toEqual({})
  }, 15_000)

  test('a sandbox try/catch around the violating call cannot swallow the rejection', async () => {
    const globals: PerExecuteGlobals = { big: () => 1n }
    const code = `import { call } from 'tools'
      let out = 'not reached'
      try { await call('big', {}) } catch (e) { out = 'caught: ' + e.message }
      export default out`

    const r = await runner.execute({ code, cache: {}, globals }).result
    expect(r.outcome).toBe('rejected')
    if (r.outcome !== 'rejected')
      return
    expect(r.run.status).toBe('aborted') // the catch block never ran
    expect(r.rejection).toMatchObject({ source: 'result', key: 'big#0' })
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
      bad: async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 10)
        })
        return 1n
      },
      alsoBad: async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 30) // in flight when `bad` rejects the run — its own violation is dropped
        })
        return 2n
      },
    }
    const code = `import { call } from 'tools'
      export default await Promise.all([call('slow', {}), call('bad', {}), call('alsoBad', {})])`

    const r1 = await runner.execute({ code, cache: {}, globals }).result
    expect(r1.outcome).toBe('rejected')
    if (r1.outcome !== 'rejected')
      return
    expect(r1.rejection).toMatchObject({ key: 'bad#0' })
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

    const changed = `import { step } from 'tools'; export default await step('k', 'p', 1n)`
    const r2 = await runner.execute({ code: changed, cache: r1.cache, globals }).result
    expect(r2.outcome).toBe('rejected')
    if (r2.outcome !== 'rejected')
      return
    expect(r2.rejection).toMatchObject({ source: 'args', key: 'k' })
  }, 15_000)

  test('a program that never awaits the violating call is still rejected', async () => {
    const globals: PerExecuteGlobals = { bad: () => 1n }
    const code = `import { call } from 'tools'
      call('bad', {}) // fire and forget
      export default 'done'`

    const r = await runner.execute({ code, cache: {}, globals }).result
    expect(r.outcome).toBe('rejected')
    if (r.outcome !== 'rejected')
      return
    expect(r.rejection).toMatchObject({ source: 'result', key: 'bad#0' })
  }, 15_000)

  test('calls queued behind a rejecting call do not run their globals (iso4 >= 0.6.2 drops them)', async () => {
    let charges = 0
    const globals: PerExecuteGlobals = {
      bad: () => 1n,
      charge: () => {
        charges += 1
        return 'ok'
      },
    }
    const code = `import { step } from 'tools'
      const first = step('a', 'bad', {}) // the host rejects the run while handling this frame
      const rest = [1, 2, 3].map((i) => step('k' + i, 'charge', {})) // sent in the same synchronous stretch
      export default await Promise.all([first, ...rest])`

    const r = await runner.execute({ code, cache: {}, globals }).result
    expect(r.outcome).toBe('rejected')
    expect(charges).toBe(0) // nothing ran after the rejection
    expect(r.cache).toEqual({})
  }, 15_000)

  test('a program calling the commit bridge directly with non-text is rejected (the trust boundary holds)', async () => {
    const code = `globalThis.__di_commit('k', 123); export default 'done'`

    const r = await runner.execute({ code, cache: {}, globals: {} }).result
    expect(r.outcome).toBe('rejected')
    if (r.outcome !== 'rejected')
      return
    expect(r.rejection).toMatchObject({ source: 'commit', key: 'k', detail: 'not JSON text' })
    expect(r.cache).toEqual({})
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

  test('a host toJSON or getter that throws rejects the run with its message as detail', async () => {
    const globals: PerExecuteGlobals = { load: () => ({ toJSON() {
      throw new Error('nope')
    } }) }
    const r = await runner.execute({ code: `import { call } from 'tools'; export default await call('load', {})`, cache: {}, globals }).result
    expect(r.outcome).toBe('rejected')
    if (r.outcome !== 'rejected')
      return
    expect(r.rejection).toMatchObject({ reason: 'non-json', source: 'result', detail: 'nope' })
  }, 15_000)

  test('a sandbox toJSON that throws rejects the run too; the message says nothing about the value', async () => {
    const code = `import { boundary } from 'durable-isolates:internal'
      export default await boundary('k', () => ({ toJSON() { throw new Error('secret-ish text') } }))`
    const r = await runner.execute({ code, cache: {}, globals: {} }).result
    expect(r.outcome).toBe('rejected')
    if (r.outcome !== 'rejected')
      return
    expect(r.rejection).toMatchObject({ source: 'commit', key: 'k', detail: 'secret-ish text' })
    expect(r.rejection.message).not.toContain('secret-ish')
  }, 15_000)

  test('a serializer complaint that cannot be read falls back to a fixed detail; a long one is cut', async () => {
    const globals: PerExecuteGlobals = {
      weird: () => ({ toJSON() {
        throw Object.create(null) // String() of this throws
      } }),
      loud: () => ({ toJSON() {
        throw new Error('x'.repeat(5000))
      } }),
    }
    const r1 = await runner.execute({ code: `import { call } from 'tools'; export default await call('weird', {})`, cache: {}, globals }).result
    expect(r1.outcome).toBe('rejected')
    if (r1.outcome !== 'rejected')
      return
    expect(r1.rejection).toMatchObject({ source: 'result', detail: 'unserializable value' })

    const r2 = await runner.execute({ code: `import { call } from 'tools'; export default await call('loud', {})`, cache: {}, globals }).result
    expect(r2.outcome).toBe('rejected')
    if (r2.outcome !== 'rejected')
      return
    expect((r2.rejection as { detail: string }).detail.length).toBe(1024)
  }, 15_000)

  test('a program calling the call bridge directly with non-array args is rejected', async () => {
    const globals: PerExecuteGlobals = { e: () => 'ran' }
    const code = `globalThis.__di_call('k', 'e', '{"a":1}'); export default 'done'`
    const r = await runner.execute({ code, cache: {}, globals }).result
    expect(r.outcome).toBe('rejected')
    if (r.outcome !== 'rejected')
      return
    expect(r.rejection).toMatchObject({ source: 'args', key: 'k', detail: 'args are not a JSON array' })
    expect(r.cache).toEqual({})
  }, 15_000)

  test('the shim uses captured JSON intrinsics: a program patching JSON.stringify cannot change what crosses', async () => {
    const seen: unknown[] = []
    const globals: PerExecuteGlobals = {
      save: (...args) => {
        seen.push(args)
        return 'ok'
      },
    }
    // iso4 keeps globalThis between runs on a warm instance, so the patch is
    // undone before the program ends — otherwise it would poison later runs.
    const code = `import { call } from 'tools'
      const [origStringify, origParse] = [JSON.stringify, JSON.parse]
      JSON.stringify = () => '[{"evil":1}]'
      JSON.parse = () => 'evil'
      let out
      try {
        out = await call('save', { real: true })
      } finally {
        JSON.stringify = origStringify
        JSON.parse = origParse
      }
      export default out`
    const r = await runner.execute({ code, cache: {}, globals }).result
    expect(r.outcome).toBe('completed')
    expect(seen).toEqual([[{ real: true }]])
  }, 15_000)

  test('a thrown symbol has no JSON reading and is recorded with a fixed shape', async () => {
    const globals: PerExecuteGlobals = {
      boom: () => {
        throw Symbol('s')
      },
    }
    const code = `import { call } from 'tools'
      let out
      try { await call('boom', {}) } catch (e) { out = [e.name, e.message] }
      export default out`
    const r = await runner.execute({ code, cache: {}, globals }).result
    expect(r.outcome).toBe('completed')
    if (r.outcome !== 'completed')
      return
    expect(r.result).toEqual(['Error', 'non-JSON throw'])
    expect(r.cache['boom#0']).toMatchObject({ status: 'failed', error: { name: 'Error', message: 'non-JSON throw' } })
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

describe('replay divergence (recorded key, different call)', () => {
  // Two programs that differ only in the order their parallel calls are
  // issued — what a completion-order-dependent program looks like across runs.
  const inOrder = `import { call } from 'tools'
    export default await Promise.all([call('echo', 'first'), call('echo', 'second')])`
  const reordered = `import { call } from 'tools'
    export default await Promise.all([call('echo', 'second'), call('echo', 'first')])`

  test('reordered parallel calls diverge: echo#0 was recorded for other args', async () => {
    let echoes = 0
    const globals: PerExecuteGlobals = {
      echo: (v) => {
        echoes += 1
        return v
      },
    }
    const r1 = await runner.execute({ code: inOrder, cache: {}, globals }).result
    expect(r1.outcome).toBe('completed')

    const r2 = await runner.execute({ code: reordered, cache: r1.cache, globals }).result
    expect(r2.outcome).toBe('rejected')
    if (r2.outcome !== 'rejected')
      return
    expect(r2.rejection).toEqual({
      reason: 'divergence',
      mismatch: 'args',
      key: 'echo#0',
      recorded: { name: 'echo', args: ['first'] },
      attempted: { name: 'echo', args: ['second'] },
      message: expect.stringContaining('replay divergence: at a recorded boundary the program asked for the same operation with different arguments'),
    })
    expect(r2.rejection.message).toContain('wrap nondeterministic inputs')
    expect(r2.rejection.message).not.toContain('echo') // no program-written text in the message
    expect(echoes).toBe(2) // nothing was dispatched on the diverging run
    expect(r2.cache).toEqual(r1.cache) // the history is left as it was
    expect(r2.run.status).toBe('aborted')
  }, 15_000)

  test('same key, different operation name', async () => {
    const globals: PerExecuteGlobals = { a: () => 1, b: () => 2 }
    const r1 = await runner.execute({ code: `import { step } from 'tools'; export default await step('k', 'a', {})`, cache: {}, globals }).result
    expect(r1.outcome).toBe('completed')

    const r2 = await runner.execute({ code: `import { step } from 'tools'; export default await step('k', 'b', {})`, cache: r1.cache, globals }).result
    expect(r2.outcome).toBe('rejected')
    if (r2.outcome !== 'rejected')
      return
    expect(r2.rejection).toMatchObject({ reason: 'divergence', mismatch: 'name', key: 'k', recorded: { name: 'a' }, attempted: { name: 'b' } })
    expect(r2.rejection.message).toContain('asked for a different operation')
  }, 15_000)

  test('a waiting boundary is NOT re-dispatched when the resume asks with other args', async () => {
    let approves = 0
    const globals: PerExecuteGlobals = {
      approve: () => {
        approves += 1
        throw new SuspendIsolate({})
      },
    }
    const r1 = await runner.execute({ code: `import { step } from 'tools'; export default await step('gate', 'approve', { subject: 'a' })`, cache: {}, globals }).result
    expect(r1.outcome).toBe('suspended')

    const r2 = await runner.execute({ code: `import { step } from 'tools'; export default await step('gate', 'approve', { subject: 'b' })`, cache: r1.cache, globals }).result
    expect(r2.outcome).toBe('rejected')
    if (r2.outcome !== 'rejected')
      return
    expect(r2.rejection).toMatchObject({ mismatch: 'args', key: 'gate', recorded: { args: [{ subject: 'a' }] }, attempted: { args: [{ subject: 'b' }] } })
    expect(approves).toBe(1) // the global was not consulted
    expect(r2.cache.gate).toMatchObject({ status: 'waiting' }) // still waiting, untouched
  }, 15_000)

  test('a failed record is NOT re-thrown when the program asks with other args', async () => {
    const globals: PerExecuteGlobals = {
      boom: () => {
        throw new Error('nope')
      },
    }
    const r1 = await runner.execute({ code: `import { step } from 'tools'; try { await step('k', 'boom', 1) } catch {}; export default 'ok'`, cache: {}, globals }).result
    expect(r1.outcome).toBe('completed')

    const r2 = await runner.execute({ code: `import { step } from 'tools'; try { await step('k', 'boom', 2) } catch {}; export default 'ok'`, cache: r1.cache, globals }).result
    expect(r2.outcome).toBe('rejected')
    if (r2.outcome !== 'rejected')
      return
    expect(r2.run.status).toBe('aborted') // the try/catch around the call did not help: the program never got to complete
    expect(r2.rejection).toMatchObject({ mismatch: 'args', recorded: { args: [1] }, attempted: { args: [2] } })
  }, 15_000)

  test('a durable call at a checkpoint key diverges: the record holds no call', async () => {
    const globals: PerExecuteGlobals = { load: () => 'from-global' }
    const r1 = await runner.execute({ code: `import { boundary } from 'durable-isolates:internal'; export default await boundary('k', () => 'from-body')`, cache: {}, globals }).result
    expect(r1.outcome).toBe('completed')

    const r2 = await runner.execute({ code: `import { step } from 'tools'; export default await step('k', 'load', {})`, cache: r1.cache, globals }).result
    expect(r2.outcome).toBe('rejected')
    if (r2.outcome !== 'rejected')
      return
    expect(r2.rejection).toEqual({
      reason: 'divergence',
      mismatch: 'no-call',
      key: 'k',
      recorded: {},
      attempted: { name: 'load', args: [{}] },
      message: expect.stringContaining('the record holds no call to compare'),
    })
  }, 15_000)

  test('reordered object keys in args are NOT a divergence; reordered array items are', async () => {
    const globals: PerExecuteGlobals = { save: () => 'saved' }
    const r1 = await runner.execute({ code: `import { step } from 'tools'; export default await step('k', 'save', { a: 1, b: { x: [1, 2] } })`, cache: {}, globals }).result
    expect(r1.outcome).toBe('completed')

    const sameKeysReordered = await runner.execute({ code: `import { step } from 'tools'; export default await step('k', 'save', { b: { x: [1, 2] }, a: 1 })`, cache: r1.cache, globals }).result
    expect(sameKeysReordered.outcome).toBe('completed')

    const arrayReordered = await runner.execute({ code: `import { step } from 'tools'; export default await step('k', 'save', { a: 1, b: { x: [2, 1] } })`, cache: r1.cache, globals }).result
    expect(arrayReordered.outcome).toBe('rejected')
  }, 15_000)

  test('a sandbox try/catch cannot swallow a divergence; a parallel branch in flight is drained', async () => {
    let slowRuns = 0
    const globals: PerExecuteGlobals = {
      a: () => 'a',
      slow: async () => {
        slowRuns += 1
        await new Promise((resolve) => {
          setTimeout(resolve, 100)
        })
        return 'slow-result'
      },
    }
    const r1 = await runner.execute({ code: `import { step } from 'tools'; export default await step('k', 'a', 1)`, cache: {}, globals }).result
    expect(r1.outcome).toBe('completed')

    const code = `import { step } from 'tools'
      const slow = step('slow', 'slow', {})
      let out = 'not reached'
      try { await step('k', 'a', 2) } catch (e) { out = 'caught: ' + e.message }
      await slow
      export default out`
    const r2 = await runner.execute({ code, cache: r1.cache, globals }).result
    expect(r2.outcome).toBe('rejected')
    if (r2.outcome !== 'rejected')
      return
    expect(r2.rejection).toMatchObject({ reason: 'divergence', key: 'k' })
    expect(r2.run.status).toBe('aborted') // the catch block never ran — a catchable throw would have let the program complete
    expect(r2.cache.slow).toMatchObject({ status: 'completed', value: 'slow-result' }) // drained write kept
    expect(slowRuns).toBe(1)
  }, 15_000)

  test('a global that edits its options in place does not rewrite the recorded args', async () => {
    let sends = 0
    const globals: PerExecuteGlobals = {
      send: (opts) => {
        sends += 1
        ;(opts as { retries?: number }).retries ??= 3 // defaulting in place — common and harmless
        return 'sent'
      },
    }
    const code = `import { step } from 'tools'; export default await step('k', 'send', { to: 'a' })`

    const r1 = await runner.execute({ code, cache: {}, globals }).result
    expect(r1.outcome).toBe('completed')
    expect(r1.cache.k).toMatchObject({ args: [{ to: 'a' }] }) // the record holds what the program passed

    const r2 = await runner.execute({ code, cache: r1.cache, globals }).result
    expect(r2.outcome).toBe('completed') // no false divergence
    expect(sends).toBe(1)
  }, 15_000)

  test('a waiting global that edits its options can still be resumed', async () => {
    let ready = false
    const globals: PerExecuteGlobals = {
      sleep: (o) => {
        ;(o as { until?: number }).until ??= 123
        if (!ready)
          throw new SuspendIsolate({})
        return 'woke'
      },
    }
    const code = `import { step } from 'tools'; export default await step('nap', 'sleep', { ms: 5 })`

    const r1 = await runner.execute({ code, cache: {}, globals }).result
    expect(r1.outcome).toBe('suspended')
    expect(r1.cache.nap).toEqual({ seq: 0, status: 'waiting', name: 'sleep', args: [{ ms: 5 }] })

    ready = true
    const r2 = await runner.execute({ code, cache: r1.cache, globals }).result
    expect(r2.outcome).toBe('completed')
    if (r2.outcome !== 'completed')
      return
    expect(r2.result).toBe('woke')
  }, 15_000)
})

describe('error reduction edge cases', () => {
  test('an Error whose message getter throws is recorded with a fixed text; the run settles', async () => {
    const globals: PerExecuteGlobals = {
      boom: () => {
        const e = new Error('x')
        Object.defineProperty(e, 'message', { get() {
          throw new Error('getter boom')
        } })
        throw e
      },
    }
    const code = `import { call } from 'tools'
      let out
      try { await call('boom', {}) } catch (e) { out = e.message }
      export default out`

    const r = await runner.execute({ code, cache: {}, globals }).result
    expect(r.outcome).toBe('completed')
    if (r.outcome !== 'completed')
      return
    expect(r.result).toBe('unreadable error')
    expect(r.cache['boom#0']).toMatchObject({ status: 'failed', error: { name: 'Error', message: 'unreadable error' } })
  }, 15_000)

  test('an Error from another realm is recorded as a failure, not rejected as non-JSON', async () => {
    const globals: PerExecuteGlobals = {
      boom: () => {
        throw runInNewContext('new TypeError("far away")')
      },
    }
    const code = `import { call } from 'tools'
      let out
      try { await call('boom', {}) } catch (e) { out = [e.name, e.message] }
      export default out`

    const r = await runner.execute({ code, cache: {}, globals }).result
    expect(r.outcome).toBe('completed')
    if (r.outcome !== 'completed')
      return
    expect(r.result).toEqual(['TypeError', 'far away'])
  }, 15_000)

  test('a DOMException (fetch timeout / abort) is a catchable failed step, not a rejected run', async () => {
    const globals: PerExecuteGlobals = {
      slowFetch: () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      },
    }
    const code = `import { call } from 'tools'
      let out
      try { await call('slowFetch', {}) } catch (e) { out = [e.name, e.message] }
      export default out`

    const r = await runner.execute({ code, cache: {}, globals }).result
    expect(r.outcome).toBe('completed')
    if (r.outcome !== 'completed')
      return
    expect(r.result).toEqual(['TimeoutError', 'The operation was aborted due to timeout'])
    expect(r.cache['slowFetch#0']).toMatchObject({ status: 'failed', error: { name: 'TimeoutError' } })
  }, 15_000)

  test('a thrown value with a throwing Symbol.toStringTag getter is still handled (no getter is read)', async () => {
    const globals: PerExecuteGlobals = {
      boom: () => {
        // eslint-disable-next-line no-throw-literal -- exercising a non-Error throw on purpose
        throw { code: 'DENY', get [Symbol.toStringTag]() {
          throw new Error('tag boom')
        } }
      },
    }
    const code = `import { call } from 'tools'
      let out
      try { await call('boom', {}) } catch (e) { out = e.code }
      export default out`

    const r = await runner.execute({ code, cache: {}, globals }).result
    expect(r.outcome).toBe('completed')
    if (r.outcome !== 'completed')
      return
    expect(r.result).toBe('DENY')
  }, 15_000)
})

describe('pinned edge cases', () => {
  test('a suspension the program never awaited is still reported: outcome suspended, pending filled', async () => {
    const globals: PerExecuteGlobals = {
      gate: () => {
        throw new SuspendIsolate({ need: 'approval' })
      },
    }
    const code = `import { step } from 'tools'
      step('g', 'gate', {}) // fire and forget
      export default 'done'`

    const r = await runner.execute({ code, cache: {}, globals }).result
    expect(r.outcome).toBe('suspended')
    if (r.outcome !== 'suspended')
      return
    expect(r.pending).toEqual([{ id: 'g', name: 'gate', payload: { need: 'approval' } }])
    expect(r.cache.g).toMatchObject({ status: 'waiting' })
    expect(r.run.status).toBe('completed') // iso4's own arm is passed through
  }, 15_000)

  test('two parallel suspensions give two pending entries', async () => {
    const globals: PerExecuteGlobals = {
      gate: async (who) => {
        await new Promise((resolve) => {
          setTimeout(resolve, 10)
        })
        throw new SuspendIsolate({ who })
      },
    }
    const code = `import { step } from 'tools'
      export default await Promise.all([step('g1', 'gate', 'a'), step('g2', 'gate', 'b')])`

    const r = await runner.execute({ code, cache: {}, globals }).result
    expect(r.outcome).toBe('suspended')
    if (r.outcome !== 'suspended')
      return
    expect(r.pending.map((p) => p.id).sort()).toEqual(['g1', 'g2'])
    expect(r.cache.g1).toMatchObject({ status: 'waiting', seq: 0 })
    expect(r.cache.g2).toMatchObject({ status: 'waiting', seq: 1 })
  }, 15_000)

  test('args survive a store round trip without a false divergence: Date, undefined, -0, NaN', async () => {
    let saves = 0
    const globals: PerExecuteGlobals = {
      save: () => {
        saves += 1
        return 'saved'
      },
    }
    const code = `import { step } from 'tools'
      export default await step('k', 'save', { d: new Date(0), u: undefined, z: -0, l: [undefined], n: NaN })`

    const r1 = await runner.execute({ code, cache: {}, globals }).result
    expect(r1.outcome).toBe('completed')
    expect(r1.cache.k).toMatchObject({ args: [{ d: '1970-01-01T00:00:00.000Z', z: 0, l: [null], n: null }] })

    const roundTripped = JSON.parse(JSON.stringify(r1.cache)) as typeof r1.cache
    const r2 = await runner.execute({ code, cache: roundTripped, globals }).result
    expect(r2.outcome).toBe('completed')
    expect(saves).toBe(1)
  }, 15_000)

  test('an own __proto__ key inside recorded args takes part in the compare', async () => {
    const globals: PerExecuteGlobals = { save: () => 'saved' }
    const same = `import { step } from 'tools'; export default await step('k', 'save', JSON.parse('{"__proto__":{"x":1},"a":1}'))`
    const changed = `import { step } from 'tools'; export default await step('k', 'save', JSON.parse('{"__proto__":{"x":2},"a":1}'))`

    const r1 = await runner.execute({ code: same, cache: {}, globals }).result
    expect(r1.outcome).toBe('completed')
    const roundTripped = JSON.parse(JSON.stringify(r1.cache)) as typeof r1.cache
    expect((await runner.execute({ code: same, cache: roundTripped, globals }).result).outcome).toBe('completed')

    const r3 = await runner.execute({ code: changed, cache: roundTripped, globals }).result
    expect(r3.outcome).toBe('rejected')
    if (r3.outcome !== 'rejected')
      return
    expect(r3.rejection).toMatchObject({ reason: 'divergence', mismatch: 'args' })
  }, 15_000)

  test('seq continues after the highest seq in the input cache; a rejected dispatch leaves no gap', async () => {
    const globals: PerExecuteGlobals = { a: () => 'a', b: () => 1n }
    const seeded: BoundaryCache = { old: { seq: 5, status: 'completed', value: 'x' } }
    const r1 = await runner.execute({ code: `import { step } from 'tools'; export default await step('n', 'a', {})`, cache: seeded, globals }).result
    expect(r1.outcome).toBe('completed')
    expect(r1.cache.n).toMatchObject({ seq: 6 })

    const code = `import { step } from 'tools'
      const a = await step('a', 'a', {})
      export default await step('b', 'b', {})`
    const r2 = await runner.execute({ code, cache: {}, globals }).result
    expect(r2.outcome).toBe('rejected')
    expect(r2.cache).toEqual({ a: { seq: 0, status: 'completed', name: 'a', args: [{}], value: 'a' } })
    const r3 = await runner.execute({ code, cache: r2.cache, globals: { ...globals, b: () => 'b' } }).result
    expect(r3.outcome).toBe('completed')
    expect(r3.cache.b).toMatchObject({ seq: 1 }) // the rejected dispatch consumed nothing
  }, 15_000)

  test('a nested boundary commits its outer record after the inner calls', async () => {
    const globals: PerExecuteGlobals = { probe: () => 1 }
    const code = `import { boundary, durableCall, nextKey } from 'durable-isolates:internal'
      export default await boundary('outer', async () => (await durableCall(nextKey('probe'), 'probe', {})) + 1)`
    const r = await runner.execute({ code, cache: {}, globals }).result
    expect(r.outcome).toBe('completed')
    expect(r.cache['outer/probe#0']).toMatchObject({ seq: 0 })
    expect(r.cache.outer).toMatchObject({ seq: 1, value: 2 })
  }, 15_000)

  test('default limits: a replay-heavy run makes far more than iso4\'s 10 bridge calls', async () => {
    const globals: PerExecuteGlobals = { ping: () => 'pong' }
    const code = `import { call } from 'tools'
      const out = []
      for (let i = 0; i < 30; i++) out.push(await call('ping', i))
      export default out.length`
    const r = await runner.execute({ code, cache: {}, globals }).result
    expect(r.outcome).toBe('completed')
    if (r.outcome !== 'completed')
      return
    expect(r.result).toBe(30)
  }, 15_000)

  test('prepare limits apply to every run; execute limits override them', async () => {
    const tight = await host.prepare({ modules: { tools: { shim: SHIM } }, limits: { maxBridgeCalls: 3 } })
    const globals: PerExecuteGlobals = { ping: () => 'pong' }
    const code = `import { call } from 'tools'
      for (let i = 0; i < 5; i++) await call('ping', i)
      export default 'ok'`

    const r1 = await tight.execute({ code, cache: {}, globals }).result
    expect(r1.outcome).toBe('failed')
    if (r1.outcome !== 'failed')
      return
    expect(r1.error.code).toBe('ERR_BRIDGE_CALL_LIMIT_EXCEEDED')

    const r2 = await tight.execute({ code, cache: {}, globals, limits: { maxBridgeCalls: 100 } }).result
    expect(r2.outcome).toBe('completed')
    await tight.dispose()
  }, 20_000)

  test('malformed or non-text payloads on either bridge are rejected (program calling the bridge directly)', async () => {
    const globals: PerExecuteGlobals = { e: () => 'ran' }
    for (const [code, source, detail] of [
      [`globalThis.__di_call('k', 'e', '[1'); export default 1`, 'args', 'malformed JSON text'],
      [`globalThis.__di_commit('k', '{x'); export default 1`, 'commit', 'malformed JSON text'],
      [`globalThis.__di_call('k', 'e', 5); export default 1`, 'args', 'not JSON text'],
    ] as const) {
      const r = await runner.execute({ code, cache: {}, globals }).result
      expect(r.outcome).toBe('rejected')
      if (r.outcome !== 'rejected')
        return
      expect(r.rejection).toMatchObject({ reason: 'non-json', source, key: 'k', detail })
      expect(r.cache).toEqual({})
    }
  }, 20_000)

  test('sandbox-side serializer complaints: a plain throw is its text, an unreadable one a fixed text, a long one is cut', async () => {
    const run = (thrown: string) => runner.execute({
      code: `import { boundary } from 'durable-isolates:internal'
        export default await boundary('k', () => ({ toJSON() { throw ${thrown} } }))`,
      cache: {},
      globals: {},
    }).result

    const plain = await run(`'plain'`)
    expect(plain.outcome === 'rejected' && plain.rejection).toMatchObject({ source: 'commit', detail: 'plain' })
    const unreadable = await run(`Object.create(null)`)
    expect(unreadable.outcome === 'rejected' && unreadable.rejection).toMatchObject({ detail: 'unserializable value' })
    const loud = await run(`new Error('x'.repeat(5000))`)
    expect(loud.outcome === 'rejected' && (loud.rejection as { detail: string }).detail.length).toBe(1024)
  }, 20_000)

  test('nothing is recorded or changed at the violating key, for every rejection kind', async () => {
    const globals: PerExecuteGlobals = {
      a: () => 'a',
      boom: () => {
        // eslint-disable-next-line no-throw-literal -- exercising a non-Error throw on purpose
        throw { code: 1n }
      },
    }
    // error source
    const r0 = await runner.execute({ code: `import { step } from 'tools'; export default await step('k', 'boom', {})`, cache: {}, globals }).result
    expect(r0.outcome).toBe('rejected')
    expect(r0.cache).toEqual({})

    // name divergence, no-call divergence, args violation at a recorded key: history untouched
    const r1 = await runner.execute({ code: `import { step } from 'tools'; export default await step('k', 'a', 1)`, cache: {}, globals }).result
    expect(r1.outcome).toBe('completed')
    for (const code of [
      `import { step } from 'tools'; export default await step('k', 'boom', 1)`,
      `import { step } from 'tools'; export default await step('k', 'a', 1n)`,
    ]) {
      const r = await runner.execute({ code, cache: r1.cache, globals }).result
      expect(r.outcome).toBe('rejected')
      expect(r.cache).toEqual(r1.cache)
    }
    const checkpoint = await runner.execute({ code: `import { boundary } from 'durable-isolates:internal'; export default await boundary('c', () => 'v')`, cache: {}, globals }).result
    expect(checkpoint.outcome).toBe('completed')
    const noCall = await runner.execute({ code: `import { step } from 'tools'; export default await step('c', 'a', {})`, cache: checkpoint.cache, globals }).result
    expect(noCall.outcome).toBe('rejected')
    expect(noCall.cache).toEqual(checkpoint.cache)
  }, 30_000)

  test('a record from an older kernel (name without args) is a no-call divergence', async () => {
    const globals: PerExecuteGlobals = { ok: () => 'new' }
    const old: BoundaryCache = { k: { seq: 0, status: 'completed', name: 'ok', value: 'old' } }
    const r = await runner.execute({ code: `import { step } from 'tools'; export default await step('k', 'ok', {})`, cache: old, globals }).result
    expect(r.outcome).toBe('rejected')
    if (r.outcome !== 'rejected')
      return
    expect(r.rejection).toMatchObject({ reason: 'divergence', mismatch: 'no-call', recorded: {} })
  }, 15_000)

  test('the input cache is never mutated and `recorded` is a copy of the history', async () => {
    const globals: PerExecuteGlobals = { a: () => 'a' }
    const input: BoundaryCache = {}
    const r1 = await runner.execute({ code: `import { step } from 'tools'; export default await step('k', 'a', { v: 1 })`, cache: input, globals }).result
    expect(input).toEqual({})
    expect(r1.cache).not.toBe(input)

    const r2 = await runner.execute({ code: `import { step } from 'tools'; export default await step('k', 'a', { v: 2 })`, cache: r1.cache, globals }).result
    expect(r2.outcome).toBe('rejected')
    if (r2.outcome !== 'rejected' || r2.rejection.reason !== 'divergence')
      return
    const recordedArgs = r2.rejection.recorded.args as { v: number }[]
    recordedArgs[0]!.v = 99 // editing the rejection…
    expect(r2.cache.k).toMatchObject({ args: [{ v: 1 }] }) // …does not touch the history
  }, 15_000)

  test('a drained fire-and-forget call lands in the cache even when the program completed first', async () => {
    const globals: PerExecuteGlobals = {
      slow: async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 100)
        })
        return 'late'
      },
    }
    const r = await runner.execute({ code: `import { step } from 'tools'; step('s', 'slow', {}); export default 'done'`, cache: {}, globals }).result
    expect(r.outcome).toBe('completed')
    expect(r.cache.s).toMatchObject({ status: 'completed', value: 'late' })
  }, 15_000)

  test('a boundary() body that throws commits nothing; the error is catchable; the next run re-runs the body', async () => {
    const code = `import { boundary } from 'durable-isolates:internal'
      let out
      try { await boundary('k', () => { throw new Error('body boom') }) } catch (e) { out = e.message }
      export default out`
    const r1 = await runner.execute({ code, cache: {}, globals: {} }).result
    expect(r1.outcome).toBe('completed')
    if (r1.outcome !== 'completed')
      return
    expect(r1.result).toBe('body boom')
    expect(r1.cache).toEqual({})
    const r2 = await runner.execute({ code, cache: r1.cache, globals: {} }).result
    expect(r2.outcome === 'completed' && r2.result).toBe('body boom')
  }, 15_000)

  test('thrown null, undefined and a function: null stays null, the others get the fixed shape', async () => {
    const globals: PerExecuteGlobals = {
      nul: () => {
        // eslint-disable-next-line no-throw-literal -- exercising non-Error throws on purpose
        throw null
      },
      undef: () => {
        // eslint-disable-next-line no-throw-literal -- exercising non-Error throws on purpose
        throw undefined
      },
      fn: () => {
        // eslint-disable-next-line no-throw-literal -- exercising non-Error throws on purpose
        throw () => 1
      },
    }
    const code = `import { step } from 'tools'
      const out = {}
      for (const n of ['nul', 'undef', 'fn']) { try { await step(n, n, {}) } catch (e) { out[n] = e && e.message !== undefined ? e.message : e } }
      export default out`
    const r = await runner.execute({ code, cache: {}, globals }).result
    expect(r.outcome).toBe('completed')
    expect(r.cache.nul).toMatchObject({ status: 'failed', error: null })
    expect(r.cache.undef).toMatchObject({ status: 'failed', error: { name: 'Error', message: 'non-JSON throw' } })
    expect(r.cache.fn).toMatchObject({ status: 'failed', error: { name: 'Error', message: 'non-JSON throw' } })
  }, 15_000)

  test('the SuspendIsolate payload is handed out as is, never through JSON', async () => {
    const payload = { big: 1n, when: new Date(0) }
    const globals: PerExecuteGlobals = {
      gate: () => {
        throw new SuspendIsolate(payload)
      },
    }
    const r = await runner.execute({ code: `import { step } from 'tools'; export default await step('g', 'gate', {})`, cache: {}, globals }).result
    expect(r.outcome === 'suspended' && r.pending[0]?.payload).toBe(payload)
  }, 15_000)

  test('every rejection message is a fixed template', async () => {
    const globals: PerExecuteGlobals = { big: () => 1n, a: () => 'a' }
    const nonJson = await runner.execute({ code: `import { step } from 'tools'; export default await step('k', 'big', {})`, cache: {}, globals }).result
    expect(nonJson.outcome === 'rejected' && nonJson.rejection.message).toBe(
      'durable-isolates: a value in what a global returned cannot be written as JSON. Only values JSON can write may cross a durable boundary: no bigint, no circular structure, no toJSON or getter that throws; convert the value before it reaches one.',
    )
    const first = await runner.execute({ code: `import { step } from 'tools'; export default await step('k', 'a', 1)`, cache: {}, globals }).result
    const diverged = await runner.execute({ code: `import { step } from 'tools'; export default await step('k', 'a', 2)`, cache: first.cache, globals }).result
    expect(diverged.outcome === 'rejected' && diverged.rejection.message).toBe(
      'durable-isolates: replay divergence: at a recorded boundary the program asked for the same operation with different arguments. Durable calls must be deterministic across runs: keep them in the same order (parallel calls must not depend on completion order) and wrap nondeterministic inputs such as time, random values or external state in boundary() so they are recorded once.',
    )
  }, 20_000)

  test('mount: a global defined by two modules is refused; a disposed runner refuses to execute', async () => {
    await expect(host.prepare({ modules: { a: { shim: SHIM, globals: { x: () => 1 } }, b: { shim: SHIM, globals: { x: () => 2 } } } })).rejects.toThrow(/duplicate global "x"/)

    const disposable = await host.prepare({ modules: { tools: { shim: SHIM } } })
    await disposable.dispose()
    const r = await disposable.execute({ code: `export default 1`, cache: {} }).result
    expect(r.outcome).toBe('failed')
    if (r.outcome !== 'failed')
      return
    expect(r.error.code).toBe('ERR_PREFIX_DISPOSED')
  }, 20_000)
})

describe('deep values (iso4 >= 0.6.3 has no host → sandbox nesting cap)', () => {
  // A 200-level nest: far beyond the old 32-level bridge cap, well inside what
  // JSON.stringify/parse handle.
  const deep = (levels: number): unknown => {
    let v: unknown = 'leaf'
    for (let i = 0; i < levels; i++) v = { d: v }
    return v
  }
  const leafOf = (v: unknown): unknown => {
    let cur = v
    for (let i = 0; i < 200; i++) cur = (cur as { d: unknown }).d
    return cur
  }

  test('a deep host result is delivered on the first run and on replay', async () => {
    let loads = 0
    const globals: PerExecuteGlobals = {
      load: () => {
        loads += 1
        return deep(200)
      },
    }
    const code = `import { call } from 'tools'
      let v = await call('load', {}); let n = 0
      while (v && typeof v === 'object') { v = v.d; n++ }
      export default [n, v]`

    const r1 = await runner.execute({ code, cache: {}, globals }).result
    expect(r1.outcome === 'completed' && r1.result).toEqual([200, 'leaf'])
    const roundTripped = JSON.parse(JSON.stringify(r1.cache)) as typeof r1.cache
    const r2 = await runner.execute({ code, cache: roundTripped, globals }).result
    expect(r2.outcome === 'completed' && r2.result).toEqual([200, 'leaf'])
    expect(loads).toBe(1)
  }, 15_000)

  test('a deep committed value and deep args work on the first run and on replay', async () => {
    const seen: unknown[] = []
    const globals: PerExecuteGlobals = {
      save: (v) => {
        seen.push(leafOf(v))
        return 'saved'
      },
    }
    const code = `import { boundary } from 'durable-isolates:internal'
      import { step } from 'tools'
      const make = () => { let v = 'leaf'; for (let i = 0; i < 200; i++) v = { d: v }; return v }
      const committed = await boundary('deep', () => make())
      let v = committed, n = 0
      while (v && typeof v === 'object') { v = v.d; n++ }
      export default [n, v, await step('k', 'save', make())]`

    const r1 = await runner.execute({ code, cache: {}, globals }).result
    expect(r1.outcome === 'completed' && r1.result).toEqual([200, 'leaf', 'saved'])
    expect(leafOf((r1.cache.deep as { value: unknown }).value)).toBe('leaf')
    const roundTripped = JSON.parse(JSON.stringify(r1.cache)) as typeof r1.cache
    const r2 = await runner.execute({ code, cache: roundTripped, globals }).result
    expect(r2.outcome === 'completed' && r2.result).toEqual([200, 'leaf', 'saved'])
    expect(seen).toEqual(['leaf']) // the global ran once; the deep args compared equal on replay
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
  test('dispose() before any prepare/getSandbox is a no-op', async () => {
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
