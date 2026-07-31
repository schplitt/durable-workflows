import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { SuspendIsolate } from 'durable-isolates'
import type { PerExecuteGlobals } from 'durable-isolates'
import type { DurableWorkflowHost, WorkflowRunner } from '../src'
import { durableWorkflowHost, INTERNAL_SPECIFIER, WORKFLOW_SPECIFIER } from '../src'

// The authoring surface is tested end-to-end through the durable-workflows host,
// which wraps the REAL kernel. The caller mounts ONLY a plugin (`test:tools`,
// whose shim is itself built on `durable-workflows:internal`); the core modules
// and the workflow definition are injected by `hydrate`, and the kernel injects
// its own `durable-isolates:internal`. `execute({ input })` builds the main-world
// entry internally — the workflow author never mounts internals or writes the
// entry, and input is baked into the entry as JSON (never a bridge call).
const TOOLS_SPECIFIER = 'test:tools'
const TOOLS_SHIM = /* js */ `
  import { operation } from '${INTERNAL_SPECIFIER}'
  export const probe = () => operation('probe')
  export const approve = () => operation('approve')
`

let host: DurableWorkflowHost

beforeAll(() => {
  host = durableWorkflowHost({ sandbox: { maxIsolates: 4 } })
})

afterAll(async () => {
  await host.dispose()
})

// Hydrate a runner for one workflow definition + the tools plugin.
function hydrate(workflow: string): Promise<WorkflowRunner> {
  return host.hydrate({ workflow, plugins: { [TOOLS_SPECIFIER]: { shim: TOOLS_SHIM } } })
}

describe('host.hydrate', () => {
  test('rejects a plugin that shadows a reserved specifier', async () => {
    await expect(
      host.hydrate({ workflow: 'export default null', plugins: { [WORKFLOW_SPECIFIER]: { shim: '' } } }),
    ).rejects.toThrow(/reserved module specifier/)
  }, 15_000)
})

describe('input', () => {
  test('run receives the JSON input baked into the generated entry (no bridge call)', async () => {
    const runner = await hydrate(`import { defineWorkflow } from '${WORKFLOW_SPECIFIER}'
      export default defineWorkflow({ async run({ input }) { return input.greeting + '!' } })`)

    const r1 = await runner.execute({ input: { greeting: 'hi' }, cache: {} }).result
    expect(r1.outcome).toBe('completed')
    if (r1.outcome !== 'completed')
      return
    expect(r1.result).toBe('hi!')
    expect(Object.keys(r1.cache)).toEqual([]) // no steps, no input round-trip
  }, 15_000)
})

describe('step.do', () => {
  test('body runs once, then replays from the committed value', async () => {
    let probes = 0
    const globals: PerExecuteGlobals = {
      probe: () => {
        probes += 1
        return 5
      },
    }
    const runner = await hydrate(`import { defineWorkflow, step } from '${WORKFLOW_SPECIFIER}'
      import { probe } from '${TOOLS_SPECIFIER}'
      export default defineWorkflow({
        async run({ input }) {
          return await step.do('load', async () => await probe() + input.base)
        }
      })`)

    const r1 = await runner.execute({ input: { base: 10 }, cache: {}, globals }).result
    expect(r1.outcome).toBe('completed')
    if (r1.outcome !== 'completed')
      return
    expect(r1.result).toBe(15)
    expect(probes).toBe(1)
    // the step is the scope: the nested operation key is prefixed under it
    expect(r1.cache.load).toMatchObject({ status: 'completed', value: 15 })
    expect(r1.cache['load/probe#0']).toMatchObject({ status: 'completed', value: 5 })

    const r2 = await runner.execute({ input: { base: 10 }, cache: r1.cache, globals }).result
    expect(r2.outcome === 'completed' && r2.result).toBe(15)
    expect(probes).toBe(1) // body skipped wholesale — the operation never re-dispatched
  }, 15_000)

  test('nested sequential step.do: keys concatenate; the outer commit alone answers replays', async () => {
    const runner = await hydrate(`import { defineWorkflow, step } from '${WORKFLOW_SPECIFIER}'
      export default defineWorkflow({
        async run() {
          return await step.do('outer', async () => {
            const inner = await step.do('inner', async () => 41)
            return inner + 1
          })
        }
      })`)

    const r1 = await runner.execute({ cache: {} }).result
    expect(r1.outcome).toBe('completed')
    if (r1.outcome !== 'completed')
      return
    expect(r1.result).toBe(42)
    expect(Object.keys(r1.cache).sort()).toEqual(['outer', 'outer/inner'])

    // Prune the inner record: the committed outer boundary must skip its body.
    const pruned = { outer: r1.cache.outer! }
    const r2 = await runner.execute({ cache: pruned }).result
    expect(r2.outcome === 'completed' && r2.result).toBe(42)
  }, 15_000)

  test('nested PARALLEL step.do: each branch keys under itself (async context)', async () => {
    const runner = await hydrate(`import { defineWorkflow, step } from '${WORKFLOW_SPECIFIER}'
      export default defineWorkflow({
        async run() {
          const branch = (name) => step.do(name, async () => {
            await Promise.resolve(); await Promise.resolve()
            return await step.do('validate', async () => name)
          })
          return await Promise.all([branch('charge'), branch('refund')])
        }
      })`)

    const r1 = await runner.execute({ cache: {} }).result
    expect(r1.outcome).toBe('completed')
    if (r1.outcome !== 'completed')
      return
    expect(r1.result).toEqual(['charge', 'refund'])
    expect(Object.keys(r1.cache).sort()).toEqual([
      'charge',
      'charge/validate',
      'refund',
      'refund/validate',
    ])
  }, 15_000)

  test('an operation inside a step suspends the run, then resumes on re-dispatch', async () => {
    let answer: string | undefined
    const globals: PerExecuteGlobals = {
      approve: () => {
        if (answer === undefined)
          throw new SuspendIsolate({ need: 'approval' })
        return answer
      },
    }
    const runner = await hydrate(`import { defineWorkflow, step } from '${WORKFLOW_SPECIFIER}'
      import { approve } from '${TOOLS_SPECIFIER}'
      export default defineWorkflow({
        async run() {
          return await step.do('gate', async () => await approve())
        }
      })`)

    const r1 = await runner.execute({ cache: {}, globals }).result
    expect(r1.outcome).toBe('suspended')
    if (r1.outcome !== 'suspended')
      return
    expect(r1.pending[0]?.id).toBe('gate/approve#0') // scope-prefixed operation key
    expect(r1.pending[0]?.payload).toEqual({ need: 'approval' })

    answer = 'approved'
    const r2 = await runner.execute({ cache: r1.cache, globals }).result
    expect(r2.outcome === 'completed' && r2.result).toBe('approved')
  }, 15_000)
})
