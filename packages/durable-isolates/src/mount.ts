import type { HostGlobals, Imports, ImportValue } from '@iso4/sandbox'
import type { DurableGlobal, DurableModule, ExecuteOptions, PrepareOptions } from './types'
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
 *   whoever reads the shim or writes a per-run override;
 * - a `durableImports` module: its specifier is not reserved and not also in
 *   `imports` (one specifier, one module), every export name is an identifier
 *   the generated module can `export`, every leaf is a function (a data value
 *   has nothing to record), and its dotted operation names do not collide
 *   with `durableGlobals`.
 * The builders below assume these hold.
 * @param options the caller's prepare options
 */
const RESERVED_GLOBALS: ReadonlySet<string> = new Set(KERNEL_BRIDGE_GLOBALS)
const IDENTIFIER = /^[A-Z_$][\w$]*$/i
// Everything `export const <name>` cannot bind in a strict-mode module.
const RESERVED_WORDS: ReadonlySet<string> = new Set(['default', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'implements', 'interface', 'package', 'private', 'protected', 'public', 'eval', 'arguments'])

export function assertPrepareOptions(options: PrepareOptions): void {
  if (Object.hasOwn(options.imports ?? {}, INTERNAL_SPECIFIER) || Object.hasOwn(options.durableImports ?? {}, INTERNAL_SPECIFIER)) {
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
  // Every durable import leaf becomes one registry name `specifier.path`; two
  // leaves must not produce the same name (`a.b` + `c` vs `a` + `b.c`).
  const taken = new Map<string, string>()
  for (const [specifier, module] of Object.entries(options.durableImports ?? {})) {
    if (Object.hasOwn(options.imports ?? {}, specifier))
      throw new Error(`durable-isolates: "${specifier}" is both a plain import and a durable import; give the two different specifiers`)
    const walk = (shape: DurableModule, path: string, exported: boolean): void => {
      for (const [name, value] of Object.entries(shape)) {
        const at = `${path}.${name}`
        // Top-level names become `export const <name>`; nested ones are computed
        // keys in an object literal, so any string works there.
        if (exported && (!IDENTIFIER.test(name) || RESERVED_WORDS.has(name) || name.startsWith('__di')))
          throw new Error(`durable-isolates: "${at}" cannot be exported from a durable module ("${name}" is not a usable export name)`)
        if (typeof value === 'function') {
          if (Object.hasOwn(options.durableGlobals ?? {}, at))
            throw new Error(`durable-isolates: "${at}" is both a durable import and a durable global; give the two different names`)
          const other = taken.get(at)
          if (other !== undefined)
            throw new Error(`durable-isolates: "${at}" is produced by two durable imports ("${other}" and "${specifier}"); one name must mean one function`)
          taken.set(at, specifier)
        } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          walk(value, at, false)
        } else {
          throw new Error(`durable-isolates: "${at}" is not a function — a durable module holds functions only (a data value has nothing to record)`)
        }
      }
    }
    walk(module, specifier, true)
  }
}

/**
 * Check an `execute` call's durable overrides up front and throw on a value
 * that is not a function: a per-run `durableGlobals` entry, or a
 * `durableImports` leaf (nested objects allowed). An override may name an
 * operation that was not declared at prepare — supplying a durable function
 * only per run is the credentials pattern — so names are not checked here,
 * and `undefined` is allowed as "unmounted for this run"; a call to a name
 * with no function rejects the run as `unknown-global`.
 * @param options the caller's execute options
 */
export function assertExecuteOptions(options: ExecuteOptions): void {
  for (const [name, value] of Object.entries(options.durableGlobals ?? {})) {
    if (value !== undefined && typeof value !== 'function') // `undefined` means unmounted, see `unknown-global`
      throw new TypeError(`durable-isolates: durableGlobals["${name}"] is not a function`)
  }
  const walk = (shape: DurableModule, path: string): void => {
    for (const [name, value] of Object.entries(shape)) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value))
        walk(value, `${path}.${name}`)
      else if (value !== undefined && typeof value !== 'function') // `undefined`: unmounted, as above
        throw new TypeError(`durable-isolates: durableImports "${path}.${name}" is not a function`)
    }
  }
  for (const [specifier, module] of Object.entries(options.durableImports ?? {}))
    walk(module, specifier)
}

/**
 * Generate the sandbox modules for `durableImports` and the durable registry
 * entries behind them. Each function leaf at `specifier.path` becomes an
 * export calling `durableCall(nextKey(name), name, ...args)` with the dotted
 * name, and a registry entry under that name; nested objects become nested
 * exports. Assumes {@link assertPrepareOptions} passed.
 * @param durableImports the caller's durable modules
 */
export function toDurableImports(durableImports: Readonly<Record<string, DurableModule>> | undefined): { shims: Record<string, string>, registry: Record<string, DurableGlobal> } {
  // Null-prototype maps: a specifier or name of `__proto__` must stay data.
  const shims: Record<string, string> = Object.create(null) as Record<string, string>
  const registry: Record<string, DurableGlobal> = Object.create(null) as Record<string, DurableGlobal>
  for (const [specifier, module] of Object.entries(durableImports ?? {})) {
    // Nested objects use COMPUTED keys so any name (`__proto__` included) is an
    // own property of the literal, never a prototype assignment.
    const render = (shape: DurableModule, path: string): string => {
      const entries = Object.entries(shape).map(([name, value]) => {
        const at = `${path}.${name}`
        if (typeof value === 'function') {
          registry[at] = value
          return `[${JSON.stringify(name)}]: __di_op(${JSON.stringify(at)})`
        }
        return `[${JSON.stringify(name)}]: ${render(value as DurableModule, at)}`
      })
      return `{ ${entries.join(', ')} }`
    }
    const exports = Object.entries(module).map(([name, value]) => {
      const at = `${specifier}.${name}`
      if (typeof value === 'function') {
        registry[at] = value
        return `export const ${name} = __di_op(${JSON.stringify(at)});`
      }
      return `export const ${name} = ${render(value as DurableModule, at)};`
    })
    // The helpers carry names no export may use (`__di…`, refused at prepare),
    // so a leaf named `op`, `durableCall` or `nextKey` is fine.
    shims[specifier] = [
      `import * as __di from '${INTERNAL_SPECIFIER}';`,
      'const __di_op = (name) => (...args) => __di.durableCall(__di.nextKey(name), name, ...args);',
      ...exports,
    ].join('\n')
  }
  return { shims, registry }
}

/**
 * Flatten per-run `durableImports` overrides into durable-registry overrides
 * under the dotted operation names.
 * @param overrides this run's durable module overrides
 */
export function flattenDurableImports(overrides: Readonly<Record<string, DurableModule>> | undefined): Record<string, DurableGlobal> {
  const flat: Record<string, DurableGlobal> = Object.create(null) as Record<string, DurableGlobal>
  const walk = (shape: DurableModule, path: string): void => {
    for (const [name, value] of Object.entries(shape)) {
      if (value !== null && typeof value === 'object')
        walk(value, `${path}.${name}`)
      else
        flat[`${path}.${name}`] = value as DurableGlobal // a function, or `undefined` for "unmounted this run"
    }
  }
  for (const [specifier, module] of Object.entries(overrides ?? {}))
    walk(module, specifier)
  return flat
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
