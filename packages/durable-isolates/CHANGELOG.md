# durable-isolates

## 0.3.0

### Minor Changes

- 99e5c63: feat(durable-isolates): detect replay divergence. Every durable operation records its issue position (`order`), and on replay an operation at another position, or a durable call at a recorded key with another `name` or `args` (stable JSON), rejects the run with `reason: 'divergence'` and leaves the history untouched; caches written by earlier versions cannot be resumed.
- 8acf5fc: feat(durable-isolates): `durableImports` — hand `prepare` a module of host functions (nested allowed) and the kernel generates the sandbox module whose exports are durable calls named `specifier.path`, with per-run overrides on `execute({ durableImports })`. Data leaves, non-identifier export names, a specifier also in `imports` and a name also in `durableGlobals` are refused at `prepare` with the offending path.
- 1dd8a1f: feat(durable-isolates): reject key reuse, record overwrites and unknown globals. A key names one operation per run and is written once (`reason: 'duplicate-key'`), a step at a call's record or the reverse is a divergence (`mismatch: 'kind'`, replacing `'no-call'`), and a call whose global is not mounted rejects the run (`reason: 'unknown-global'`) instead of recording a failure.
- badcc44: feat(durable-isolates): carry every boundary value as JSON, so the first run sees exactly what a replay reads back, and reject the run (`outcome: 'rejected'`, `reason: 'non-json'`) on what JSON cannot write. Breaking: thrown `Error`s are recorded as `name` + `message` only, and `durableCommit` resolves with the recorded value instead of `void`.
- c5e86f3: feat(durable-isolates): `di.run(options)` runs one replay turn on iso4's one-off `sandbox.run` (a fresh isolate, no prefix), taking what `prepare` and `execute` take together. It is the call for untrusted or independent programs that must not share an isolate.
- 4d78d5f: feat(durable-isolates)!: `prepare` takes iso4's `imports` and `globals` as they are (plain, untouched by the kernel) plus `durableGlobals`, the registry reached through `durableCall`, mirrored by per-run overrides on `execute`. Breaking: `modules: { x: { shim } }` becomes `imports: { x: shim }`, per-run `execute({ globals })` for durable functions becomes `execute({ durableGlobals })` (`globals` now rebinds plain iso4 globals), and `PerExecuteGlobals`/`HostGlobal`/`GlobalMap`/`ModuleDefinition` become `DurableGlobals`/`DurableGlobal` (the others are gone).
- 55f7ea0: feat(durable-isolates): record call name and args on boundary records. Dispatch records (`completed`, `failed`, `waiting`) now carry `name` and `args`; commit records from `durableCommit`/`boundary()` carry neither.

### Patch Changes

- f39c05b: Update `@iso4/sandbox` to 0.6.1.
- 41c2310: chore(durable-isolates): bump `@iso4/sandbox` to 0.6.2, which stops dispatching bridge calls queued before an abort. `BridgeCallEntry` loses `blocked` and gains `reason`.
- 5506fc3: chore(durable-isolates): bump `@iso4/sandbox` to 0.6.3, which lifts the 32-level nesting cap on host → sandbox values. Deep cached values are now delivered on replay exactly as the first run saw them.
- 18b058a: fix(durable-isolates): keep prototype-named keys (`__proto__`, `constructor`, …) as plain cache entries. A `__proto__` boundary used to be dropped from the cache and a commit at it could answer other keys by inheritance.

## 0.2.0

### Minor Changes

- b3156f4: feat: every `execute` result now carries `run`, iso4's own result for the turn passed through unchanged. It includes `durationMs`, `wallTimeMs`, `cpuTimeMs`, `queueWaitMs`, `heapUsedBytes`, `bridgeCalls` and `stdout`/`stderr`. Its type follows `outcome`: `RunSuccess` when completed, `RunFailure` when failed, and iso4's aborted arm when suspended. `KERNEL_BRIDGE_GLOBALS` is exported so callers can tell the kernel's own `bridgeCalls` entries (`__di_call`, `__di_lookup`, `__di_commit`) apart from other globals.

## 0.1.4

### Patch Changes

- ee83d12: fix: add `getSandbox()` to reach the underlying iso4 sandbox (e.g. `stats()` for load metrics). It returns the same sandbox `prepare` uses and creates it if needed, so metrics can be scraped before the first run; `dispose()` still tears it down. Runners now expose `prefixId`, the key into `stats().prefixes`.
  
  `FailedResult.error` is now typed as iso4's `RunError` instead of `unknown`, so `error.code` narrows to the `RunErrorCode` union without a cast.

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
