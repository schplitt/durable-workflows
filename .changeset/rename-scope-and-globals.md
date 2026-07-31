---
"durable-isolates": patch
---

Align vocabulary with iso4: rename the prepare/execute/globals/scope surface.

- **`hydrate` → `prepare`**: `DurableIsolates.hydrate` → `.prepare`, `HydrateOptions` → `PrepareOptions`. Mirrors iso4's `sandbox.prepare()` (0.4.1), the operation this wraps. `execute` is unchanged and now matches iso4's `prefix.execute()`; the kernel calls iso4's canonical `prepare()`/`execute()` instead of the deprecated `precompile()`/`run()`.
- **host callables → `globals`** (iso4's term for host-provided callables), replacing "handlers": `ModuleDefinition.handlers` → `.globals`, `ExecuteOptions.handlers` → `.globals`, with the types `HostHandler` → `HostGlobal`, `HandlerMap` → `GlobalMap`, `PerExecuteHandlers` → `PerExecuteGlobals`.
- **ambient boundary-key `prefix` → `scope`** (in-sandbox, ALS-backed), freeing "prefix" for iso4's own `Prefix` (the precompiled snapshot) — the two are unrelated concepts that previously collided across the two stacked packages.

Requires `@iso4/sandbox` >= 0.4.1 (for `prepare()`/`execute()`).

Breaking: update `hydrate(...)` → `prepare(...)`, `handlers:` → `globals:`, and any references to the renamed types.
