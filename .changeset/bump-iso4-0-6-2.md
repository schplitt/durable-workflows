---
"durable-isolates": patch
---

Update `@iso4/sandbox` to 0.6.2. iso4 no longer dispatches bridge calls the sandbox had queued before a run was aborted, so once the kernel suspends or rejects a run, no further host globals are invoked for it. `BridgeCallEntry` in `run.bridgeCalls` loses `blocked` and gains `reason` (`'blocked' | 'error' | 'unanswered' | 'dropped'`) when `ok` is false.
