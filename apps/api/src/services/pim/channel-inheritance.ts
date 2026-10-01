import type { ChannelStore } from './channel-specs/types.js'
import { readPath } from './sheet-values.js'
import { aspectCanonicalName } from '../ebay-theme-axes.js'

export const CHANNEL_OVERRIDE_COLUMNS: Record<string, string> = {
  title: 'titleOverride', description: 'descriptionOverride',
  price: 'priceOverride', quantity: 'quantityOverride',
}

/** A synced listing column is a snapshot, not an override when Follow Master is enabled. */
export function readStoredChannelValue(store: ChannelStore | undefined, listing: unknown, overrideKeys: string[] = []): unknown {
  if (!listing || typeof listing !== 'object') return undefined
  const row = listing as Record<string, unknown>
  if (store?.kind === 'listingColumn') {
    if (store.followFlag && row[store.followFlag] !== false) return undefined
    const override = CHANNEL_OVERRIDE_COLUMNS[store.column]
    const value = override ? row[override] ?? row[store.column] : row[store.column]
    // Prisma Decimal values reach validation before JSON serialization.
    return value && typeof value === 'object' && typeof (value as { toNumber?: unknown }).toNumber === 'function'
      ? (value as { toNumber(): number }).toNumber() : value
  }
  // Stored-path inspection also captures existing writer/CAS state. Content readers use resolveContent.
  if (store?.kind === 'platformAttributes') {
    const value = readPath(row.platformAttributes, store.path)
    if (value !== undefined) return value
  }
  const bag = row.overrideData
  if (bag && typeof bag === 'object' && !Array.isArray(bag)) {
    for (const key of overrideKeys) if (Object.prototype.hasOwnProperty.call(bag, key)) return (bag as Record<string, unknown>)[key]
  }
  if (store?.kind === 'platformAttributes') for (const path of store.legacyPaths ?? []) {
    const value = readPath(row.platformAttributes, path)
    if (value !== undefined) return value
  }
  // An eBay aspect stored only under another spelling (GENERE for Genere, Brand for Marca) is still this listing's
  // value: the publisher sends it, so the sheet must show it. A write removes the other spelling (applyPlatformMutations).
  if (store?.kind === 'platformAttributes' && store.path.length === 2 && store.path[0] === 'itemSpecifics') {
    const bag = readPath(row.platformAttributes, ['itemSpecifics'])
    if (bag && typeof bag === 'object' && !Array.isArray(bag)) {
      const identity = aspectCanonicalName(store.path[1])
      for (const [key, value] of Object.entries(bag)) if (key !== store.path[1] && aspectCanonicalName(key) === identity) return value
    }
  }
  return undefined
}
