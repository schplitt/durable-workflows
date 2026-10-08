---
"durable-isolates": minor
---

feat(durable-isolates): carry every boundary value as JSON, so the first run sees exactly what a replay reads back, and reject the run (`outcome: 'rejected'`, `reason: 'non-json'`) on what JSON cannot write. Breaking: thrown `Error`s are recorded as `name` + `message` only, and `durableCommit` resolves with the recorded value instead of `void`.
