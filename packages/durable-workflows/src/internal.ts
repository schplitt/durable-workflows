/**
 * `durable-workflows:internal` — the shim-facing contract.
 *
 * What mounted module shims import: the core `durable-workflows:workflow` shim
 * AND plugin shims (`my:sleep`, `my:approvals`, …). It is a thin, semver'd
 * wrapper over the kernel's `durable-isolates:internal` that surfaces only the
 * two durable primitives a shim needs, hiding the raw `durableCall`/`nextKey`
 * key machinery.
 *
 * FORBIDDEN to workflow code. Shims are compiled into the prefix (prefix code);
 * workflows are the executed bundle (postfix code) — statically separable, so a
 * later registration-time import scan rejects any workflow bundle that imports
 * this specifier. Documented as a contract now; enforced later.
 *
 * Self-contained by design (imports nothing) so it can ship as raw text for an
 * editor / codemod `.d.ts` or be imported by shim authors from
 * `durable-workflows/internal`.
 */

/**
 * A durable OPERATION call — the primitive every waiting/host-backed capability
 * is built on. Forms an auto step id (the boundary key) from `name` via the
 * kernel's ambient `nextKey` (`name#0`, `name#1`, … per scope) and routes to the
 * host handler registered under `name`. Over the wire it forwards the step id
 * first, then `args` (the kernel never passes a handler its boundary key, so the
 * engine recovers `stepId` from this leading id and treats the rest as
 * `payload`). Resolves with the
 * boundary's value, rejects with a recorded/handler error, and never settles
 * when the handler suspends (the run is aborted). Answered from the cache on
 * replay — the handler runs at most once per boundary until re-dispatch.
 */
export type Operation = (name: string, ...args: unknown[]) => Promise<unknown>

/**
 * The nestable BOUNDARY — the primitive `step.do` maps onto. On a cache hit the
 * value is returned WITHOUT running `fn`; on a miss `fn` runs in-sandbox, its
 * result is committed, and `id` is prepended as the ambient prefix while `fn`
 * runs so inner boundary/operation keys concatenate under it (`id/inner#0`).
 * `id` is used verbatim as the boundary key: two boundaries with the same `id`
 * at the same level collide onto one record — the documented determinism
 * contract, not an enforced guard. Bodies must run sequentially (the ambient
 * prefix is not async-context-safe until iso4#23 lands).
 */
export type Boundary = <T>(id: string, fn: () => T | Promise<T>) => Promise<T>

/**
 * The `durable-workflows:internal` module surface, for typing shim source.
 */
export interface DurableWorkflowsInternal {
  operation: Operation
  boundary: Boundary
}
