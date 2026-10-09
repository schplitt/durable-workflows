---
"durable-isolates": minor
---

feat(durable-isolates): `di.run(options)` runs one replay turn on iso4's one-off `sandbox.run` (a fresh isolate, no prefix), taking what `prepare` and `execute` take together. It is the call for untrusted or independent programs that must not share an isolate.
