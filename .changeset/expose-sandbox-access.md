---
"durable-isolates": patch
---

fix: add `getSandbox()` to reach the underlying iso4 sandbox (e.g. `stats()` for load metrics). It returns the same sandbox `prepare` uses and creates it if needed, so metrics can be scraped before the first run; `dispose()` still tears it down. Runners now expose `prefixId`, the key into `stats().prefixes`.
