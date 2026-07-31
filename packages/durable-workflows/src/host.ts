/**
 * The durable-workflows host — a thin workflow-shaped wrapper over a
 * `durable-isolates` host.
 *
 * `durable-isolates` is the generic replay kernel; it cannot know about the
 * `durable-workflows:*` modules (it is a standalone package this one depends on,
 * so referencing them would invert the dependency). This host is where the
 * workflow layer adds its own surface:
 *
 * - `hydrate({ workflow, plugins })` mounts the workflow definition plus the
 *   caller's plugins, ALWAYS injecting the core modules
 *   (`durable-workflows:workflow` + `:internal`) that every workflow and plugin
 *   shim imports — the caller never mounts them, and a plugin may not shadow a
 *   reserved specifier.
 * - `runner.execute({ input })` runs one replay turn over the cache. The caller
 *   passes only the per-instance `input`; the executed main module is generated
 *   here — it imports the definition's default export and invokes it with the
 *   `input` baked in as a JSON literal.
 */
import type {
  BoundaryCache,
  DurableIsolatesOptions,
  ExecuteHandle,
  ModuleDefinition,
  PerExecuteGlobals,
} from 'durable-isolates'
import type { ResourceLimits } from 'durable-isolates/types/iso4'
import { durableIsolates } from 'durable-isolates'
import { coreModules } from './shim'

/**
 * Reserved specifier the workflow definition is mounted under. Internal: the
 * author never imports it — the generated entry module does.
 */
const DEFINITION_SPECIFIER = 'durable-workflows:definition'

export interface WorkflowHydrateOptions {
  /**
   * The workflow definition's bundled ESM source — `export default
   * defineWorkflow({ run })` (importing `defineWorkflow` from
   * `durable-workflows:workflow` or a whitelabeled alias).
   */
  workflow: string
  /**
   * Capability plugin modules, keyed by the specifier workflow code imports
   * (e.g. `my:sleep`). The core modules and the definition are mounted
   * automatically; a plugin may not use a reserved specifier.
   */
  plugins?: Readonly<Record<string, ModuleDefinition>>
  /**
   * Default iso4 resource limits for every `execute` on this runner;
   * `WorkflowExecuteOptions.limits` overrides per run. Forwarded to the kernel's
   * `hydrate`.
   */
  limits?: Partial<ResourceLimits>
}

export interface WorkflowExecuteOptions {
  /**
   * The per-instance payload passed to the workflow's `run({ input })`, baked
   * into the generated entry as a JSON literal. Must be JSON-serializable.
   */
  input?: unknown
  /**
   * The kernel boundary cache — `{}` on the first run, the grown cache on replay.
   */
  cache: BoundaryCache
  /**
   * Per-run host globals for the mounted plugins, keyed by operation name.
   */
  globals?: PerExecuteGlobals
  /**
   * iso4 resource limits for this run, overriding the runner's `hydrate` default.
   */
  limits?: Partial<ResourceLimits>
}

export interface WorkflowRunner {
  /**
   * Run one replay turn: builds the entry from `input`, runs it over `cache`,
   * and returns the kernel's execute handle (`result` + `suspend`).
   */
  execute: (options: WorkflowExecuteOptions) => ExecuteHandle
  /**
   * Release this workflow's prefix.
   */
  dispose: () => Promise<void>
}

export interface DurableWorkflowHost {
  /**
   * Hydrate a runner for one workflow definition, auto-injecting the core
   * modules and mounting the caller's plugins.
   */
  hydrate: (options: WorkflowHydrateOptions) => Promise<WorkflowRunner>
  /**
   * Await in-flight work and tear down the underlying sandbox.
   */
  dispose: () => Promise<void>
}

/**
 * Create a durable-workflows host. Binds a `durable-isolates` sandbox internally
 * (created lazily on the first `hydrate`) and exposes the workflow-shaped
 * `hydrate`/`execute` surface. See {@link DurableWorkflowHost}.
 * @param options sandbox options forwarded to the underlying durable-isolates host
 */
export function durableWorkflowHost(options?: DurableIsolatesOptions): DurableWorkflowHost {
  const host = durableIsolates(options)
  return {
    hydrate: async ({ workflow, plugins = {}, limits }): Promise<WorkflowRunner> => {
      for (const specifier of Object.keys(plugins)) {
        if (Object.hasOwn(coreModules, specifier) || specifier === DEFINITION_SPECIFIER) {
          throw new Error(
            `durable-workflows: "${specifier}" is a reserved module specifier `
            + '(mounted automatically) and cannot be mounted as a plugin',
          )
        }
      }
      const runner = await host.hydrate({
        modules: { ...coreModules, [DEFINITION_SPECIFIER]: { shim: workflow }, ...plugins },
        ...(limits === undefined ? {} : { limits }),
      })
      return {
        execute: ({ input, cache, globals, limits: runLimits }) => {
          const code = `import workflow from '${DEFINITION_SPECIFIER}'\nexport default await workflow(${JSON.stringify(input) ?? 'undefined'})`
          return runner.execute({
            code,
            cache,
            ...(globals === undefined ? {} : { globals }),
            ...(runLimits === undefined ? {} : { limits: runLimits }),
          })
        },
        dispose: () => runner.dispose(),
      }
    },
    dispose: () => host.dispose(),
  }
}
