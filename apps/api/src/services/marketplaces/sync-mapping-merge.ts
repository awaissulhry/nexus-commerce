/**
 * FM.7 — make outbound sync payloads consult the catalog mapping.
 *
 * Per-channel flag (env FM_SYNC_<CHANNEL>): off (default) | shadow | merge.
 *   off    — legacy payload untouched. Zero overhead (no preview call), so
 *            every existing sync stays byte-identical.
 *   shadow — compute the mapping payload, LOG the new-vs-legacy diff, but
 *            SERVE the legacy payload (one-deploy validation before flip).
 *   merge  — serve the legacy payload with the mapping's resolved values
 *            merged OVER it (mapping wins where a catalog rule exists;
 *            legacy fills the rest). Well-known channel fields map to the
 *            top-level payload keys; everything else lands in `attributes`.
 *
 * The off→shadow→merge flip per channel is the gated FM.7 production-
 * behaviour change. Default off means turning it on is an explicit op.
 */

import { previewPayload } from '../pim/payload-preview.js'
import { logger } from '../../utils/logger.js'

export type SyncMappingMode = 'off' | 'shadow' | 'merge'

/** Read the per-channel FM.7 mode from env. Default 'off'. */
export function getSyncMappingMode(channel: string): SyncMappingMode {
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
 * off → returns the legacy payload untouched (no preview call). Never
 * throws — a preview failure logs + serves legacy.
 */
export async function applyMappingToSyncPayload<T extends BasePayload>(args: {
  productId: string
  channel: string
  marketplace: string
  legacyPayload: T
}): Promise<T> {
  const mode = getSyncMappingMode(args.channel)
  if (mode === 'off') return args.legacyPayload
  if (!args.marketplace) return args.legacyPayload

  let mapped: Record<string, unknown>
  try {
    const preview = await previewPayload({
      productId: args.productId,
      channel: args.channel,
      marketplace: args.marketplace,
    })
    mapped = preview.payload
  } catch (err) {
    logger.warn('[fm-sync] mapping preview failed — serving legacy payload', {
      channel: args.channel,
      marketplace: args.marketplace,
      productId: args.productId,
      err: err instanceof Error ? err.message : String(err),
    })
    return args.legacyPayload
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
