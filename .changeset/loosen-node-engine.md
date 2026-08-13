---
"durable-isolates": patch
---

Relax the declared `engines.node` floor from `>=26.0.0` to `>=24.0.0`. The package's own code only relies on `node:async_hooks`'s `AsyncLocalStorage` (available since Node 12), and its sole dependency `@iso4/sandbox` (plus all four of its platform-specific native binary packages) already declares `>=24.0.0`, so nothing in the dependency chain required Node 26.
