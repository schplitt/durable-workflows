---
"durable-workflows": patch
---

chore: update to `@iso4/sandbox` 0.6 — the sandbox now derives its own concurrency from the workload rather than defaulting `maxConcurrentRuns` to the core count, so `DurableWorkflowsOptions.sandbox` no longer advises raising it above that count: leave it unset and pin it only on a measured workload. Engine behaviour is unchanged (it still sets no sandbox concurrency of its own), and the engine's own per-run limit defaults are untouched — note that iso4's `cpuTimeMs` now measures real CPU instead of elapsed time, so the engine's `cpuTimeMs: 30_000` budget goes further on a busy host.
