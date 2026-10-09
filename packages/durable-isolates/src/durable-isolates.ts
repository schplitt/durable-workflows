/**
 * The durable-isolates factory: binds ONE iso4 sandbox (lazily) and runs
 * replay turns on it — on a prepared prefix (`prepare` → `runner.execute`,
 * warm instances, per-run rebinding) or as one-offs (`run`, a fresh isolate
 * per call). Either way a turn is the caller's iso4 `imports` and `globals`
 * as they are, plus the kernel shim and its three bridge globals, plus the
 * durable registry a shim reaches through `durableCall`.
 */
import { createSandbox } from '@iso4/sandbox'
import type { HostGlobals, Imports, Prefix, RebindGlobals, RebindImports, Sandbox } from '@iso4/sandbox'
import type {
  CreateDurableIsolates,
  DurableIsolates,
  DurableIsolatesRunner,
} from './types'
import { assertExecuteOptions, assertPrepareOptions, flattenDurableImports, toDurableImports, toPrepareGlobals, toPrepareImports } from './mount'
import { executeRun } from './execute'

/**
 * Bind ONE iso4 sandbox (lazily, on the first `prepare`, `run` or
 * `getSandbox`) and run replay turns on it. See {@link DurableIsolates}.
 * @param options iso4 sandbox options (the one Rust bind) — see {@link DurableIsolatesOptions}
 */
export const durableIsolates: CreateDurableIsolates = (options = {}) => {
  let sandboxPromise: Promise<Sandbox> | null = null

  const getSandbox = (): Promise<Sandbox> => {
    sandboxPromise ??= createSandbox(options.sandbox)
    return sandboxPromise
  }

  const host: DurableIsolates = {
    getSandbox,

    prepare: async (prepareOptions): Promise<DurableIsolatesRunner> => {
      assertPrepareOptions(prepareOptions) // every rule, before anything is built
      const { imports = {}, globals = {}, durableGlobals = {}, durableImports, limits: prepareLimits } = prepareOptions

      const generated = toDurableImports(durableImports)
      const durable = new Map(Object.entries({ ...generated.registry, ...durableGlobals })) // built once; each run copies it before applying overrides
      const sandbox = await getSandbox()
      const prefix: Prefix<HostGlobals, Imports> = await sandbox.prepare({
        code: '',
        globals: toPrepareGlobals(globals),
        imports: toPrepareImports({ ...imports, ...generated.shims }),
      })

      const runner: DurableIsolatesRunner = {
        prefixId: prefix.id,
        execute: (executeOptions) => {
          assertExecuteOptions(executeOptions) // shape rules, before the run starts
          return executeRun({
            // The plain side is iso4's: its per-run overrides go through as
            // given (a wrong one fails the run with iso4's own error), and the
            // kernel rebinds only its three bridges.
            start: (bridges, limits, signal) => prefix.execute({
              code: executeOptions.code,
              globals: { ...executeOptions.globals, ...bridges } as RebindGlobals<HostGlobals>,
              // The kernel's imports are dynamic, so iso4's shape-inferred rebind
              // type collapses here; the runtime contract is iso4's.
              imports: executeOptions.imports as unknown as RebindImports<Imports>,
              limits,
              signal,
            }),
            durableGlobals: durable,
            durableOverrides: executeOptions.durableImports === undefined && executeOptions.durableGlobals === undefined
              ? undefined
              : { ...flattenDurableImports(executeOptions.durableImports), ...executeOptions.durableGlobals },
            limits: { ...prepareLimits, ...executeOptions.limits },
            code: executeOptions.code,
            cache: executeOptions.cache,
          })
        },
        dispose: () => prefix.dispose(),
      }
      return runner
    },

    run: (runOptions) => {
      assertPrepareOptions(runOptions) // the same rules as prepare, before anything is built
      const { imports = {}, globals = {}, durableGlobals = {}, durableImports, limits } = runOptions
      const generated = toDurableImports(durableImports)
      return executeRun({
        // A one-off: iso4 compiles everything for this run alone in a fresh
        // isolate, so the bridges are declared with this run's handlers.
        start: async (bridges, mergedLimits, signal) => (await getSandbox()).run({
          code: runOptions.code,
          globals: toPrepareGlobals(globals, bridges),
          imports: toPrepareImports({ ...imports, ...generated.shims }),
          limits: mergedLimits,
          signal,
        }),
        durableGlobals: new Map(Object.entries({ ...generated.registry, ...durableGlobals })),
        durableOverrides: undefined,
        limits,
        code: runOptions.code,
        cache: runOptions.cache,
      })
    },

    dispose: async (): Promise<void> => {
      if (sandboxPromise === null)
        return
      const pending = sandboxPromise
      sandboxPromise = null
      const sandbox = await pending
      await sandbox.dispose()
    },
  }

  return host
}
