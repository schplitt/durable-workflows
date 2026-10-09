---
"durable-isolates": minor
---

Boundary records written by a global dispatch now store the call itself: the `name` that was dispatched and the `args` the shim forwarded. `completed` and `failed` records (including a "no global for `name`" failure) gain optional `name`/`args`; `waiting` records gain `args` next to their existing `name`. Records written by `durableCommit`/`boundary()` are unchanged and carry neither.
