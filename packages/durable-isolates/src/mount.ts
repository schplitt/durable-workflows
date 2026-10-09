import type { HostGlobals, Imports, ImportValue } from '@iso4/sandbox'
import type { PrepareOptions } from './types'
import { DURABLE_CALL_GLOBAL, DURABLE_COMMIT_GLOBAL, DURABLE_LOOKUP_GLOBAL, internalShim, INTERNAL_SPECIFIER, KERNEL_BRIDGE_GLOBALS } from './shim'

/**
 * Prepare-time placeholder — every run rebinds the bridge, so it's never hit.
 */
function unbound(): never {
  throw new Error('durable-isolates: bridge global called outside a run')
}

/**
 * Check a `prepare` call as a whole, before anything is built, and throw on
 * the first rule it breaks:
 * - the specifier `durable-isolates:internal` is the kernel shim, compiled into
 *   every prefix, and cannot be mounted;
 * - the three bridge global names (`KERNEL_BRIDGE_GLOBALS`) are the kernel's;
 * - a name cannot be both a plain global and a durable global: the two never
 *   collide at runtime (one is `globalThis.name`, the other is reached only
 *   through `durableCall`), but one name meaning two things is a trap for
 *   whoever reads the shim or writes a per-run override.
 * The builders below assume these hold.
 * @param options the caller's prepare options
 */
const RESERVED_GLOBALS: ReadonlySet<string> = new Set(KERNEL_BRIDGE_GLOBALS)

export function assertPrepareOptions(options: PrepareOptions): void {
  if (Object.hasOwn(options.imports ?? {}, INTERNAL_SPECIFIER)) {
    throw new Error(
      `durable-isolates: "${INTERNAL_SPECIFIER}" is a reserved module specifier `
      + '(the kernel shim, compiled into every prefix) and cannot be mounted',
    )
  }
  for (const name of Object.keys(options.globals ?? {})) {
    if (RESERVED_GLOBALS.has(name))
      throw new Error(`durable-isolates: "${name}" is a reserved global (a kernel bridge) and cannot be mounted`)
    if (Object.hasOwn(options.durableGlobals ?? {}, name))
      throw new Error(`durable-isolates: "${name}" is both a plain global and a durable global; give the two different names`)
  }
}

/**
 * Build the iso4 `prepare` imports: the caller's `imports` as they are (iso4
 * semantics — a source string is a sandbox module, a host-module object is
 * plain host functions and data), plus the `durable-isolates:internal`
 * module. Assumes {@link assertPrepareOptions} passed.
 * @param imports the caller's iso4 imports
 */
export function toPrepareImports(imports: Imports | undefined): Imports {
  const out: Record<string, ImportValue> = { [INTERNAL_SPECIFIER]: internalShim, ...imports }
  return out
}

/**
 * Build the iso4 `prepare` globals: the caller's plain `globals` as they are,
 * plus the three bridge globals (one per durable primitive — call, lookup,
 * commit), each rebound per run. The bridges are non-enumerable so
 * enumeration-driven sandbox code (`Object.keys(globalThis)`, spreads) never
 * sweeps them up — the shim reaches them by name. Assumes
 * {@link assertPrepareOptions} passed.
 * @param globals the caller's iso4 globals
 */
export function toPrepareGlobals(globals: HostGlobals | undefined): HostGlobals {
  return {
    ...globals,
    [DURABLE_CALL_GLOBAL]: { kind: 'bridge', handler: unbound, enumerable: false },
    [DURABLE_LOOKUP_GLOBAL]: { kind: 'bridge', handler: unbound, enumerable: false },
    [DURABLE_COMMIT_GLOBAL]: { kind: 'bridge', handler: unbound, enumerable: false },
  }
}
