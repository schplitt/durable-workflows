---
"durable-isolates": minor
---

feat(durable-isolates): record call name and args on boundary records. Dispatch records (`completed`, `failed`, `waiting`) now carry `name` and `args`; commit records from `durableCommit`/`boundary()` carry neither.
