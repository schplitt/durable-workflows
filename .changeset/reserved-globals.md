---
"durable-isolates": minor
---

feat(durable-isolates)!: export `RESERVED_GLOBALS` (iso4's `SANDBOX_GLOBALS` plus the kernel bridges) and `isValidGlobalName`; `prepare` and `run` throw on a plain global that fails it instead of letting it overwrite a built-in. `durableImports` export names follow iso4's `isValidExportName`, so Unicode names like `café` work.
