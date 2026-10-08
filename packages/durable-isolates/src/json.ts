/**
 * Values cross a durable boundary as JSON.
 *
 * Everything that enters the cache — a durable call's args, a global's return
 * value or thrown value, a committed checkpoint value — is written with
 * `JSON.stringify` and read back with `JSON.parse` before anyone sees it,
 * already on the first run. So a `Date` becomes its ISO string, a `Map`
 * becomes `{}`, `NaN` becomes `null`, a class instance flattens to its fields
 * (its `toJSON` honoured), `undefined` is dropped in objects and becomes
 * `null` in arrays, `-0` becomes `0`, functions vanish — exactly as JSON would
 * do it, and identically on every replay. The kernel does not guard against a
 * lossy reading (a `Response` becomes `{}`): converting is the global's job.
 * What JSON cannot write at all — a `bigint`, a circular structure, a `toJSON`
 * or getter that throws — rejects the run.
 *
 * Sandbox values are stringified IN THE SANDBOX by the shim (on the program's
 * real object) and cross as text; host values are stringified on the host.
 */

/**
 * Deterministic JSON text of a JSON value (one that came out of `JSON.parse`):
 * object keys sorted recursively, so two values that differ only in key order
 * compare equal. Used to compare a replayed call's args with the recorded ones.
 * Built on the native serializer with a sorting replacer (an own `__proto__`
 * key is carried as data, never through the setter).
 * @param value a JSON value
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item))
      return item
    const record = item as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      if (key === '__proto__')
        Object.defineProperty(sorted, key, { value: record[key], enumerable: true, writable: true, configurable: true })
      else
        sorted[key] = record[key]
    }
    return sorted
  })
}
