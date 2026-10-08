---
"durable-isolates": patch
---

chore(durable-isolates): bump `@iso4/sandbox` to 0.6.2, which stops dispatching bridge calls queued before an abort. `BridgeCallEntry` loses `blocked` and gains `reason`.
