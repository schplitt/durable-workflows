---
"durable-isolates": minor
---

feat(durable-isolates)!: a run iso4 refuses before it starts (a wrong per-run override, `execute` on a disposed runner) now rejects `result` and `suspend()` with iso4's setup error (`ERR_UNDECLARED_BINDING`, `ERR_PREFIX_DISPOSED`, …) instead of resolving as `outcome: 'failed'`. The rejection is never unhandled, so awaiting the handle later is safe.
