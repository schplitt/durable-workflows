---
"durable-isolates": minor
---

feat(durable-isolates): detect replay divergence. A durable call at a recorded key must ask the same `name` with the same `args` (stable JSON), or the run is rejected with `reason: 'divergence'` and the history is left untouched.
