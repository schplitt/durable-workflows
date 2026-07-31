import { afterEach, describe, expect, test } from 'vitest'
import { SuspendIsolate } from 'durable-isolates'
import type {
  DurableGlobalInput,
  DurableWorkflowsEngine,
  DurableWorkflowsPlugin,
} from '../src'
import { durableWorkflows, INTERNAL_SPECIFIER, memoryStore, WORKFLOW_SPECIFIER } from '../src'

// The engine is tested end-to-end: a real memory store (definitions seeded via
// its `deploy` helper — the test's stand-in for the app's deploy layer), and
// plugin shims built on `durable-workflows:internal` mounted on a REAL sandbox.
// Every assertion drives the whole chain
// (engine → :workflow → :internal → durable-isolates:internal → host → global).

const APPROVALS_SPECIFIER = 'test:approvals'
const APPROVALS_SHIM = /* js */ `
  import { operation } from '${INTERNAL_SPECIFIER}'
  export const approve = (subject) => operation('approve', subject)
  export const tick = () => operation('tick')
`

// A test harness bundling engine + the store + captured global inputs, so each
// test can compose exactly what it needs and dispose cleanly. The store's
// `getDefinition` is instrumented to record every call, so tests can assert
// version pinning.
function harness(pluginOverrides?: Partial<DurableWorkflowsPlugin>) {
  const store = memoryStore()
  const resolveCalls: Array<{ name: string, version?: string }> = []
  const rawGetDefinition = store.getDefinition
  store.getDefinition = async (name, version) => {
    resolveCalls.push(version === undefined ? { name } : { name, version })
    return rawGetDefinition(name, version)
  }
  const seen: DurableGlobalInput[] = []
  let approvalAnswer: string | undefined

  const approvals: DurableWorkflowsPlugin = {
    id: 'approvals',
    shim: APPROVALS_SHIM,
    globals: {
      approve: (input) => {
        seen.push(input)
        if (approvalAnswer === undefined)
          throw new SuspendIsolate({ subject: input.payload })
        return approvalAnswer
      },
      tick: (input) => {
        seen.push(input)
        return 'tock'
      },
    },
    ...pluginOverrides,
  }

  const engines: DurableWorkflowsEngine[] = []
  const make = (extra?: Partial<Parameters<typeof durableWorkflows>[0]>) => {
    const engine = durableWorkflows({
      store,
      plugins: { [APPROVALS_SPECIFIER]: approvals },
      sandbox: { maxIsolates: 4 },
      ...extra,
    })
    engines.push(engine)
    return engine
  }

  return {
    store,
    resolveCalls,
    seen,
    make,
    setAnswer: (v: string | undefined) => {
      approvalAnswer = v
    },
    dispose: () => Promise.all(engines.map((e) => e.dispose())),
  }
}

let active: { dispose: () => Promise<unknown> } | undefined
afterEach(async () => {
  await active?.dispose()
  active = undefined
})

describe('create', () => {
  test('runs the first turn, pins the resolved version, completes', async () => {
    const h = harness()
    active = h
    h.store.deploy('greet', 'v1', `import { defineWorkflow } from '${WORKFLOW_SPECIFIER}'
      export default defineWorkflow({ async run({ input }) { return input.name } })`)
    const engine = h.make()

    const outcome = await engine.create('greet', { name: 'ada' })
    expect(outcome.status).toBe('completed')
    expect(outcome.run).toBe(1)

    // resolver was called WITHOUT a version (create resolves "latest").
    expect(h.resolveCalls).toEqual([{ name: 'greet' }])

    const handle = await engine.get(outcome.instanceId)
    expect(await handle?.status()).toBe('completed')
    const finished = await handle?.outcome()
    expect(finished).toMatchObject({ status: 'completed', workflow: 'greet', version: 'v1', runs: 1 })
  }, 20_000)

  test('idempotent for a repeated instanceId (no second start)', async () => {
    const h = harness()
    active = h
    h.store.deploy('greet', 'v1', `import { defineWorkflow } from '${WORKFLOW_SPECIFIER}'
      export default defineWorkflow({ async run() { return 'ok' } })`)
    const engine = h.make()

    const a = await engine.create('greet', undefined, { instanceId: 'fixed' })
    const b = await engine.create('greet', undefined, { instanceId: 'fixed' })
    expect(a.status).toBe('completed')
    expect(b).toEqual({ instanceId: 'fixed', run: 1, status: 'completed' })
    // Only the first create resolved a definition.
    expect(h.resolveCalls).toEqual([{ name: 'greet' }])
  }, 20_000)
})

describe('global input', () => {
  test('global receives { instanceId, workflow, run, stepId, payload } with payload = full arg list', async () => {
    const h = harness()
    active = h
    h.setAnswer('yes')
    h.store.deploy('flow', 'v1', `import { defineWorkflow, step } from '${WORKFLOW_SPECIFIER}'
      import { approve } from '${APPROVALS_SPECIFIER}'
      export default defineWorkflow({
        async run() { return await step.do('gate', () => approve('ship it')) }
      })`)
    const engine = h.make()

    const outcome = await engine.create('flow', undefined, { instanceId: 'inst-1' })
    expect(outcome.status).toBe('completed')

    expect(h.seen).toHaveLength(1)
    expect(h.seen[0]).toEqual({
      instanceId: 'inst-1',
      workflow: 'flow',
      run: 1,
      stepId: 'gate/approve#0',
      payload: ['ship it'], // the whole argument list, never blended with metadata
    })
  }, 20_000)
})

describe('suspend + continue', () => {
  test('waiting outcome surfaces pending; continueWorkflow resumes on re-dispatch', async () => {
    const h = harness()
    active = h
    h.store.deploy('flow', 'v1', `import { defineWorkflow, step } from '${WORKFLOW_SPECIFIER}'
      import { approve } from '${APPROVALS_SPECIFIER}'
      export default defineWorkflow({
        async run() { return await step.do('gate', () => approve('need sign-off')) }
      })`)
    const engine = h.make()

    const first = await engine.create('flow', undefined, { instanceId: 'inst-2' })
    expect(first.status).toBe('waiting')
    if (first.status !== 'waiting')
      return
    expect(first.pending).toEqual([
      { stepId: 'gate/approve#0', operation: 'approve', payload: { subject: ['need sign-off'] } },
    ])
    const waitingHandle = await engine.get('inst-2')
    expect(await waitingHandle?.status()).toBe('waiting')
    expect(await waitingHandle?.outcome()).toBeNull()

    // Host state changes, then the caller's own wiring re-runs.
    h.setAnswer('approved')
    const second = await engine.continueWorkflow('inst-2')
    expect(second).toMatchObject({ status: 'completed', run: 2 })
  }, 20_000)

  test('a fresh engine sharing the store resumes against the PINNED version', async () => {
    const h = harness()
    active = h
    h.store.deploy('flow', 'v7', `import { defineWorkflow, step } from '${WORKFLOW_SPECIFIER}'
      import { approve } from '${APPROVALS_SPECIFIER}'
      export default defineWorkflow({
        async run() { return await step.do('gate', () => approve('x')) }
      })`)
    const first = h.make()
    const created = await first.create('flow', undefined, { instanceId: 'inst-3' })
    expect(created.status).toBe('waiting')

    // A second engine (simulating a restarted process) shares the store; its
    // runner cache is empty, so continue must re-resolve — with the pinned v7.
    h.setAnswer('ok')
    const second = h.make()
    const resumed = await second.continueWorkflow('inst-3')
    expect(resumed).toMatchObject({ status: 'completed', run: 2 })
    expect(h.resolveCalls).toContainEqual({ name: 'flow', version: 'v7' })
  }, 20_000)
})

describe('eviction & restart', () => {
  test('evict deletes a boundary and everything after it, then replays', async () => {
    const h = harness()
    active = h
    h.store.deploy('flow', 'v1', `import { defineWorkflow, step } from '${WORKFLOW_SPECIFIER}'
      import { tick } from '${APPROVALS_SPECIFIER}'
      export default defineWorkflow({
        async run() { return await step.do('beat', () => tick()) }
      })`)
    const engine = h.make()

    await engine.create('flow', undefined, { instanceId: 'inst-4' })
    expect(h.seen).toHaveLength(1) // the operation dispatched once

    const outcome = await engine.evict('inst-4', 'beat')
    expect(outcome.status).toBe('completed')
    expect(h.seen).toHaveLength(2) // the evicted step re-executed
  }, 20_000)

  test('restart clears the whole cache and re-runs from scratch', async () => {
    const h = harness()
    active = h
    h.store.deploy('flow', 'v1', `import { defineWorkflow, step } from '${WORKFLOW_SPECIFIER}'
      import { tick } from '${APPROVALS_SPECIFIER}'
      export default defineWorkflow({ async run() { return await step.do('beat', () => tick()) } })`)
    const engine = h.make()

    await engine.create('flow', undefined, { instanceId: 'inst-5' })
    const restarted = await engine.restart('inst-5')
    expect(restarted).toMatchObject({ status: 'completed', run: 2 })
    expect(h.seen).toHaveLength(2)
  }, 20_000)
})

describe('terminate', () => {
  test('marks the instance terminated and blocks continuation', async () => {
    const h = harness()
    active = h
    h.store.deploy('flow', 'v1', `import { defineWorkflow, step } from '${WORKFLOW_SPECIFIER}'
      import { approve } from '${APPROVALS_SPECIFIER}'
      export default defineWorkflow({ async run() { return await step.do('gate', () => approve('x')) } })`)
    const engine = h.make()

    await engine.create('flow', undefined, { instanceId: 'inst-6' })
    await engine.terminate('inst-6')

    expect(await (await engine.get('inst-6'))?.status()).toBe('terminated')
    expect((await (await engine.get('inst-6'))?.outcome())?.status).toBe('terminated')
    await expect(engine.continueWorkflow('inst-6')).rejects.toThrow(/terminated/)
  }, 20_000)
})

describe('failure', () => {
  test('an uncaught throw surfaces as a failed outcome + failed instance', async () => {
    const h = harness()
    active = h
    h.store.deploy('boom', 'v1', `import { defineWorkflow, step } from '${WORKFLOW_SPECIFIER}'
      export default defineWorkflow({
        async run() {
          await step.do('explode', () => { const e = new Error('kaboom'); e.reason = 'test'; throw e })
        }
      })`)
    const engine = h.make()

    const outcome = await engine.create('boom', undefined, { instanceId: 'inst-7' })
    expect(outcome.status).toBe('failed')
    if (outcome.status !== 'failed')
      return
    expect(outcome.error.name).toBe('Error')
    expect(outcome.error.message).toBe('kaboom')
    expect(outcome.error.data).toMatchObject({ reason: 'test' })
  }, 20_000)
})

describe('alias', () => {
  test('a whitelabeled specifier re-exports the core workflow module', async () => {
    const h = harness()
    active = h
    h.store.deploy('flow', 'v1', `import { defineWorkflow, step } from 'my:workflow'
      import { tick } from '${APPROVALS_SPECIFIER}'
      export default defineWorkflow({ async run() { return await step.do('beat', () => tick()) } })`)
    const engine = h.make({ alias: { 'my:workflow': WORKFLOW_SPECIFIER } })

    const outcome = await engine.create('flow', undefined, { instanceId: 'inst-8' })
    expect(outcome.status).toBe('completed')
  }, 20_000)
})

describe('observability & lifecycle', () => {
  test('onEvent emits instance + step events; dispose drains pendingPromises', async () => {
    const events: unknown[] = []
    const h = harness()
    active = h
    h.setAnswer('done')
    h.store.deploy('flow', 'v1', `import { defineWorkflow, step } from '${WORKFLOW_SPECIFIER}'
      import { approve } from '${APPROVALS_SPECIFIER}'
      export default defineWorkflow({ async run() { return await step.do('gate', () => approve('go')) } })`)
    const engine = h.make({ onEvent: (e) => events.push(e) })

    const p = engine.create('flow', undefined, { instanceId: 'inst-9' })
    expect(engine.pendingPromises.size).toBe(1)
    await p

    expect(events).toContainEqual({ type: 'instance', instanceId: 'inst-9', status: 'running', run: 0 })
    expect(events).toContainEqual({ type: 'instance', instanceId: 'inst-9', status: 'completed', run: 1 })
    expect(events).toContainEqual({ type: 'step', instanceId: 'inst-9', stepId: 'gate', status: 'completed', run: 1 })
    expect(engine.pendingPromises.size).toBe(0)
  }, 20_000)
})

describe('definitions in the store', () => {
  test('new instances get the last deployed version; deployed versions are immutable', async () => {
    const h = harness()
    active = h
    h.store.deploy('flow', 'v1', `import { defineWorkflow } from '${WORKFLOW_SPECIFIER}'
      export default defineWorkflow({ async run() { return 1 } })`)
    h.store.deploy('flow', 'v2', `import { defineWorkflow } from '${WORKFLOW_SPECIFIER}'
      export default defineWorkflow({ async run() { return 2 } })`)
    const engine = h.make()

    const outcome = await engine.create('flow', undefined, { instanceId: 'inst-10' })
    expect(outcome.status).toBe('completed')
    expect((await (await engine.get('inst-10'))?.outcome())?.version).toBe('v2')

    expect(() => h.store.deploy('flow', 'v2', 'export default null')).toThrow(/immutable/)
  }, 20_000)
})

describe('unknown definition', () => {
  test('create rejects when the store has no definition', async () => {
    const h = harness()
    active = h
    const engine = h.make()
    await expect(engine.create('missing')).rejects.toThrow(/no definition/)
  }, 20_000)
})
