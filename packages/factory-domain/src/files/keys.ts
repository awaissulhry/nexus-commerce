/**
 * The storage key rule of files on R2 (plan A1 §3.6), pure: how the key of a new file is made, and whether a key is one
 * that rule could have made. Moved here from apps/factory-api's platform/files/rules.ts (B-W2b-F59) so that the seeds
 * (packages/factory-db) make their files' keys with the same rule as an upload, never with a copy of it; rules.ts
 * re-exports it unchanged.
 */

/**
 * The storage key of a new file (A1 §3.6): `t/<tenantId>/c/<companyId>/<yyyy>/<random>` (`t/<tenantId>/tenant/…`
 * without a company), under `legal/` for the fiscal archive (the locked bucket). `random` is a UUIDv4 (122 random bits),
 * never the file's id: nothing about a key can be guessed from what a caller knows.
 */
export function storageKeyFor(input: { tenantId: string; companyId: string | null; kind: string; now: Date; random: string }): string {
  const owner = input.companyId ? `c/${input.companyId}` : 'tenant'
  const key = `t/${input.tenantId}/${owner}/${input.now.getUTCFullYear()}/${input.random}`
  return input.kind === 'FISCAL_ARCHIVE' ? `legal/${key}` : key
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const KEY = new RegExp(`^(?:legal/)?t/${UUID}/(?:c/${UUID}|tenant)/\\d{4}/${UUID}$`)

/** A key storageKeyFor could have made (the stores refuse any other: no `..`, no stray prefix). */
export const isStorageKey = (key: string): boolean => KEY.test(key)
/** The key belongs to the locked legal store. */
export const isLegalKey = (key: string): boolean => key.startsWith('legal/')
