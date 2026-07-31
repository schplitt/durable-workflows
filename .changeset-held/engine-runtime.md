---
"durable-workflows": minor
---

Engine runtime: `durableWorkflows(options)`. The connector that ties the authoring surface and execution host to a persistence store, exposing the full instance lifecycle — `create`, `get`, `continueWorkflow`, `terminate`, `evict`, `restart`, `dispose`, and `pendingPromises`.

Each lifecycle call resolves to one replay turn: load the instance record + boundary cache from the `WorkflowStore`, resolve the pinned definition version via the store's `getDefinition`, hydrate (and cache, per pinned version) a runner mounted with the plugin shims + any `alias` re-export modules, execute with per-run globals, then persist the grown cache and new status and return a `RunOutcome`. Storage is minimal (instances + one opaque cache blob each); retry, scheduling and wake-ups stay the caller's job; resume is plain re-execution.

The store is ONE persistent world: instances, caches, and READ-ONLY definition access (`getDefinition(name, version?)` — no version means "active/latest", the pinned version on replay). Writing definitions (upload, versioning, rollback) is deliberately the application's own deploy layer against the same backend; the contract is that a handed-out `(name, version)` stays fetchable and byte-identical while instances pin it.

Plugin globals receive the structured `DurableGlobalInput` (`{ instanceId, workflow, run, stepId, payload }`) — the `durable-workflows:internal` `operation` shim now forwards the boundary key alongside the args so the engine can recover `stepId` (the kernel never hands a global its key), and `payload` is the full forwarded argument list. The host now forwards iso4 resource limits (engine defaults ← `options.limits` ← per-definition `limits`).

Ships an in-memory `memoryStore()` reference adapter (with a `deploy` seeding helper playing the deploy layer's role for tests).
