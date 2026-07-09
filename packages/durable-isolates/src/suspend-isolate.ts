/**
 * Thrown by a host handler (main-world code — a mounted module's handler, or
 * middleware it calls) to suspend the whole run.
 *
 * The kernel catches it ONLY at the dispatch site — the `await handler(...args)`
 * inside the durable bridge — never in the sandbox. On catch it writes a
 * waiting boundary and aborts the run via the iso4 `AbortSignal`, so nothing
 * further executes and no value is delivered for the suspending call. Resume is
 * re-execution: the waiting boundary re-dispatches and the handler, consulting
 * host state, proceeds, suspends again, or throws.
 *
 * It is an `Error` subclass so it unwinds the handler's host-side call stack
 * naturally (e.g. out of a fetch middleware). Any OTHER throw is recorded as a
 * failed boundary and replays deterministically. `payload` is what the caller
 * dispatches outward (surfaced on `ExecuteResult.pending`).
 */
export class SuspendIsolate extends Error {
  readonly payload: unknown

  constructor(payload?: unknown) {
    super('SuspendIsolate')
    this.name = 'SuspendIsolate'
    this.payload = payload
  }
}
