# durable-isolates

The replay kernel behind [`durable-workflows`](../durable-workflows), built on [`iso4`](https://github.com/schplitt/iso4).

Run a program in a sandbox and make chosen operations durable. Their results live in a cache you persist, so a run can pause, survive a restart, and continue later. Resume is always the same move: run it again with the cache you saved.

> Node >= 26, ESM only.

## Install

```sh
pnpm add durable-isolates
```

`@iso4/sandbox` is a peer you provide. `@iso4/fetch` is optional, for a durable HTTP capability.

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

## License

MIT
