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
- **JSON in, JSON out.** Every value crossing a boundary is checked and normalized to plain JSON, so a replay reads back exactly what the first run saw. Anything else ends the run with a message that says where and what.

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

## The cache

The cache is a plain JSON object: one record per boundary, keyed by the key the sandbox formed. Any string is a valid key, including `__proto__` or `constructor`. The kernel matches by key only, never by position. Each record has a `status` and a `seq` (history order, for eviction and timelines).

A record written by a host call (`durableCall`) also stores the call itself: the `name` that was dispatched and the `args` the shim forwarded. So the cache says what was asked at each key, not only what came back.

| `status`    | Written By                                 | Fields                              |
| ----------- | ------------------------------------------ | ----------------------------------- |
| `completed` | a global returning                         | `name`, `args`, `value`             |
| `failed`    | a global throwing, or no global for `name` | `name`, `args`, `error`             |
| `waiting`   | a global throwing `SuspendIsolate`         | `name`, `args`                      |
| `completed` | `boundary()` / `durableCommit`             | `value` only (no `name`, no `args`) |

<!-- eslint-skip -->

```ts
const r = await runner.execute({ code, cache: {}, globals: { load } }).result
r.cache['load#0']
// { seq: 0, status: 'completed', name: 'load', args: ['r-1'], value: { … } }
```

Retry and eviction are plain edits to this object: delete a `failed` record to run that boundary again, or delete every record from a `seq` onwards to evict a boundary and everything after it.

## Values must be JSON

Everything that crosses a durable boundary must be plain JSON: `null`, booleans, finite numbers, strings, arrays and plain objects. That covers the arguments of a durable call, what a global returns or throws, and what a `boundary()` body returns or `durableCommit` stores. The cache is saved and read back as JSON, so a value JSON cannot carry would look one way on the first run and another way on replay. The kernel refuses such a value instead of storing an approximation.

Rejected: `Date`, `Map`, `Set`, `RegExp`, bytes (`Uint8Array`, `ArrayBuffer`), `bigint`, `NaN` and `Infinity`, functions, symbols, class instances (including `Error` objects as values), sparse arrays (holes) and cyclic structures. Objects with a `toJSON` method are not special-cased: the method is a function and is rejected as such. Convert values before the boundary: a date to an ISO string, bytes to text or base64, a `Map` to an object. There is no depth limit; a value too deep to walk is rejected rather than crashing.

`undefined` follows JSON's own rules, and the kernel applies them already on the first run so every run sees the same value: a key with `undefined` is dropped from an object, `undefined` in an array becomes `null`, a bare `undefined` return stays `undefined`, and `-0` becomes `0`. Thrown `Error`s are stored as their `name` and `message` only.

The message never contains text the program wrote: the key and the global's name are in the structured fields, the `path` quotes any key that is not a plain identifier, and `found` is a class or type name.

A violation ends the run with `outcome: 'rejected'`. The isolate is aborted and the violating call never settles, so a `try/catch` in the program cannot swallow it. Nothing is recorded at the violating key, every other in-flight call is still drained into `cache`, and `rejection` says what happened:

<!-- eslint-skip -->

```ts
const r = await runner.execute({ code, cache, globals: { now: () => ({ at: new Date() }) } }).result
if (r.outcome === 'rejected') {
  r.rejection.reason // 'non-json'
  r.rejection.source // 'result' — or 'args', 'error', 'commit'
  r.rejection.key // 'now#0'
  r.rejection.path // '$.at'
  r.rejection.found // 'Date'
  r.rejection.message // 'durable-isolates: non-JSON value in what a global returned: Date at $.at. Only JSON values (…) can cross a durable boundary; …'
}
```

The message is written for whoever wrote the program, so it can be handed to a model as is. Fix the global or the program and run the same `cache` again.

The check is exported as `toJson(value)`. It returns the JSON-normalized copy or throws `NonJsonValueError` with `path` and `found`, so you can validate your own inputs the same way before a run:

<!-- eslint-skip -->

```ts
import { NonJsonValueError, toJson } from 'durable-isolates'

const input = toJson(untrusted) // throws NonJsonValueError('$.items[2].at', 'Date')
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

## Per-run metrics

Every result also carries `run`, which is iso4's own result for that turn, passed through unchanged. It has the per-run clocks (`durationMs`, `wallTimeMs`, `cpuTimeMs`, `queueWaitMs`), `heapUsedBytes`, `bridgeCalls` and `stdout`/`stderr`. Which iso4 arm you get depends on `outcome`:

| `outcome`   | `run`              | Notes                                                                                                      |
| ----------- | ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `completed` | `RunSuccess`       | `queueWaitMs` only when the run queued for a slot                                                          |
| `failed`    | `RunFailure`       | `run.error` is `error`; no `queueWaitMs` on `ERR_QUEUE_FULL` (refused before admission)                    |
| `suspended` | iso4's aborted arm | Numbers up to the pause; no `queueWaitMs` or `heapUsedBytes`; zero timings if aborted in a tight sync loop |

The clocks stop when the isolate settles. Letting in-flight dispatches finish afterwards (the drain) is not counted.

`bridgeCalls` includes the kernel's own bridge calls. Every durable call (a cache hit or a dispatch) crosses as `__di_call`, and checkpoints cross as `__di_lookup` and `__di_commit`. Entries carry no arguments, so a `__di_call` entry does not say which operation it was. Use `KERNEL_BRIDGE_GLOBALS` to split them out:

<!-- eslint-skip -->

```ts
import { KERNEL_BRIDGE_GLOBALS } from 'durable-isolates'

const r = await runner.execute({ code, cache }).result
const { wallTimeMs, cpuTimeMs, bridgeCalls } = r.run
const kernel = bridgeCalls.filter(c => KERNEL_BRIDGE_GLOBALS.some(n => n === c.name))
```

## `waitUntil` is not durable

iso4 lets sandbox code register background work with `waitUntil`, which keeps running after the run's result has been delivered. Durable calls and checkpoints are not supported inside that work. By the time it runs, `execute` has already returned, so anything it records would be written into a `cache` you may already have saved. Keep durable calls on the awaited path of the program.

## License

MIT
