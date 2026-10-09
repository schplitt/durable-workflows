---
"durable-workflows": patch
---

Map the kernel's new terminal `rejected` outcome (a non-JSON value at a durable boundary) to a failed instance: `error.name` is `NonJsonValueError`, `error.message` the kernel's author-facing message, and `error.data` the structured rejection (`source`, `key`, `path`, `found`).
