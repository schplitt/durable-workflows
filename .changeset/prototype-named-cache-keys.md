---
"durable-isolates": patch
---

fix(durable-isolates): keep prototype-named keys (`__proto__`, `constructor`, …) as plain cache entries. A `__proto__` boundary used to be dropped from the cache and a commit at it could answer other keys by inheritance.
