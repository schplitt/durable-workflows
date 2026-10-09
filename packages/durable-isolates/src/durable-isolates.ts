/**
 * The durable-isolates factory: binds ONE iso4 sandbox (lazily) and prepares
 * prefixes on it. A prefix is the caller's iso4 `imports` and `globals` as
 * they are, plus the kernel shim and its three bridge globals; its
 * `durableGlobals` are the registry a shim reaches through `durableCall`.
 */
import { createSandbox } from '@iso4/sandbox'
import type { HostGlobals, Imports, Prefix, Sandbox } from '@iso4/sandbox'
import type {
  CreateDurableIsolates,
  DurableIsolates,
  DurableIsolatesRunner,
} from './types'
import { assertExecuteOptions, assertPrepareOptions, flattenDurableImports, toDurableImports, toPrepareGlobals, toPrepareImports } from './mount'
import { executeRun } from './execute'

/**
 * Bind ONE iso4 sandbox (lazily, on the first `prepare` or `getSandbox`) and
 * prepare prefixes on it. See {@link DurableIsolates}.
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
            prefix,
            durableGlobals: durable,
            prepareLimits,
            code: executeOptions.code,
            cache: executeOptions.cache,
            importOverrides: executeOptions.imports,
            globalOverrides: executeOptions.globals,
            durableOverrides: executeOptions.durableImports === undefined && executeOptions.durableGlobals === undefined
              ? undefined
              : { ...flattenDurableImports(executeOptions.durableImports), ...executeOptions.durableGlobals },
            executeLimits: executeOptions.limits,
          })
        },
        dispose: () => prefix.dispose(),
      }
      return runner
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
