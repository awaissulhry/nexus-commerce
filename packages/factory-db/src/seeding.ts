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
