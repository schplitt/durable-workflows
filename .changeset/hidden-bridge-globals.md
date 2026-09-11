---
"durable-isolates": patch
---

fix: declare the `__di_call`/`__di_lookup`/`__di_commit` bridge globals non-enumerable — enumeration-driven sandbox code (`Object.keys(globalThis)`, spreads) no longer sweeps them up. Hygiene only: the kernel shim still reaches them by name, and per-run rebinding is unchanged.
