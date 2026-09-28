---
"durable-isolates": minor
---

feat: every `execute` result now carries `run`, iso4's own result for the turn passed through unchanged. It includes `durationMs`, `wallTimeMs`, `cpuTimeMs`, `queueWaitMs`, `heapUsedBytes`, `bridgeCalls` and `stdout`/`stderr`. Its type follows `outcome`: `RunSuccess` when completed, `RunFailure` when failed, and iso4's aborted arm when suspended. `KERNEL_BRIDGE_GLOBALS` is exported so callers can tell the kernel's own `bridgeCalls` entries (`__di_call`, `__di_lookup`, `__di_commit`) apart from other globals.
