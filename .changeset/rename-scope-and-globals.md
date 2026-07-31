---
"durable-isolates": minor
---

Align vocabulary with iso4: rename the host-callable surface to **globals** and the ambient key-**prefix** to **scope**.

- Host callables the caller mounts are now **globals** (matching iso4's own term for host-provided callables), replacing "handlers": `ModuleDefinition.handlers` → `.globals` and `ExecuteOptions.handlers` → `.globals`, with the types `HostHandler` → `HostGlobal`, `HandlerMap` → `GlobalMap`, and `PerExecuteHandlers` → `PerExecuteGlobals`.
- The in-sandbox ambient boundary-key **prefix** carried through iso4's `AsyncLocalStorage` is renamed to **scope**. This frees the word "prefix" for iso4's own `Prefix` (the precompiled snapshot); the two are unrelated concepts that previously collided across the two stacked packages.

Breaking: update call sites from `handlers:` to `globals:` and any references to the renamed types.
