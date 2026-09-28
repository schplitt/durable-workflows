# durable-isolates

The replay kernel behind [`durable-workflows`](../durable-workflows), built on [`iso4`](https://github.com/schplitt/iso4).

Run a program in a sandbox and make chosen operations durable. Their results live in a cache you persist, so a run can pause, survive a restart, and continue later. Resume is always the same move: run it again with the cache you saved.

> Node >= 24, ESM only.

## Install

```sh
pnpm add durable-isolates
```

`@iso4/sandbox` is included as a regular dependency. `@iso4/fetch` is optional, for a durable HTTP capability.

## Features

- **Durable by key.** A completed operation is answered from the cache and never runs twice. A fresh one runs for real.
- **Pause and continue.** A host global can pause the whole run; continue by running again with the saved cache. No value is ever injected from outside.
- **Nested scopes, sequential or parallel.** Group work with `boundary(key, fn)`; nested keys stay isolated per branch, even under `Promise.all`.
- **You own storage.** The kernel keeps nothing. It hands back a cache, you persist it and pass it back next time.

## Quick start

<!-- eslint-skip -->

```ts
import { durableIsolates } from 'durable-isolates'

const di = durableIsolates()
const runner = await di.prepare({
  modules: {
    reports: {
      shim: `
        import { durableCall, nextKey } from 'durable-isolates:internal'
        export const load = id => durableCall(nextKey('load'), 'load', id)
      `,
    },
  },
})

let cache = {}
const r = await runner.execute({
  code: `import { load } from 'reports'; export default await load('r-1')`,
  cache,
  globals: { load: (id) => db.reports.get(id) },
}).result

if (r.outcome === 'completed')
  console.log(r.result)
cache = r.cache // persist, then hand back next time
```

## Sandbox metrics and errors

`durableIsolates({ sandbox })` takes iso4 `SandboxOptions` and owns the one sandbox: it is created lazily and torn down by `dispose()`. To reach the iso4 API directly (for example `stats()` for load metrics), use `getSandbox()`. It returns the same sandbox `prepare` uses, creating it first if needed, so you can scrape metrics before the first run. Leave teardown to `di.dispose()`.

<!-- eslint-skip -->

```ts
const di = durableIsolates({ sandbox: { maxQueuedRuns: 100 } })
const sandbox = await di.getSandbox()
setInterval(async () => {
  const { activeRuns, queueDepth, slotLimit, usageBytes, underPressure, prefixes } = await sandbox.stats()
  // runner.prefixId is the key into `prefixes`
}, 5_000)
```

A failed run resolves with `{ outcome: 'failed', error }`, where `error` is iso4's `RunError` passed through unchanged. Its `code` (`ERR_CPU_TIMEOUT`, `ERR_WALL_TIMEOUT`, `ERR_MEMORY_LIMIT`, `ERR_BRIDGE_CALL_LIMIT_EXCEEDED`, `ERR_QUEUE_FULL`, `ERR_CAPACITY_MEMORY`, …) is intact. Capacity refusals come back this way too, not as a rejected promise.

## License

MIT
