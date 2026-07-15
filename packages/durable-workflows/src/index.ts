/**
 * durable-workflows — a composable durable workflow engine built on the
 * `durable-isolates` replay kernel. See `./types` for the engine/host public
 * type surface.
 *
 * `durableWorkflowHost` is the execution surface: `hydrate({ workflow, plugins })`
 * mounts a workflow definition with the core modules auto-injected, and the
 * returned runner's `execute({ input })` runs it. Author-facing types live at
 * `durable-workflows/workflow` (the ambient `durable-workflows:workflow` module);
 * the shim-facing contract for plugin authors at `durable-workflows/internal`.
 */
export type * from './types'
export type {
  DurableWorkflowHost,
  WorkflowExecuteOptions,
  WorkflowHydrateOptions,
  WorkflowRunner,
} from './host'
export { durableWorkflowHost } from './host'
// The canonical specifiers are exported: plugin shims import from them, and
// `alias` remounts reference them. The core shim SOURCES are not public — the
// host mounts them for you.
export { INTERNAL_SPECIFIER, WORKFLOW_SPECIFIER } from './shim'
