/**
 * `durable-workflows:workflow` — author-facing ambient types.
 *
 * Workflow code imports `defineWorkflow` and `step` from the virtual specifier
 * `durable-workflows:workflow` (or a whitelabeled `alias`). At sandbox runtime
 * the specifier resolves to the preloaded shim compiled into the prefix; at
 * type-check time it resolves to the ambient module declared below — the
 * `cloudflare:workers` pattern. Ship this `.d.ts` to authors and load it via
 * tsconfig `types`/`compilerOptions.types` or a `/// <reference types="..." />`;
 * a whitelabeled mount ships its own thin re-export d.ts pointing here.
 *
 * This is a declaration file with no top-level import/export, so it is an
 * AMBIENT module declaration (not an augmentation) even under
 * `moduleDetection: "force"`. It is self-contained: everything is declared
 * inside the module block.
 */

declare module 'durable-workflows:workflow' {
  /**
   * The one argument `run` receives: the per-instance `input`, exactly what the
   * trigger passed to `create`. Nothing else arrives as an argument —
   * capabilities come through imports, not parameters.
   */
  export interface WorkflowRunContext<TInput = unknown> {
    input: TInput
  }

  /**
   * A workflow definition: a single `run`. The ENTIRE `run` executes inside the
   * sandbox and re-runs top-to-bottom on every replay — cached steps return
   * their stored value instantly, only the first unfinished step actually
   * executes. `run`'s return value is DISCARDED by the engine (workflows act
   * through their steps); it exists only so a definition can be typed.
   */
  export interface WorkflowDefinition<TInput = unknown, TResult = unknown> {
    run: (ctx: WorkflowRunContext<TInput>) => TResult | Promise<TResult>
  }

  /**
   * The step surface. ONE primitive: `do(id, fn)` — a named, memoized unit of
   * work. `fn` runs at most once to successful completion and is skipped forever
   * after, so raw side effects are safe inside a leaf `do`. `id` is the durable
   * boundary key: unique among sibling steps and stable across replays.
   *
   * `do` is also the scope: calling `step.do` inside a `step.do` body nests, and
   * the inner ids concatenate under the outer one. There is no separate scope or
   * substep API. Nested bodies run correctly whether sequential OR parallel
   * (`Promise.all`) — the ambient key scope is carried through async context.
   * A body that mixes raw side effects with nested durable calls re-runs until
   * those calls complete: the documented determinism contract, not a guard.
   */
  export interface Step {
    do: <T>(id: string, fn: () => T | Promise<T>) => Promise<T>
  }

  /**
   * Define a durable workflow. Returns a CALLABLE that runs it: the engine
   * imports the workflow's default export into a generated main-world entry and
   * invokes it with the per-instance payload as a plain argument
   * (`import workflow from '…'; export default await workflow(payload)`). So the
   * author writes `export default defineWorkflow({ … })` with no `await` — it is
   * a function, and the entry's `await workflow(payload)` drives the run.
   */
  export const defineWorkflow: <TInput = unknown, TResult = unknown>(
    definition: WorkflowDefinition<TInput, TResult>,
  ) => (input: TInput) => Promise<TResult>

  /**
   * The step surface. See {@link Step}.
   */
  export const step: Step
}
