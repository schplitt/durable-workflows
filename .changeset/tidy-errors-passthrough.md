---
"durable-isolates": patch
---

Faithful durable-call error propagation on iso4 >=0.2.2. A failed durable call now REJECTS the bridge with the recorded error instead of returning an `{ ok: false }` envelope: iso4 (>=0.2.2, which closed schplitt/iso4#22) delivers a rejecting bridge into the sandbox `catch` as a real `Error` with its `name`/`message`/own fields intact, and surfaces a structured `RunError` (`name`/`message`/`fields`) on the host for uncaught failures. This removes the hand-rolled `serializeError`/`__di_reconstruct` workaround and the exported `SerializedError` type — `FailedResult.error` and `FailedBoundary.error` are now `unknown` (the thrown value recorded as plain, persistable data, with the host `stack` stripped). Bumps the `@iso4/sandbox` floor to `^0.2.2`.
