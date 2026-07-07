# durable-isolates

The replay kernel for [`durable-workflows`](../durable-workflows), built on top of [`iso4`](https://github.com/schplitt/iso4).

A (nearly) pure function over a log: `execute(code, log, handlers)` re-runs the same source, answers host-backed calls from the log when already recorded, runs the first unrecorded call for real, and lets a handler suspend the whole run — everything the caller must remember comes back as the grown log.

> 🚧 Work in progress — the kernel is not implemented yet.

## License

MIT
