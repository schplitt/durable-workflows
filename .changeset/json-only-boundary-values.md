---
"durable-isolates": minor
---

Enforce JSON-only values at every durable boundary. A durable call's args, what a global returns or throws, and what `durableCommit`/`boundary()` stores are now admitted through the new `toJson(value)` (exported, with `NonJsonValueError`): the value is JSON-normalized so the first run sees exactly what a replay reads back (`undefined` is dropped in objects and becomes `null` in arrays; a bare `undefined` stays an absent value; `-0` becomes `0`), and a value JSON cannot carry (`Date`, `Map`, `Set`, bytes, `bigint`, `NaN`, class instances, sparse arrays, cycles, …) ends the run with the new terminal `outcome: 'rejected'`. The isolate is aborted like a suspension (uncatchable in-sandbox), nothing is recorded at the violating key, in-flight dispatches are drained, and `rejection` says what happened (`reason: 'non-json'`, `source: 'args' | 'result' | 'error' | 'commit'`, `key`, `path` like `$.items[2].at`, `found` like `Date`, and an author-facing `message`).

Breaking: thrown `Error`s are recorded as `name` + `message` only (own fields are dropped); `durableCommit` now resolves with the value as recorded instead of `void`; a `Uint8Array` response body from `@iso4/fetch` is rejected (convert it to text in the middleware).
