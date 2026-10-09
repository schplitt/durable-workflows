/**
 * Thrown by a DURABLE global (or middleware it calls) to suspend the whole run.
 *
 * The kernel catches it ONLY at the durable dispatch site — the
 * `await global(...args)` behind `durableCall` — never in the sandbox. On
 * catch it writes a waiting boundary and aborts the run via the iso4
 * `AbortSignal`, so nothing further executes and no value is delivered for the
 * suspending call. Resume is re-execution: the waiting boundary re-dispatches
 * and the global, consulting host state, proceeds, suspends again, or throws.
 * Suspension is a durable call's feature because the waiting record is what
 * the resume continues from; thrown from a PLAIN function (an iso4 global or
 * host-module function) it is just an error named `SuspendIsolate` in the
 * program — a failed run carrying that name means the call should have been
 * durable.
 *
 * It is an `Error` subclass so it unwinds the global's host-side call stack
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
