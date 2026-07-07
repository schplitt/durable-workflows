# durable-workflows

A composable durable workflow library for JavaScript, actively inspired by [Cloudflare Workflows](https://developers.cloudflare.com/workflows/), built on top of [`iso4`](https://github.com/schplitt/iso4) and the [`durable-isolates`](../durable-isolates) replay kernel.

Workflows run inside a sandbox and use a step-based API whose results are persisted, so they can be suspended, resumed on timers or external events, retried, or stopped. The persistence layer is pluggable — bring your own store — and the sandbox can be extended with your own global APIs and module imports.

> 🚧 Work in progress — nothing to see here yet.

## License

MIT
