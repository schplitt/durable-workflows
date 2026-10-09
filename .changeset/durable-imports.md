---
"durable-isolates": minor
---

feat(durable-isolates): `durableImports` — hand `prepare` a module of host functions (nested allowed) and the kernel generates the sandbox module whose exports are durable calls named `specifier.path`, with per-run overrides on `execute({ durableImports })`. Data leaves, non-identifier export names, a specifier also in `imports` and a name also in `durableGlobals` are refused at `prepare` with the offending path.
