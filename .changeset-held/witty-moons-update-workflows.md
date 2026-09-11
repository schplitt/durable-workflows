---
"durable-workflows": patch
---

chore: update to `@iso4/sandbox` 0.5 — `maxIsolates` is gone (`maxConcurrentRuns`/`memoryBudgetMb` govern concurrency and residency now), the engine no longer sets its own sandbox concurrency default, and docs/comments are aligned with the new iso4 surface
