import { createSandbox } from '@iso4/sandbox'
import type { HostGlobals, Prefix, Sandbox } from '@iso4/sandbox'
import type {
  CreateDurableIsolates,
  DurableIsolates,
  DurableIsolatesRunner,
} from './types'
import { precompileGlobals, resolveDefaultHandlers, toPrecompileImports } from './mount'
import { executeRun } from './execute'

/**
 * Bind one iso4 sandbox (the Rust core + isolate pool). The sandbox is created
 * lazily on the first `hydrate` and reused for every prefix; `dispose()` tears
 * it — and all its prefixes — down. See {@link CreateDurableIsolates}.
 * @param options the sandbox options for the one iso4 bind
 */
export const durableIsolates: CreateDurableIsolates = (options = {}) => {
  let sandboxPromise: Promise<Sandbox> | null = null

  const getSandbox = (): Promise<Sandbox> => {
    sandboxPromise ??= createSandbox(options.sandbox)
    return sandboxPromise
  }

  const host: DurableIsolates = {
    hydrate: async (hydrateOptions): Promise<DurableIsolatesRunner> => {
      const { modules, limits: hydrateLimits } = hydrateOptions
      const defaults = resolveDefaultHandlers(modules)

      const sandbox = await getSandbox()
      const prefix: Prefix<HostGlobals, Record<string, never>> = await sandbox.precompile({
        code: '',
        globals: precompileGlobals(),
        imports: toPrecompileImports(modules),
      })

      const runner: DurableIsolatesRunner = {
        execute: (executeOptions) => executeRun({
          prefix,
          defaults,
          hydrateLimits,
          code: executeOptions.code,
          cache: executeOptions.cache,
          handlers: executeOptions.handlers,
          executeLimits: executeOptions.limits,
        }),
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
