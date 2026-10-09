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
- **JSON in, JSON out.** Every value crossing a boundary is written and read back as JSON already on the first run, so a replay sees exactly what the first run saw. What JSON cannot write, a bigint, a cycle or a serializer that throws, ends the run with a clear message.
- **Divergence is caught.** A replay that asks a recorded key for a different call (another operation, or other arguments) ends the run with a message saying what differed, instead of answering from a history that no longer fits.

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

## Values cross as JSON

Everything that crosses a durable boundary is written with `JSON.stringify` and read back with `JSON.parse` before anyone sees it, already on the first run. That covers the arguments of a durable call, what a global returns or throws, and what a `boundary()` body returns or `durableCommit` stores. The cache is saved and read back as JSON anyway, so doing the same on the first run means every run sees the same value.

What that means in practice, exactly as JSON does it:

| You Pass                   | Everyone Sees                            |
| -------------------------- | ---------------------------------------- |
| `new Date(0)`              | `'1970-01-01T00:00:00.000Z'`             |
| `new Map(…)`, `new Set(…)` | `{}`                                     |
| `NaN`, `Infinity`          | `null`                                   |
| a class instance           | its fields, or what its `toJSON` returns |
| `new Uint8Array([1, 2])`   | `{ "0": 1, "1": 2 }`                     |
| `{ a: undefined }`         | `{}`                                     |
| `[undefined, -0]`          | `[null, 0]`                              |
| a function, a symbol       | dropped in objects, `null` in arrays     |

The kernel does not guard against a lossy reading: a `Response` returned from a global is recorded as `{}`, forever. Convert values yourself where the JSON reading is not what you want: a response to its parsed body, bytes to text or base64, a `Map` to an object. Thrown `Error`s are stored as their `name` and `message` only.

What JSON cannot write at all, a `bigint`, a circular structure, or a `toJSON` or getter that throws while serializing, ends the run with `outcome: 'rejected'`. The isolate is aborted and the violating call never settles, so a `try/catch` in the program cannot swallow it. Nothing is recorded at the violating key, every other in-flight call is still drained into `cache`, and `rejection` says what happened:

<!-- eslint-skip -->

```ts
const r = await runner.execute({ code, cache, globals: { count: () => ({ total: 10n }) } }).result
if (r.outcome === 'rejected') {
  r.rejection.reason // 'non-json'
  r.rejection.source // 'result' — or 'args', 'error', 'commit'
  r.rejection.key // 'count#0'
  r.rejection.detail // 'Do not know how to serialize a BigInt'
  r.rejection.message // 'durable-isolates: a value in what a global returned cannot be written as JSON. Only values JSON can write may cross a durable boundary: …'
}
```

The message never contains text the program wrote. The key, the global's name and the serializer's `detail`, which may quote a property name, are in the structured fields. Fix the global or the program and run the same `cache` again.

Values from the program (call arguments, committed values) are stringified inside the sandbox, on the real object, so `toJSON` methods and getters behave as they would under `JSON.stringify`, and a getter is read exactly once.

## Replays must ask the same calls

A durable call at a key that is already in the cache is answered from the record. Before that, the kernel checks that the program is asking for the same call the record holds: the same `name`, with the same `args`. Arguments are compared as stable JSON, so object key order does not matter, but array order does. If they differ, the run ends with `outcome: 'rejected'` and `rejection.reason === 'divergence'`. Nothing is answered, re-thrown or re-dispatched, and the history is left as it was.

<!-- eslint-skip -->

```ts
if (r.outcome === 'rejected' && r.rejection.reason === 'divergence') {
  r.rejection.mismatch // 'name' | 'args' | 'no-call'
  r.rejection.key // 'echo#0'
  r.rejection.recorded // { name: 'echo', args: ['first'] }
  r.rejection.attempted // { name: 'echo', args: ['second'] }
  r.rejection.message // '… wrap nondeterministic inputs such as time, random values or external state in boundary() …'
}
```

This is how a nondeterministic program shows up: two parallel calls whose order depends on which finished first, a call whose arguments include `Date.now()` or a random id, a branch taken on data that changed between runs. The fix is in the program: keep durable calls in the same order on every run, and wrap nondeterministic inputs in `boundary()` so they are recorded once and replayed. `mismatch: 'no-call'` means the key holds a checkpoint (`boundary()` / `durableCommit`) or a record written by an older kernel, so there is no call to compare against.

What is not checked: keys. A call at a key that is not in the cache simply runs, even if the program changed. Checkpoint keys are not compared either, since a checkpoint records a value, not a call.

To recover a diverged instance, change the program or the inputs so the calls line up again and run the same `cache`, or evict records (delete by `seq` from the diverged key onwards) and let that part run again.

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

| `outcome`   | `run`              | Notes                                                                                                                                                                                                                                  |
| ----------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `completed` | `RunSuccess`       | `queueWaitMs` only when the run queued for a slot                                                                                                                                                                                      |
| `failed`    | `RunFailure`       | `run.error` is `error`; no `queueWaitMs` on `ERR_QUEUE_FULL` (refused before admission)                                                                                                                                                |
| `suspended` | iso4's aborted arm | Numbers up to the pause; no `queueWaitMs` or `heapUsedBytes`; zero timings if aborted in a tight sync loop. If the program finished without awaiting the suspending call, the outcome is still `suspended` and `run` is iso4's own arm |

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
