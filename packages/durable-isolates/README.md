# durable-isolates

Run JavaScript in a sandbox and make chosen calls durable.

A durable call runs once. Its result goes into a cache you keep. Run the same program again with that cache and the call is answered from it instead of running again. That is the whole trick: a program can pause, your server can restart, and continuing is just running the program again with the cache.

Built on [iso4](https://github.com/schplitt/iso4). The engine behind [durable-workflows](../durable-workflows).

> Node >= 24, ESM only.

## Install

```sh
pnpm add durable-isolates
```

## Quick start

Give the sandbox a module that marks calls as durable, give the host the functions behind them, and run.

<!-- eslint-skip -->

```ts
import { durableIsolates } from 'durable-isolates'

const di = durableIsolates()

const runner = await di.prepare({
  durableImports: {
    reports: { load: id => db.reports.get(id) },
  },
})

let cache = {}

const r = await runner.execute({
  code: `import { load } from 'reports'; export default await load('r-1')`,
  cache,
}).result

if (r.outcome === 'completed')
  console.log(r.result)

cache = r.cache // save this
```

Run it again with the saved cache and `load('r-1')` is answered from the cache. `db.reports.get` is not called a second time.

## Pausing

A durable function can pause the run by throwing `SuspendIsolate`. The run stops, the call is recorded as waiting, and you get the result back with `outcome: 'suspended'`.

<!-- eslint-skip -->

```ts
import { SuspendIsolate } from 'durable-isolates'

const runner = await di.prepare({
  durableImports: {
    approvals: {
      ask: async (id) => {
        const answer = await db.approvals.get(id)
        if (!answer)
          throw new SuspendIsolate({ id }) // pause, the payload is for you
        return answer
      },
    },
  },
})

const r = await runner.execute({ code, cache }).result
if (r.outcome === 'suspended')
  r.pending // [{ id: 'approvals.ask#0', name: 'approvals.ask', payload: { id } }]
```

To continue, run the same code with `r.cache` again. The program replays up to the waiting call, which asks `ask` again. Nothing is injected from outside: the function looks at your systems and either answers or pauses again.

## Durable modules

`durableImports` is the simple way in. Give it host functions under a module name, and the sandbox can import them. Every call is durable.

<!-- eslint-skip -->

```ts
const runner = await di.prepare({
  durableImports: {
    acme: {
      load: id => db.get(id),
      users: { find: email => db.users.find(email) }, // nested works too
    },
  },
})

// in the sandbox:
// import { load, users } from 'acme'
// await load('r-1'); await users.find('a@b.c')
```

Each function gets a key the sandbox counts per call: `acme.load#0`, `acme.load#1`, `acme.users.find#0`. Functions only, and export names must be valid identifiers.

Per run, you can swap a function, for a credential bound to this request for example:

<!-- eslint-skip -->

```ts
runner.execute({ code, cache, durableImports: { acme: { load: loadAs(user) } } })
```

## Writing your own module

If you want control over keys, write the sandbox side yourself with `durable-isolates:internal` and put the host side in `durableGlobals`.

<!-- eslint-skip -->

```ts
const runner = await di.prepare({
  imports: {
    reports: `
      import { durableCall, nextKey, boundary } from 'durable-isolates:internal'

      // an auto-counted key: load#0, load#1, …
      export const load = id => durableCall(nextKey('load'), 'load', id)

      // a key you choose
      export const step = (id, fn) => boundary(id, fn)
    `,
  },
  durableGlobals: { load: id => db.reports.get(id) },
})
```

`durableCall(key, name, ...args)` runs the host function `name` once and caches it under `key`. `boundary(key, fn)` runs `fn` in the sandbox once and caches what it returns. Keys inside a boundary are scoped to it (`step/load#0`), so branches under `Promise.all` do not collide.

## Plain imports and globals

`imports` and `globals` are iso4's own and go through untouched. They are not durable: they run on every replay and nothing is recorded. Use them for logging, config, helpers.

<!-- eslint-skip -->

```ts
const runner = await di.prepare({
  imports: { 'acme/util': { version: '1.2' } }, // plain host module
  globals: { log: (...a) => console.log(...a) }, // plain global
  durableGlobals: { load },
})
```

If a plain call returns something you need to survive a replay, wrap it in `boundary()`.

## One run, one isolate

`prepare` builds a prefix that iso4 keeps warm. Runs on it are fast (about 0.1 ms of overhead) but share an instance, so one run can leave state on `globalThis` for the next. That is fine for the turns of one workflow. It is not fine for code from different tenants, or code a model wrote.

For those, use `run`. It takes what `prepare` and `execute` take together and gives the program its own isolate. Costs an isolate boot, about a millisecond.

<!-- eslint-skip -->

```ts
const r = await di.run({
  code,
  cache,
  durableImports: { acme },
  limits: { memoryMb: 128 },
}).result
```

## The cache

The cache is a plain JSON object you store wherever you like. One record per key:

<!-- eslint-skip -->

```ts
r.cache['acme.load#0']
// { seq: 0, status: 'completed', name: 'acme.load', args: ['r-1'], scope: '', order: 0, value: {…} }
```

| `status`    | Meaning                                    |
| ----------- | ------------------------------------------ |
| `completed` | done, `value` is the answer                |
| `failed`    | threw, `error` has `name` and `message`    |
| `waiting`   | paused by `SuspendIsolate`, will run again |

Retry and undo are edits to this object. Delete a `failed` record to run that call again. Delete every record from a `seq` on to roll back to that point.

A cache from version 0.2 cannot be continued. Its records have no position, so the first replay stops with a divergence. Finish or restart those instances.

## Values are JSON

Everything that crosses a durable call is run through `JSON.stringify` and `JSON.parse`, on the first run too. So every run sees the same value, and what you see is what JSON gives you: a `Date` becomes a string, a `Map` becomes `{}`, `undefined` disappears, a thrown error keeps its `name` and `message`. Convert anything else yourself before returning it.

What JSON cannot write at all (a `bigint`, a cycle, a `toJSON` that throws) stops the run. See below.

## When a run stops

A run can end four ways:

| `outcome`   | What Happened                                                  |
| ----------- | -------------------------------------------------------------- |
| `completed` | the program finished, `result` is its default export           |
| `suspended` | a durable call paused, `pending` lists it                      |
| `failed`    | the program threw or hit a limit, `error` is iso4's            |
| `rejected`  | the program broke a rule of the kernel, `rejection` says which |

A rejection is not catchable in the sandbox. Nothing is written at the offending key, so you can fix the cause and run the same cache again.

| `rejection.reason` | Cause                                                          |
| ------------------ | -------------------------------------------------------------- |
| `divergence`       | the replay asked something different from what the cache holds |
| `non-json`         | a value crossed that JSON cannot write                         |
| `duplicate-key`    | a key was used twice                                           |
| `unknown-global`   | a durable call has no host function behind its name            |
| `protocol`         | the program reached a kernel bridge directly                   |

**Divergence** is the one to know. On a replay, the kernel checks that the program issues the same durable calls, in the same order, with the same arguments as recorded. Anything else is a divergence, with `mismatch` telling you what differed (`order`, `name`, `args`, `kind`) and `recorded` versus `attempted` showing both sides. The fix is always in the program: keep durable calls in the same order, wrap time, random values and other changing inputs in `boundary()` so they are recorded once, and give a parallel branch that makes more than one durable call its own `boundary()`.

## Metrics

Every result carries `run`, iso4's own result for the turn: `durationMs`, `cpuTimeMs`, `heapUsedBytes`, `bridgeCalls`, `stdout`, `stderr`. The kernel's own bridge calls show up there too; their names are in `KERNEL_BRIDGE_GLOBALS`.

`di.getSandbox()` hands you the iso4 sandbox for `stats()` and friends. Tear down with `di.dispose()`.

## API

### `durableIsolates(options?)`

Creates the host. `options.sandbox` is passed to iso4's `createSandbox`. The sandbox is created on first use.

| Method             | Returns                               |
| ------------------ | ------------------------------------- |
| `prepare(options)` | `Promise<Runner>` — a warm prefix     |
| `run(options)`     | `Handle` — one run in its own isolate |
| `getSandbox()`     | `Promise<Sandbox>` — the iso4 sandbox |
| `dispose()`        | `Promise<void>`                       |

### `prepare(options)`

| Option           | Type                            | Description                                                |
| ---------------- | ------------------------------- | ---------------------------------------------------------- |
| `durableImports` | `Record<string, DurableModule>` | host functions as durable sandbox modules                  |
| `durableGlobals` | `Record<string, Function>`      | host functions reached by name through `durableCall`       |
| `imports`        | iso4 `Imports`                  | plain sandbox modules (source) or host modules             |
| `globals`        | iso4 `HostGlobals`              | plain globals                                              |
| `limits`         | `Partial<ResourceLimits>`       | defaults for every run (`maxBridgeCalls` defaults to 1000) |

### `runner.execute(options)`

| Option               | Type                            | Description                                |
| -------------------- | ------------------------------- | ------------------------------------------ |
| `code`               | `string`                        | the program, an ES module                  |
| `cache`              | `BoundaryCache`                 | the cache from the last run, `{}` to start |
| `durableImports`     | `Record<string, DurableModule>` | swap durable functions for this run        |
| `durableGlobals`     | `Record<string, Function>`      | same, by name                              |
| `imports`, `globals` | iso4 rebinds                    | swap plain functions for this run          |
| `limits`             | `Partial<ResourceLimits>`       | this run's limits                          |

`runner.dispose()` drops the prefix.

### `di.run(options)`

Everything `prepare` takes plus `code` and `cache`. No per-run overrides, since there is nothing prepared to override. `limits` are iso4's one-off limits and allow `memoryMb`.

### `Handle`

| Member      | Description                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------ |
| `result`    | `Promise<ExecuteResult>`                                                                               |
| `suspend()` | stop the run from outside (server shutdown), keep what durable calls finished, resolve with the result |

### `ExecuteResult`

Always has `outcome`, `cache` and `run`. Then by outcome: `result`, `pending`, `error` or `rejection`.

### `durable-isolates:internal`

The module a sandbox shim imports.

| Export                            | Description                                                |
| --------------------------------- | ---------------------------------------------------------- |
| `durableCall(key, name, ...args)` | run host function `name` once, cached under `key`          |
| `boundary(key, fn)`               | run `fn` once, cache what it returns, scope keys inside it |
| `nextKey(name)`                   | `name#0`, `name#1`, … within the current scope             |
| `durableLookup(key)`              | read the cache: `{ hit, value }`                           |
| `durableCommit(key, value)`       | write the cache                                            |

### `SuspendIsolate`

`throw new SuspendIsolate(payload)` from a durable function pauses the run. `payload` is handed back on `pending`.

## License

MIT
