---
"durable-isolates": minor
---

feat(durable-isolates)!: export `RESERVED_GLOBALS` (iso4's `SANDBOX_GLOBALS` plus the kernel bridges); `prepare` and `run` now throw on a plain global under one of those names instead of letting it overwrite a built-in.
