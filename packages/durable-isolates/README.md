# durable-isolates

The replay kernel for [`durable-workflows`](../durable-workflows), built on top of [`iso4`](https://github.com/schplitt/iso4).

`durable-isolates` runs a program in an [`@iso4/sandbox`](https://www.npmjs.com/package/@iso4/sandbox) and makes selected operations **durable**: you re-run the _same_ source over a **keyed cache**, and a durable boundary is answered from the cache when its key was already recorded (never re-executed), a miss runs for real, and a host handler can **suspend** the whole run. Everything the caller must remember comes back as the grown cache — a suspended program is nothing but data you persist and hand back. Resume is always the same move: **run it again**.

The kernel is a **memoize-by-key router**: it owns no store, no scheduler, no id policy. In-sandbox shims form a **key** and call the primitives from `durable-isolates:internal`; the host answers by key or dispatches the named handler. The **caller** owns storage (persist `cache`, hand it back), retry/eviction (cache surgery), and reacting to suspended operations.

> Node `>=26`, ESM only.

## Install

```sh
pnpm add durable-isolates
```

`@iso4/sandbox` is a peer you provide (it pulls in the platform V8 binary). `@iso4/fetch` is optional — mount its handler to get a durable HTTP capability (see below).

## Model

You mount **modules**, each a pair:

- a **shim** — in-sandbox ESM the program imports. It forms a deterministic **key** in the sandbox (its own scheme, or `nextKey` from `durable-isolates:internal`) and calls `durableCall(key, name, …args)` for each durable operation.
- **handlers** — host functions keyed by the operation `name` the shim routes to.

The key is _always_ formed sandbox-side and carried over the wire; the host never mints it. The cache always lives host-side, reached through the bridge; every replay re-derives the same keys by re-executing the same code.

## Quick start

<!-- eslint-skip -->

```ts
import { durableIsolates, SuspendIsolate } from 'durable-isolates'

const di = durableIsolates({ sandbox: { maxIsolates: 10 } })

// A shim that auto-keys with an in-sandbox counter (the mc8yp style).
const SHIM = `
  import { durableCall } from 'durable-isolates:internal'
  const n = Object.create(null)
  const key = name => name + '#' + (n[name] = (n[name] || 0) + 1) - 1
  export const load    = id  => durableCall(key('load'), 'load', id)
  export const approve = sub => durableCall(key('approve'), 'approve', sub)
`

const runner = await di.hydrate({ modules: { reports: { shim: SHIM } } })

// The SAME source runs every turn; the program imports the shim.
const code = `
  import { load, approve } from 'reports'
  const report = await load('r-1')
  const ok = await approve(report.title)
  export default { title: report.title, ok }
`

// Per-run handlers (auth, approval answers etc. captured in their closure).
let cache = {}
while (true) {
  const r = await runner.execute({
    code,
    cache,
    handlers: {
      load: id => db.reports.get(id),
      approve: (subject) => {
        const decision = decisions.get(subject)
        if (decision === undefined)
          throw new SuspendIsolate({ subject }) // → suspend the run
        return decision // → enters the cache through this live re-dispatch
      },
    },
  }).result
  if (r.outcome === 'completed')
    return r.result
  if (r.outcome === 'failed')
    throw new Error(r.error.message)

  cache = r.cache
  for (const p of r.pending)
    await askForApproval(p.payload) // decision lands in `decisions`, then just re-run
}
```

## Forming the key in the shim

The key is the cache id — its policy lives entirely in your shim. Three idioms:

<!-- eslint-skip -->

```ts
// (1) auto — keep the count in the sandbox, build the key, then call the bridge
const n = Object.create(null)
export const request = opts =>
  durableCall(`request#${n.request = (n.request || 0) + 1, n.request - 1}`, 'request', opts)

// (2) explicit — the caller supplies the key directly (workflow-author style)
export const step = (key, name, ...args) => durableCall(key, name, ...args)

// (3) ambient — nextKey() prefixes the current boundary scope and counts per name
import { durableCall, nextKey } from 'durable-isolates:internal'
export const fetch = (url, init) => durableCall(nextKey('fetch'), 'fetch', url, init)
```

The key must be **deterministic** across replays of the same source (a counter that resets per run, or an input-derived string) — a `Date.now()` in there is the documented sin. Non-durable work needs no key: just call a plain iso4 global (`console.log`, etc.); it re-runs every replay and is never recorded.

## Suspension

A handler suspends by throwing **`SuspendIsolate`**. The kernel catches it host-side, writes a **waiting** record, and aborts the run — so nothing further executes and no value is delivered for that call. It is **unforgeable and uncatchable from inside the sandbox**: a `try/catch` around the suspending call cannot swallow it (the run is aborted, not thrown into). `execute` resolves `{ outcome: 'suspended', pending: [{ id, name, payload }], cache }`.

Resume is **re-execution** — the one and only path. A `waiting` record is not terminal: on the next `execute` the boundary **re-dispatches** and the handler, consulting your host state, does one of:

- **proceed** — perform the real work now (implicit consent gates: the DELETE fires exactly once, after approval) or return the stored answer (explicit approval gates) → completed boundary, the durable call resolves with it on this and every future replay;
- **suspend again** — still waiting;
- **throw** — e.g. a denial: recorded as a failed boundary, re-thrown deterministically and **catchable in the sandbox**.

There is no way to inject a value from outside: everything in the cache provably originated in a live dispatch or an explicit in-sandbox commit.

## External suspension (server teardown)

`runner.execute(...)` returns a handle — the **`result`** promise plus **`suspend()`**:

<!-- eslint-skip -->

```ts
const handle = runner.execute({ code, cache, handlers })
process.on('SIGTERM', async () => {
  const r = await handle.suspend() // aborts the isolate, DRAINS in-flight handler IO
  await persist(r.cache)           // drained results are recorded — replay fast-paths them
})
```

`suspend()` aborts the isolate (CPU work since the last boundary is disposable — replay redoes it), lets every **in-flight handler dispatch finish and be recorded** (the IO is not wasted), then resolves with `{ outcome: 'suspended', pending, cache }` — the same shape as a handler suspension, with possibly-empty `pending`. A run already suspended on approval is inert data and needs nothing.

## Checkpoints (sandbox-side work)

Host handlers cover work the host performs. For a stretch of work done **in the sandbox** whose result should survive a restart, use the checkpoint protocol from `durable-isolates:internal`:

- `durableLookup(key)` — a **non-memoized** read of the live cache: `{hit: true, value}` or `{hit: false}`. Deliberately not a boundary itself (a recorded "miss" would replay as a miss forever).
- `durableCommit(key, value)` — record a completed boundary from the sandbox. Value-only: a failed stretch throws, stays unrecorded, and simply re-runs next turn (retry accounting is your layer's job).
- `boundary(key, fn)` — the sugar: hit → cached value **without running `fn`**; miss → run `fn`, commit, return.

`boundary` is **nestable** — `key` joins an ambient prefix while `fn` runs, so inner keys concatenate:

<!-- eslint-skip -->

```ts
const analysis = await boundary('agent-analysis', async () => {
  const session = await agents.session('analyst') // key: agent-analysis/session#0
  const result = await session.prompt('…')        // key: agent-analysis/prompt#0 — may suspend
  return result.summary
})
```

A body containing durable calls re-runs on every replay **until committed** — inner boundaries fast-path from the cache (same session id, no new agent) — then is skipped wholesale; leftover inner records are harmless. A body with no suspension points inside runs exactly once. Scopes must run **sequentially** (the ambient prefix is not async-context-safe); parallel _leaf_ calls are fully supported — keys form synchronously in source order.

## Consent-gated HTTP with `@iso4/fetch`

Mount `createSafeFetch(...).handler` as the `fetch` handler; the shim keys each call, and the middleware gates via `SuspendIsolate`. Reads are cached and never re-fetched on resume:

<!-- eslint-skip -->

```ts
import { createSafeFetch } from '@iso4/fetch'
import { SuspendIsolate } from 'durable-isolates'

const handlers = {
  fetch: createSafeFetch({
    rules: {
      host: 'tenant.example.com', httpsOnly: true, routes: [{ path: '/**' }],
      middleware: async (fctx, next) => {
        const method = fctx.req.method
        const path = new URL(fctx.req.url).pathname
        if (isBlocked(method, path)) throw new Error('forbidden')
        if (needsConsent(method, path) && !approved(method, path))
          throw new SuspendIsolate({ method, path })   // suspend for approval
        injectAuth(fctx); await next()
      },
    },
  }).handler,
}
// shim: export const fetch = (url, init) => durableCall(nextKey('fetch'), 'fetch', url, init)
```

Run 1 records the GETs and suspends on the gated `DELETE`; after approval, re-running fast-paths the cached reads (not re-fetched) and re-dispatches the `DELETE`, which runs exactly once.

## Determinism

Keys are formed deterministically in the shim, so re-running the same source produces the same key sequence and nothing is mis-cached. Determinism is a **documented contract, not an enforced check**: code that branches on `Date.now()`/randomness simply misses the cache and re-runs work (or, with counter keys, can mis-align onto the wrong entry) — the kernel does not police it. Get time and randomness from durable call results, not the ambient environment, and keep keys deterministic.

## Errors

- A durable handler that throws is recorded as a failed boundary and re-thrown **deterministically** on replay, at the same call site — a sandbox `try/catch` replays identically, and `name`/`message`/`stack`/`data` are preserved (the error crosses the bridge as data, not a thrown error).
- Retry and eviction are **your** job as cache surgery: delete a failed entry to re-execute that boundary; delete by `seq` suffix to evict a boundary and everything recorded after it.

## API

### `durableIsolates(options?)`

Binds one iso4 sandbox (`options.sandbox` → `@iso4/sandbox`). Returns `{ hydrate, dispose }`; the sandbox is created lazily on first `hydrate` and reused.

### `host.hydrate({ modules, limits? })`

Precompiles a prefix from the mounted `modules` (`{ [specifier]: { shim, handlers? } }`) plus `durable-isolates:internal`. `limits` are default iso4 `ResourceLimits` for this prefix (`maxBridgeCalls` defaults to `1000`). Returns `{ execute, dispose }`.

### `runner.execute({ code, cache, handlers?, limits? })`

One replay turn. `handlers` rebinds host handlers for this run (keyed by operation name — auth and approval answers in their closure). Returns an **`ExecuteHandle`** — `{ result, suspend }`: `result` is the `Promise` of `{ outcome: 'completed', result, cache } | { outcome: 'suspended', pending, cache } | { outcome: 'failed', error, cache }`; `suspend()` is the external teardown (aborts, drains in-flight dispatches, resolves `'suspended'`; a no-op once the run settled). Persist `cache` and hand it back as the next `cache`.

### `SuspendIsolate`

`SuspendIsolate` (`extends Error`) — thrown by a host handler to suspend the run; `new SuspendIsolate(payload?)` carries what surfaces on `pending`.

The shim-facing surface (`durableCall`, `durableLookup`, `durableCommit`, `boundary`, `nextKey`) is typed at `durable-isolates/internal`; the iso4 type surface is re-exported from `durable-isolates/types/iso4`.

## License

MIT
