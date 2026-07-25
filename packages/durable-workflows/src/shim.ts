/**
 * The in-sandbox side of the authoring surface: the ESM source of the two
 * virtual modules the engine compiles into every iso4 prefix.
 *
 * - `durable-workflows:internal` — the SHIM-facing module (plugin + core shim
 *   authors), a thin wrapper over the kernel's `durable-isolates:internal`. It
 *   surfaces exactly the two durable primitives a shim needs — an auto-keyed
 *   durable OPERATION call and the nestable BOUNDARY — and nothing of the
 *   kernel's raw key machinery. Forbidden to workflow code: a later
 *   registration-time import scan rejects workflow bundles that import it (shims
 *   are prefix, workflows are postfix — statically separable).
 * - `durable-workflows:workflow` — the AUTHOR-facing module (`defineWorkflow`
 *   and `step.do`), built ONLY on `durable-workflows:internal` so authors and
 *   plugins never touch the kernel directly. Whitelabelable: the engine can
 *   remount it under a custom specifier via `alias`.
 *
 * These are preloaded shims, not real npm modules — the specifiers resolve to
 * this source inside the sandbox and to the shipped ambient `.d.ts` for authors'
 * editors (the `cloudflare:workers` pattern).
 */
import type { ModuleDefinition } from 'durable-isolates'

/**
 * Virtual specifier of the shim-facing module. Plugin and core shims `import`
 * from this; workflow code may not.
 */
export const INTERNAL_SPECIFIER = 'durable-workflows:internal'

/**
 * Virtual specifier of the author-facing module. Workflow code imports
 * `defineWorkflow` and `step` from this (or a whitelabeled `alias`).
 */
export const WORKFLOW_SPECIFIER = 'durable-workflows:workflow'

/**
 * Source of the `durable-workflows:internal` module — the shim-facing surface.
 *
 * `operation(name, ...args)` — a durable OPERATION call: forms an auto step id
 * with the kernel's `nextKey` (`name#0`, `name#1`, … within the current scope)
 * and routes to the host handler `name`. It forwards the step id FIRST, then the
 * caller's `args` — the kernel hands a handler only what the shim forwards and
 * never the boundary key, so carrying it in the args is how the engine recovers
 * `stepId` when it builds the handler's `{ instanceId, workflow, run, stepId,
 * payload }` input (it strips this leading id and passes the rest as `payload`).
 * This is what plugin shims build their capability on (e.g. `export const sleep =
 * ms => operation('sleep', ms)`).
 *
 * `boundary(id, fn)` — the nestable BOUNDARY: `fn` runs in-sandbox, its return
 * value is committed, and `id` is prepended as the ambient prefix so inner
 * boundary/operation keys concatenate under it. A hit skips `fn` wholesale. This
 * is what `step.do` maps onto — the step id IS the boundary key (used verbatim,
 * so duplicate ids at one level collide: the documented determinism contract).
 */
export const internalShim: string = /* js */ `
import { durableCall, boundary as kernelBoundary, nextKey } from 'durable-isolates:internal'

export function operation(name, ...args) {
  const key = nextKey(String(name))
  return durableCall(key, String(name), key, ...args)
}

export function boundary(id, fn) {
  return kernelBoundary(String(id), fn)
}
`

/**
 * Source of the `durable-workflows:workflow` module — the author-facing surface,
 * built on `durable-workflows:internal`.
 *
 * `step.do(id, fn)` — the ONE step primitive, a direct pass-through to the
 * internal boundary: `fn` runs once, its return is persisted, and the step is a
 * scope (nesting is just calling `step.do` inside a `step.do` body, sequential
 * or parallel).
 *
 * `defineWorkflow({ run })` — returns a CALLABLE `(input) => run({ input })`. The
 * per-instance input is NOT fetched over the bridge: the engine imports the
 * workflow's default export into a generated main-world entry and calls it with
 * the payload as a plain argument (`import workflow from '…'; export default
 * await workflow(payload)`). So the author writes `export default
 * defineWorkflow({ … })` with no `await`; the entry's `await workflow(payload)`
 * is what drives the run to completion or suspension. The return value is the
 * module default; the engine discards it.
 */
export const workflowShim: string = /* js */ `
import { boundary } from '${INTERNAL_SPECIFIER}'

export const step = {
  do(id, fn) {
    return boundary(id, fn)
  },
}

export function defineWorkflow(definition) {
  return (input) => definition.run({ input })
}
`

/**
 * The core author-facing modules, keyed by their canonical specifier — the
 * single source of truth for what the engine mounts into every prefix. The
 * engine spreads this together with the user's plugins (and any `alias`
 * remounts) when it calls the kernel's `hydrate`; workflow authors never mount
 * them, and the kernel does not inject them (it only injects its OWN
 * `durable-isolates:internal`). Exposing the bundle keeps the engine and tests
 * from drifting from these definitions.
 */
export const coreModules: Readonly<Record<string, ModuleDefinition>> = {
  [INTERNAL_SPECIFIER]: { shim: internalShim },
  [WORKFLOW_SPECIFIER]: { shim: workflowShim },
}
