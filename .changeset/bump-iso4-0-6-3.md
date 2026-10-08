---
"durable-isolates": patch
---

chore(durable-isolates): bump `@iso4/sandbox` to 0.6.3, which lifts the 32-level nesting cap on host → sandbox values. Deep cached values are now delivered on replay exactly as the first run saw them.
