/**
 * durable-isolates — the replay kernel: durably execute one isolate program
 * over a keyed cache of boundaries. See `./types` for the full public type
 * surface.
 */
export type * from './types'
export { durableIsolates } from './durable-isolates'
export { SuspendIsolate } from './suspend-isolate'
