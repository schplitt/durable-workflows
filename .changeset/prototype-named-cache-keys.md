---
"durable-isolates": patch
---

Treat every boundary key as a plain cache entry. A key named `__proto__` used to hit the prototype setter of the cache object: the record was never persisted (so the boundary re-ran its side effect on every replay), and a `durableCommit('__proto__', …)` from the sandbox could make other keys answer by inheritance. Keys such as `constructor` or `toString` read inherited functions. The kernel now keeps its working copy on a null-prototype object and hands back an ordinary object, so these keys behave like any other. The returned `cache` is unchanged in shape.
