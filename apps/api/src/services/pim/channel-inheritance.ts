import type { ChannelStore } from './channel-specs/types.js'
import { readPath } from './sheet-values.js'

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
    return override ? row[override] ?? row[store.column] : row[store.column]
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
  return undefined
}
