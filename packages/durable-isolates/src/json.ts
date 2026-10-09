/**
 * JSON-only values at every durable boundary.
 *
 * Everything that enters the cache — a durable call's args, a global's return
 * value or thrown value, a committed checkpoint value — must be plain JSON:
 * `null`, booleans, finite numbers, strings, arrays and plain objects. The
 * cache is persisted and replayed as JSON, so a value JSON cannot carry (a
 * `Date`, a `Map`, bytes, a bigint, `NaN`, a class instance, a cycle) would be
 * seen one way on the first run and another way on replay. The kernel refuses
 * such a value instead of storing an approximation.
 *
 * `undefined` follows JSON's own rules so the first run sees exactly what a
 * replay sees: dropped inside an object, `null` inside an array, and a bare
 * `undefined` stays `undefined` (recorded as an absent value). `-0` becomes
 * `0` for the same reason.
 *
 * Values from the sandbox are untrusted, so the walk is also a guard: a sparse
 * array is refused up front (its `length` can be 2^32-1 while it serializes to
 * a few bytes — iterating it would stall the host), an own `__proto__` key is
 * copied as data rather than re-pointing the copy's prototype, and a getter or
 * Proxy trap that throws, or nesting deep enough to overflow the stack, is
 * reported as a non-JSON value instead of escaping as a plain error.
 */

/**
 * Thrown by {@link toJson} for a value JSON cannot represent. `path` locates it
 * (`$`, `$.items[2].at`, `$[0]`), `found` names what was there (`Date`, `Map`,
 * `Uint8Array`, `bigint`, `NaN`, `function`, `circular reference`,
 * `sparse array`, …).
 */
export class NonJsonValueError extends Error {
  readonly path: string
  readonly found: string

  constructor(path: string, found: string) {
    super(`non-JSON value: ${found} at ${path}`)
    this.name = 'NonJsonValueError'
    this.path = path
    this.found = found
  }
}

/**
 * Check that `value` is plain JSON and return its JSON-normalized copy — the
 * value exactly as it reads back after a `JSON.stringify`/`JSON.parse` round
 * trip (`undefined` dropped in objects, `null` in arrays, a bare `undefined`
 * returned as is, `-0` as `0`). Throws {@link NonJsonValueError} with the
 * offending path for anything JSON cannot carry. Shared references are fine;
 * cycles are not. There is no depth limit: a value too deep to walk is
 * reported as non-JSON rather than crashing.
 * @param value the value to admit into a durable boundary
 */
export function toJson(value: unknown): unknown {
  const trail: (string | number)[] = []
  try {
    return walk(value, trail, new Set())
  } catch (e) {
    if (e instanceof NonJsonValueError)
      throw e
    // The trail still holds the segments down to the node that threw.
    const tooDeep = e instanceof RangeError && /call stack/i.test(e.message)
    throw new NonJsonValueError(pathOf(trail), tooDeep ? 'nesting too deep to walk' : 'unreadable value')
  }
}

// The path is only ever needed for the error, so the walk keeps a cheap trail
// of segments and renders it on failure.
function pathOf(trail: readonly (string | number)[]): string {
  let path = '$'
  for (const segment of trail) {
    path += typeof segment === 'number'
      ? `[${segment}]`
      : /^[A-Z_$][\w$]*$/i.test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`
  }
  return path
}

function walk(value: unknown, trail: (string | number)[], ancestors: Set<object>): unknown {
  if (value === undefined || value === null || typeof value === 'boolean' || typeof value === 'string')
    return value
  if (typeof value === 'number') {
    if (Number.isFinite(value))
      return value === 0 ? 0 : value // -0 → 0, as JSON does
    throw new NonJsonValueError(pathOf(trail), Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity')
  }
  if (typeof value !== 'object')
    throw new NonJsonValueError(pathOf(trail), typeof value) // bigint, symbol, function

  if (ancestors.has(value))
    throw new NonJsonValueError(pathOf(trail), 'circular reference')

  if (Array.isArray(value)) {
    // Holes would copy as holes (not `null`), and a sparse `length` is unbounded
    // while the serialized form is tiny — refuse before touching the indices.
    if (Object.keys(value).length !== value.length)
      throw new NonJsonValueError(pathOf(trail), 'sparse array')
    ancestors.add(value)
    const out: unknown[] = []
    for (let i = 0; i < value.length; i++) {
      trail.push(i)
      const normalized = walk(value[i], trail, ancestors)
      trail.pop()
      out.push(normalized === undefined ? null : normalized)
    }
    ancestors.delete(value)
    return out
  }

  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    // Date, Map, Set, RegExp, typed arrays, Error, class instances, …
    const ctor = (proto as { constructor?: { name?: unknown } }).constructor?.name
    throw new NonJsonValueError(pathOf(trail), typeof ctor === 'string' && ctor !== '' ? ctor : 'object')
  }

  ancestors.add(value)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    trail.push(key)
    const normalized = walk((value as Record<string, unknown>)[key], trail, ancestors)
    trail.pop()
    if (normalized === undefined)
      continue
    // Plain assignment of `__proto__` would hit the setter and re-point the
    // copy's prototype (and drop the key); JSON.parse keeps it as an own key.
    if (key === '__proto__')
      Object.defineProperty(out, key, { value: normalized, enumerable: true, writable: true, configurable: true })
    else
      out[key] = normalized
  }
  ancestors.delete(value)
  return out
}
