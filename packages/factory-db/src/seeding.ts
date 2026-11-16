import { createHash } from 'node:crypto'
import type { FactoryDatabase } from './client'

/**
 * Support for the synthetic seeds in seed/<module>.ts (one file per module, run in name order, `_core` first). Seeds
 * hold made-up data only, never a real company, person or tax number. They write through the scoped client, as the
 * app does, and are idempotent: ids come from the namespace, and rows are upserted.
 */

export interface SeedContext {
  readonly db: FactoryDatabase
  /** Everything a seed makes derives from it: run twice with two namespaces, a seed makes two separate tenants. */
  readonly namespace: string
}

/** A stable UUID for one seeded row (version 8, "custom": derived from the namespace and a key, not time-ordered). */
export function seedUuid(namespace: string, key: string): string {
  const hex = createHash('sha256').update(`factory-seed\u0000${namespace}\u0000${key}`).digest('hex')
  const variant = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/**
 * B-W2b-GS1: the seed runs again on a database the app has already used. Where the app itself can make the row a seed
 * makes (the same natural key: a system role's key, a standard or starter list's code, a record's search entry, an owner's
 * calendar, a SKU's finished item), it may have made it first, with an id of its own. For each seed row whose key another
 * row holds already, this gives seed id → that row's id: the seed writes no such row and leaves it as it is (it is the
 * tenant's), and every seeded reference uses its id. The other rows are the seed's own, written as before.
 */
export function takenBy<R extends { readonly id: string }, E extends { readonly id: string }>(rows: readonly R[], existing: readonly E[], keyOf: (row: R | E) => string): Map<string, string> {
  const held = new Map(existing.map((row) => [keyOf(row), row.id]))
  const taken = new Map<string, string>()
  for (const row of rows) {
    const other = held.get(keyOf(row))
    if (other !== undefined && other !== row.id) taken.set(row.id, other)
  }
  return taken
}
