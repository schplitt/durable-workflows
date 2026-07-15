import type { HostGlobals, Imports } from '@iso4/sandbox'
import type { HostHandler, ModuleDefinition } from './types'
import { DURABLE_CALL_GLOBAL, DURABLE_COMMIT_GLOBAL, DURABLE_LOOKUP_GLOBAL, internalShim, INTERNAL_SPECIFIER } from './shim'

/**
 * Precompile-time placeholder — every run rebinds the bridge, so it's never hit.
 */
function unbound(): never {
  throw new Error('durable-isolates: bridge global called outside a run')
}

/**
 * Build the iso4 `precompile` imports from the mounted modules: each module's
 * shim under its specifier, plus the `durable-isolates:internal` module.
 * Throws if a mounted specifier collides with the reserved kernel module —
 * `durable-isolates:internal` is compiled into every prefix and must not be
 * shadowed by a caller-supplied shim.
 * @param modules the mounted module definitions
 */
export function toPrecompileImports(modules: Readonly<Record<string, ModuleDefinition>>): Imports {
  const imports: Record<string, string> = { [INTERNAL_SPECIFIER]: internalShim }
  for (const [specifier, def] of Object.entries(modules)) {
    if (specifier === INTERNAL_SPECIFIER) {
      throw new Error(
        `durable-isolates: "${INTERNAL_SPECIFIER}" is a reserved module specifier `
        + '(the kernel shim, compiled into every prefix) and cannot be mounted',
      )
    }
    imports[specifier] = def.shim
  }
  return imports
}

/**
 * The three bridge globals declared at precompile (each rebound per run):
 * one per durable primitive — call, lookup, commit.
 */
export function precompileGlobals(): HostGlobals {
  return {
    [DURABLE_CALL_GLOBAL]: unbound,
    [DURABLE_LOOKUP_GLOBAL]: unbound,
    [DURABLE_COMMIT_GLOBAL]: unbound,
  }
}

/**
 * Flatten the modules' default handlers into one `name → handler` registry,
 * erroring on a cross-module name collision (routing is flat by operation name).
 * @param modules the mounted module definitions
 */
export function resolveDefaultHandlers(
  modules: Readonly<Record<string, ModuleDefinition>>,
): Map<string, HostHandler> {
  const index = new Map<string, HostHandler>()
  const owner = new Map<string, string>()
  for (const [specifier, def] of Object.entries(modules)) {
    if (def.handlers === undefined)
      continue
    for (const [name, handler] of Object.entries(def.handlers)) {
      const clash = owner.get(name)
      if (clash !== undefined) {
        throw new Error(
          `durable-isolates: duplicate handler "${name}" mounted by both "${clash}" and "${specifier}" `
          + '(routing is flat by operation name; names must be unique across modules)',
        )
      }
      owner.set(name, specifier)
      index.set(name, handler)
    }
  }
  return index
}
