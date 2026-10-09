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
- **Plain and durable, side by side.** `imports` and `globals` are iso4's, untouched: plain host functions and data. `durableGlobals` are the functions a shim reaches through `durableCall`, and only those are recorded and replayed. `durableImports` are durable modules the kernel writes the shim for.
- **JSON in, JSON out.** Every value crossing a boundary is written and read back as JSON already on the first run, so a replay sees exactly what the first run saw. What JSON cannot write, a bigint, a cycle or a serializer that throws, ends the run with a clear message.
- **Divergence is caught.** A replay that asks a recorded key for a different call (another operation, or other arguments) ends the run with a message saying what differed, instead of answering from a history that no longer fits.
- **Keys are single-use and globals must be mounted.** A key reused within a run, a commit onto a recorded key, or a call whose global is missing ends the run too, with a message naming the rule.

## Quick start

<!-- eslint-skip -->

```ts
import { durableIsolates } from 'durable-isolates'

const di = durableIsolates()
const runner = await di.prepare({
  imports: {
    reports: `
      import { durableCall, nextKey } from 'durable-isolates:internal'
      export const load = id => durableCall(nextKey('load'), 'load', id)
    `,
  },
  durableGlobals: { load: (id) => db.reports.get(id) },
})

let cache = {}
const r = await runner.execute({
  code: `import { load } from 'reports'; export default await load('r-1')`,
  cache,
}).result

if (r.outcome === 'completed')
  console.log(r.result)
cache = r.cache // persist, then hand back next time
```

## Plain calls: iso4 imports and globals

`prepare` takes iso4's `imports` and `globals` exactly as iso4 defines them, and passes them through. A string import is a sandbox module, which is where a shim lives. An object import is an iso4 host module: plain host functions and data, nested up to 64 levels, that sandbox code imports by name. A global is a plain host function on `globalThis` (or, as in iso4, a string expression or a data constant). None of this is durable, and the kernel never touches it: a plain function runs on every replay, nothing is recorded, and values cross with iso4's own V8 serialization, so a `Date` stays a `Date`. Keep a plain result with `boundary()` when it should survive a replay.

<!-- eslint-skip -->

```ts
const runner = await di.prepare({
  imports: {
    reports: shimSource,                                    // sandbox module
    'acme/util': { version: '1.2', clock: { now: () => Date.now() } }, // plain host module
  },
  globals: { log: (...a) => console.log(...a) },            // plain global
  durableGlobals: { load },                                 // durable, reached through durableCall
})
runner.execute({ code, cache, imports: { 'acme/util': { clock: { now: fixedNow } } }, globals: { log }, durableGlobals: { load: authed } })
```

Per-run overrides follow the same split: `imports` and `globals` are iso4's rebind of the plain functions for this run, `durableGlobals` rebinds the registry. A per-run override that names something iso4 cannot rebind, an unknown global or path, a string module, a data leaf, fails the run with iso4's own error. Two things are the kernel's on the plain side: the specifier `durable-isolates:internal` and the three bridge global names (`KERNEL_BRIDGE_GLOBALS`) are reserved, and a name cannot be both a plain global and a durable global, so one name never means two things. Suspension is a durable call's feature: a `SuspendIsolate` thrown from a plain function is just an error named `SuspendIsolate` in the program, and a failed run carrying that name means the call should have been durable.

## Durable modules without a shim: `durableImports`

Most durable modules are just "these host functions, recorded": no custom keys, no sandbox logic. For those, hand the functions to `durableImports` and the kernel writes the sandbox module itself.

<!-- eslint-skip -->

```ts
const runner = await di.prepare({
  durableImports: {
    acme: { load, save, inventory: { count } },   // host functions, nested objects allowed
  },
})
// program: import { load, inventory } from 'acme'; await load('r-1'); await inventory.count()
runner.execute({ code, cache, durableImports: { acme: { load: authed } } })   // per-run rebind, same shape
```

The generated module for `acme` is, in full:

```js
import * as __di from 'durable-isolates:internal'

const __di_op = (name) => (...args) => __di.durableCall(__di.nextKey(name), name, ...args)
export const load = __di_op('acme.load')
export const save = __di_op('acme.save')
export const inventory = { count: __di_op('acme.inventory.count') }
```

So a call records as `acme.load#0` (scope-prefixed inside a `boundary()`), with `name: 'acme.load'`, and gets everything a hand-written shim gets: JSON transport, the position, divergence detection, suspension through `SuspendIsolate`. The dotted name is also the name under `durableGlobals`, so `durableGlobals: { 'acme.load': authed }` and `durableImports: { acme: { load: authed } }` are the same override.

`prepare` refuses, naming the path: a data value as a leaf (nothing to record), a top-level name that is not a usable export identifier (nested names may be any string), a specifier that is also in `imports`, a dotted name that is also in `durableGlobals` or produced by two modules, and the reserved specifier. `execute` throws before the run starts if a per-run `durableGlobals` or `durableImports` value is neither a function nor `undefined`; when both name the same operation, `durableGlobals` wins.

## The cache

The cache is a plain JSON object: one record per boundary, keyed by the key the sandbox formed. Any string is a valid key, including `__proto__` or `constructor`. Each record has a `status`, a `seq` (write order, for eviction and timelines), and a position: `scope` (the `boundary()` the operation was issued in, `''` at the top level) plus `order` (its number within that scope, counted in source order). The position is what the replay check below compares.

A record written by a host call (`durableCall`) also stores the call itself: the `name` that was dispatched and the `args` the shim forwarded. So the cache says what was asked at each key, not only what came back.

| `status`    | Written By                                 | Fields                              |
| ----------- | ------------------------------------------ | ----------------------------------- |
| `completed` | a global returning                         | `name`, `args`, `value`             |
| `failed`    | a global throwing                          | `name`, `args`, `error`             |
| `waiting`   | a durable global throwing `SuspendIsolate` | `name`, `args`                      |
| `completed` | `boundary()` / `durableCommit`             | `value` only (no `name`, no `args`) |

<!-- eslint-skip -->

```ts
const r = await runner.execute({ code, cache: {}, durableGlobals: { load } }).result
r.cache['load#0']
// { seq: 0, status: 'completed', name: 'load', args: ['r-1'], scope: '', order: 0, value: { … } }
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
const r = await runner.execute({ code, cache, durableGlobals: { count: () => ({ total: 10n }) } }).result
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

Every durable call and every `boundary()` takes a position when the program issues it: a counter per scope, in source order for everything issued in one synchronous stretch, so `Promise.all([a(), b()])` numbers `a` then `b` whichever finishes first. A `boundary()` body counts in its own scope, so when the boundary is later answered from the cache its whole body is skipped without disturbing the numbering outside it. The position is stored on the record as `scope` and `order`.

One rule follows from this: a parallel branch that makes more than one durable call in sequence must be its own `boundary()`. Inside `Promise.all`, a second call in a branch is issued when the first one finishes, and that timing differs between the first run and a replay. With the branch wrapped, its calls are numbered inside the branch's own scope and the timing does not matter. This is the same rule codemode states for its runs, and it applies to the keys as much as to the positions.

On replay the kernel checks, before answering anything: the operation at a recorded key must sit at the recorded position, a new key must not take a position another key already holds, and a durable call at a recorded key must ask the same `name` with the same `args`. Arguments are compared as stable JSON, so object key order does not matter, but array order does. If any of that differs, the run ends with `outcome: 'rejected'` and `rejection.reason === 'divergence'`. Nothing is answered, re-thrown or re-dispatched, and the history is left as it was.

<!-- eslint-skip -->

```ts
if (r.outcome === 'rejected' && r.rejection.reason === 'divergence') {
  r.rejection.mismatch // 'order' | 'name' | 'args' | 'kind'
  r.rejection.key // 'echo#0'
  r.rejection.recorded // { key: 'echo#0', scope: '', order: 0, name: 'echo', args: ['first'] }
  r.rejection.attempted // { scope: '', order: 0, name: 'echo', args: ['second'] }
  r.rejection.message // '… wrap nondeterministic inputs such as time, random values or external state in boundary() …'
}
```

This is how a nondeterministic program shows up: two calls swapped, a branch taken on data that changed between runs (the other branch's call lands on a position the history already holds), a call whose arguments include `Date.now()` or a random id, a new call inserted before recorded ones. The fix is in the program: keep durable calls in the same order on every run, and wrap nondeterministic inputs in `boundary()` so they are recorded once and replayed. `mismatch: 'kind'` means the key holds the other kind of operation: a durable call where a `boundary()` was recorded, or a `boundary()` where a call was.

What is not checked: the value a checkpoint recorded, and a call at a new key whose position is free (it simply runs, even if the program changed).

To recover a diverged instance, change the program or the inputs so the calls line up again and run the same `cache`, or evict the diverged scope (every record whose `scope` is the rejection's scope or nested under it) and let that part run again. `seq` alone is not enough here: a parent `boundary()` is written after its body, and two swapped calls both have to go.

## Keys are used once, globals must be mounted

Two more rules keep the history unambiguous. Both end the run with `outcome: 'rejected'`.

- **A key names one operation per run, and a record is written once.** A step id reused in a loop, two parallel steps with the same id, or a call reusing a step's key is `reason: 'duplicate-key'` with `detail: 'used twice in this run'`. The first use may have run; nothing is recorded for the second. A retry inside the same run therefore needs a new key: `step.do('fetch', …)` failing and being retried as `step.do('fetch', …)` again is a duplicate, `step.do('fetch-retry', …)` is not. A commit onto a key the history already holds, from any run, is the same reason with `detail: 'already recorded'`.
- **A call that has to run needs its global.** A call at a new key, or a waiting record being resumed, routed to a name with no mounted global is `reason: 'unknown-global'`, carrying the `name`. A call answered from the cache needs no global. Nothing is recorded, and a waiting record at that key stays as it was, so mounting the global and running the same cache resumes. Typical causes: the mounted globals changed between a deploy and a resume, or a shim routes to a name nobody mounted.

## All the ways a run is rejected

`rejection.reason` is one of five values, and every message is written for whoever wrote the program, with no program text in it:

| `reason`         | Meaning                                                                        | Section                         |
| ---------------- | ------------------------------------------------------------------------------ | ------------------------------- |
| `non-json`       | a value JSON cannot write crossed a boundary                                   | Values cross as JSON            |
| `divergence`     | the replay no longer lines up with the history                                 | Replays must ask the same calls |
| `duplicate-key`  | a key was used twice, or a commit targeted a recorded key                      | Keys are used once              |
| `unknown-global` | a call that had to run has no mounted global                                   | Keys are used once              |
| `protocol`       | a program reached a bridge global directly with a payload the shim never sends | —                               |

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
