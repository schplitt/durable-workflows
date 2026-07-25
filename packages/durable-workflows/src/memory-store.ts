/**
 * An in-memory {@link WorkflowStore} — the reference adapter, for tests and
 * single-process throwaway runs. It holds instances, boundary caches and
 * deployed definitions in plain `Map`s; nothing is persisted, so a process
 * restart loses everything.
 *
 * Records and caches are deep-cloned on the way in and out (`structuredClone`),
 * mirroring what a real backend does when it serializes across a boundary: a
 * caller cannot mutate stored state by holding onto a reference it passed in or
 * got back. A production adapter (SQL, a platform's managed objects) implements
 * the same methods against durable storage.
 */
import type { ResourceLimits } from 'durable-isolates/types/iso4'
import type { BoundaryCache } from 'durable-isolates'
import type { InstanceRecord, ResolvedDefinition, WorkflowStore } from './types'

/**
 * The memory adapter's surface: the engine-facing {@link WorkflowStore} plus
 * `deploy` — the WRITE side of definitions, which is deliberately NOT part of
 * the store contract (the engine never writes definitions). In a real
 * deployment the app's own deploy layer writes into the same backend the store
 * reads; here `deploy` plays that role for tests.
 */
export interface MemoryWorkflowStore extends WorkflowStore {
  /**
   * Register a definition version and make it the active one (what
   * `getDefinition(name)` without a version returns). Versions are immutable:
   * re-deploying an existing `(name, version)` throws — mirroring the store
   * contract that a handed-out version never changes.
   */
  deploy: (name: string, version: string, code: string, limits?: Partial<ResourceLimits>) => void
}

/**
 * Create a fresh in-memory store. Each call is an isolated backend — hand one to
 * `durableWorkflows({ store })` and seed definitions with `deploy`.
 */
export function memoryStore(): MemoryWorkflowStore {
  const instances = new Map<string, InstanceRecord>()
  const caches = new Map<string, BoundaryCache>()
  // name → version → definition; insertion order makes the LAST deploy active.
  const definitions = new Map<string, Map<string, ResolvedDefinition>>()

  return {
    createInstance: async (record) => {
      if (instances.has(record.instanceId))
        throw new Error(`durable-workflows: instance "${record.instanceId}" already exists`)
      instances.set(record.instanceId, structuredClone(record))
    },
    getInstance: async (instanceId) => {
      const record = instances.get(instanceId)
      return record === undefined ? null : structuredClone(record)
    },
    updateInstance: async (record) => {
      if (!instances.has(record.instanceId))
        throw new Error(`durable-workflows: instance "${record.instanceId}" does not exist`)
      instances.set(record.instanceId, structuredClone(record))
    },
    deleteInstance: async (instanceId) => {
      instances.delete(instanceId)
      caches.delete(instanceId)
    },

    getCache: async (instanceId) => {
      const cache = caches.get(instanceId)
      return cache === undefined ? null : structuredClone(cache)
    },
    putCache: async (instanceId, cache) => {
      caches.set(instanceId, structuredClone(cache))
    },

    getDefinition: async (name, version) => {
      const versions = definitions.get(name)
      if (versions === undefined)
        return null
      if (version === undefined) {
        // Active = the most recently deployed version.
        const latest = [...versions.values()].at(-1)
        return latest === undefined ? null : structuredClone(latest)
      }
      const exact = versions.get(version)
      return exact === undefined ? null : structuredClone(exact)
    },
    deploy: (name, version, code, limits) => {
      let versions = definitions.get(name)
      if (versions === undefined) {
        versions = new Map()
        definitions.set(name, versions)
      }
      if (versions.has(version))
        throw new Error(`durable-workflows: "${name}" @ "${version}" is already deployed (versions are immutable)`)
      versions.set(version, { version, code, ...(limits === undefined ? {} : { limits }) })
    },
  }
}
