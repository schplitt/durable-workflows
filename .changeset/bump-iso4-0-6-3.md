---
"durable-isolates": patch
---

Update `@iso4/sandbox` to 0.6.3. iso4 no longer caps host → sandbox values at 32 nesting levels, so a deep cached value is delivered on replay exactly as the first run saw it; a value too deep for the runtime to read now fails the run with `ERR_TYPE_NOT_SERIALIZABLE`.
