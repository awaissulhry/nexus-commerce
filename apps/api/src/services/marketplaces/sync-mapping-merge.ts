/** Canonical mapping values shape Amazon/eBay payloads. Unavailable resolution
 * blocks the operation instead of silently serving stale legacy values. */
import { resolveBatch } from '../pim/mapping/resolve-batch.service.js'
import { logger } from '../../utils/logger.js'

export type SyncMappingMode = 'off' | 'shadow' | 'merge'

/** Read the per-channel FM.7 mode from env. Default 'off'. */
export function getSyncMappingMode(channel: string): SyncMappingMode {
  if (['AMAZON', 'EBAY'].includes(channel.toUpperCase())) return 'merge'
  const raw = (process.env[`FM_SYNC_${channel.toUpperCase()}`] ?? 'off').toLowerCase()
  return raw === 'merge' ? 'merge' : raw === 'shadow' ? 'shadow' : 'off'
}

// Channel field key → top-level sync payload key. Everything else merges
// into payload.attributes (where channel-native fields belong).
const TOP_LEVEL: Record<string, 'title' | 'description' | 'price' | 'quantity'> = {
  item_name: 'title',
  title: 'title',
  product_description: 'description',
  description: 'description',
  our_price: 'price',
  price: 'price',
  quantity: 'quantity',
}

interface BasePayload {
  attributes?: Record<string, unknown>
}

/**
 * Merge the mapping's resolved channel-field values into a legacy sync
 * payload. Pure. Returns the merged payload + the list of keys that
 * actually changed (for shadow logging).
 */
export function mergeMappingIntoPayload<T extends BasePayload>(
  legacy: T,
  mapped: Record<string, unknown>,
): { merged: T; changedKeys: string[] } {
  const merged = { ...legacy, attributes: { ...(legacy.attributes ?? {}) } } as T
  const attrs = merged.attributes as Record<string, unknown>
  const changedKeys: string[] = []
  for (const [fieldKey, value] of Object.entries(mapped)) {
    if (value === undefined) continue
    const top = TOP_LEVEL[fieldKey]
    if (top) {
      if ((merged as Record<string, unknown>)[top] !== value) {
        ;(merged as Record<string, unknown>)[top] = value
        changedKeys.push(top)
      }
    } else if (attrs[fieldKey] !== value) {
      attrs[fieldKey] = value
      changedKeys.push(`attributes.${fieldKey}`)
    }
  }
  return { merged, changedKeys }
}

/**
 * Apply the FM.7 mapping to a legacy sync payload per the per-channel mode.
 * Amazon/eBay always use canonical resolution. Other channel adapters retain their rollout mode.
 */
export async function applyMappingToSyncPayload<T extends BasePayload>(args: {
  productId: string
  channel: string
  marketplace: string
  legacyPayload: T
  channelConnectionId?: string | null
  aliasKey?: string
}): Promise<T> {
  const mode = getSyncMappingMode(args.channel)
  if (mode === 'off') return args.legacyPayload
  if (!args.marketplace) throw new Error('Choose a marketplace before generating a channel payload.')

  const resolved = await resolveBatch({ productIds: [args.productId], channel: args.channel, marketplace: args.marketplace,
    channelConnectionId: args.channelConnectionId, aliasKey: args.aliasKey })
  const product = resolved.products[0]
  if (!product || !resolved.catalogue?.schema.present) throw new Error('The product or category schema is unavailable. Sync was not queued.')
  const mapped: Record<string, unknown> = {}
  for (const field of resolved.catalogue.fields) {
    // Prices, buffers, stock and media remain with their owning pipelines.
    if (field.sourceOwner) continue
    const cell = product.cells[field.fieldKey]
    if (!cell || cell.errors.length || cell.needsTranslation) throw new Error(`Mapping validation failed for ${field.label}: ${cell?.errors.join('; ') || 'Translation or resolution is pending'}`)
    if (cell.status === 'mapped' || cell.provenance === 'override') mapped[field.fieldKey] = cell.value
  }

  const { merged, changedKeys } = mergeMappingIntoPayload(args.legacyPayload, mapped)

  if (mode === 'shadow') {
    logger.info('[fm-sync-shadow] mapping vs legacy payload diff', {
      channel: args.channel,
      marketplace: args.marketplace,
      productId: args.productId,
      changedKeys,
      changedCount: changedKeys.length,
    })
    return args.legacyPayload // shadow: serve legacy, just log the diff
  }

  // merge mode — serve the mapping-merged payload.
  if (changedKeys.length > 0) {
    logger.info('[fm-sync-merge] mapping merged over legacy payload', {
      channel: args.channel,
      marketplace: args.marketplace,
      productId: args.productId,
      changedKeys,
    })
  }
  return merged
}
