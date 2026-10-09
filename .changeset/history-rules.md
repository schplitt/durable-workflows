---
"durable-isolates": minor
---

feat(durable-isolates): reject key reuse, record overwrites and unknown globals. A key names one operation per run and is written once (`reason: 'duplicate-key'`), a step at a call's record or the reverse is a divergence (`mismatch: 'kind'`, replacing `'no-call'`), and a call whose global is not mounted rejects the run (`reason: 'unknown-global'`) instead of recording a failure.
