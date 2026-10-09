---
"durable-isolates": minor
---

feat(durable-isolates)!: `prepare` takes iso4's `imports` and `globals` as they are (plain, untouched by the kernel) plus `durableGlobals`, the registry reached through `durableCall`, mirrored by per-run overrides on `execute`. Breaking: `modules: { x: { shim } }` becomes `imports: { x: shim }`, per-run `execute({ globals })` for durable functions becomes `execute({ durableGlobals })` (`globals` now rebinds plain iso4 globals), and `PerExecuteGlobals`/`HostGlobal`/`GlobalMap`/`ModuleDefinition` become `DurableGlobals`/`DurableGlobal` (the others are gone).
