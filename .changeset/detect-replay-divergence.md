---
"durable-isolates": minor
---

Detect replay divergence. A `durableCall` at a key that is already recorded (any status) is now checked before it is answered, re-thrown or re-dispatched: the record's `name` must match and its `args` must equal the asked args as stable JSON (object key order ignored, array order significant). A mismatch ends the run with `outcome: 'rejected'` and `rejection.reason === 'divergence'`, carrying `mismatch` (`'name' | 'args' | 'no-call'`), `recorded`, `attempted`, `key` and an author-facing `message` that says to keep durable calls in the same order and to wrap nondeterministic inputs in `boundary()`. `no-call` means the key holds a checkpoint (`boundary()`/`durableCommit`) or a record without `name`/`args` from an older kernel. Keys are not policed: a call at an unrecorded key still just runs. The history is left untouched on a divergence.
