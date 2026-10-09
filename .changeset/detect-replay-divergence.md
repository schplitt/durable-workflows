---
"durable-isolates": minor
---

feat(durable-isolates): detect replay divergence. Every durable operation records its issue position (`order`), and on replay an operation at another position, or a durable call at a recorded key with another `name` or `args` (stable JSON), rejects the run with `reason: 'divergence'` and leaves the history untouched; caches written by earlier versions cannot be resumed.
