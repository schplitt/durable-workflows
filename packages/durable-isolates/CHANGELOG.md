# durable-isolates

## 0.1.3

### Patch Changes

- e5ae914: fix: declare the `__di_call`/`__di_lookup`/`__di_commit` bridge globals non-enumerable — enumeration-driven sandbox code (`Object.keys(globalThis)`, spreads) no longer sweeps them up. Hygiene only: the kernel shim still reaches them by name, and per-run rebinding is unchanged.
- 61e65a3: chore: update to `@iso4/sandbox` 0.6 — left unset, `maxConcurrentRuns` is now derived by the runtime from the shape of the runs it serves instead of defaulting to the core count; `maxQueuedRuns` defaults to a flat `10_000`; `ERR_CAPACITY` is renamed `ERR_CAPACITY_MEMORY`; `cpuTimeMs` measures real CPU rather than elapsed time (so it no longer inflates under contention); and `hostReserveMb`, `SandboxStats.slotLimit` and `queueWaitMs` are new. Kernel behaviour is unchanged — it sets no sandbox concurrency of its own and does not branch on run error codes; type docs are aligned with the new surface.
- 1c21c3b: chore: update to `@iso4/sandbox` 0.5 — `maxIsolates` is gone (`maxConcurrentRuns`/`memoryBudgetMb` govern concurrency and residency now), and docs/comments are aligned with the new iso4 surface

## 0.1.2

### Patch Changes

- 684cc49: Relax the declared `engines.node` floor from `>=26.0.0` to `>=24.0.0`. The package's own code only relies on `node:async_hooks`'s `AsyncLocalStorage` (available since Node 12), and its sole dependency `@iso4/sandbox` (plus all four of its platform-specific native binary packages) already declares `>=24.0.0`, so nothing in the dependency chain required Node 26.

## 0.1.1

### Patch Changes

- 6c7e93b: chore: bump versions
- 00556af: Align vocabulary with iso4: rename the prepare/execute/globals/scope surface.

  - **`hydrate` → `prepare`**: `DurableIsolates.hydrate` → `.prepare`, `HydrateOptions` → `PrepareOptions`. Mirrors iso4's `sandbox.prepare()` (0.4.1), the operation this wraps. `execute` is unchanged and now matches iso4's `prefix.execute()`; the kernel calls iso4's canonical `prepare()`/`execute()` instead of the deprecated `precompile()`/`run()`.
  - **host callables → `globals`** (iso4's term for host-provided callables), replacing "handlers": `ModuleDefinition.handlers` → `.globals`, `ExecuteOptions.handlers` → `.globals`, with the types `HostHandler` → `HostGlobal`, `HandlerMap` → `GlobalMap`, `PerExecuteHandlers` → `PerExecuteGlobals`.
  - **ambient boundary-key `prefix` → `scope`** (in-sandbox, ALS-backed), freeing "prefix" for iso4's own `Prefix` (the precompiled snapshot) — the two are unrelated concepts that previously collided across the two stacked packages.

  Requires `@iso4/sandbox` >= 0.4.1 (for `prepare()`/`execute()`).

  Breaking: update `hydrate(...)` → `prepare(...)`, `handlers:` → `globals:`, and any references to the renamed types.

## 0.1.0

### Minor Changes

- de4f12d: feat: async-context boundary prefix (parallel-safe nesting), split bridge globals, reserved-specifier guard

### Patch Changes

- 43fbd92: feat: durable isolates
- 5827d5f: chore: bump `@iso4/sandbox` to `^0.4.0`
- 7ce225a: Faithful durable-call error propagation on iso4 >=0.2.2. A failed durable call now REJECTS the bridge with the recorded error instead of returning an `{ ok: false }` envelope: iso4 (>=0.2.2, which closed schplitt/iso4#22) delivers a rejecting bridge into the sandbox `catch` as a real `Error` with its `name`/`message`/own fields intact, and surfaces a structured `RunError` (`name`/`message`/`fields`) on the host for uncaught failures. This removes the hand-rolled `serializeError`/`__di_reconstruct` workaround and the exported `SerializedError` type — `FailedResult.error` and `FailedBoundary.error` are now `unknown` (the thrown value recorded as plain, persistable data, with the host `stack` stripped). Bumps the `@iso4/sandbox` floor to `^0.2.2`.
