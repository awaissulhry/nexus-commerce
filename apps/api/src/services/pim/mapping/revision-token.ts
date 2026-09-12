import { createHash } from 'node:crypto'

/** JSONB object order is not significant; arrays (including transform order) are significant. */
export function mappingToken(value: unknown): string {
  const canonical = (v: unknown): unknown => v instanceof Date ? v.toISOString() : Array.isArray(v) ? v.map(canonical)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

export class MappingConflict extends Error {
  statusCode = 409
  constructor(message = 'This mapping changed after you opened it. Reload its current rules and review the impact again before saving.') { super(message) }
}
