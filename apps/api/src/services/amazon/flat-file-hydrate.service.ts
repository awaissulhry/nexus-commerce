/**
 * F.3 — hydrate Amazon ChannelListing.platformAttributes from the live listing
 * (getListingsItem) so the flat-file editor shows the real attributes
 * (fabric_type, country_of_origin, bullet_point, …) for listings that were never
 * pulled (≈half the catalog showed blank required fields).
 *
 * ATTRIBUTES-ONLY: stores only platformAttributes.attributes. It NEVER touches
 * quantity / followMaster* / price — inventory stays owned by the warehouse
 * cascade (the split-inventory work) and the repricer keeps owning price. This is
 * deliberately NOT flat-file-pull.service (which sets quantity + followMasterQuantity
 * = false and would detach FBM listings from the cascade). Read-from-Amazon only;
 * nothing is pushed, so there is no FBA→FBM flip risk.
 */
import prisma from '../../db.js'
import { AmazonService } from '../marketplaces/amazon.service.js'
import { logger } from '../../utils/logger.js'

const MARKETPLACE_ID_MAP: Record<string, string> = {
  IT: 'APJ6JRA9NG5V4', DE: 'A1PA6795UKMFR9', FR: 'A13V1IB3VIYZZH', ES: 'A1RKKUPIHCS9HS', UK: 'A1F83G8C2ARO7P',
}
// Display-critical keys; a listing missing any of these would render blank cells.
const KEY_ATTRS = ['bullet_point', 'fabric_type', 'country_of_origin']

function isSparse(pa: unknown): boolean {
  const root = (pa ?? {}) as Record<string, any>
  const attrs = (root.attributes ?? root) as Record<string, any>
  return KEY_ATTRS.filter((k) => attrs && attrs[k] !== undefined).length < KEY_ATTRS.length
}

export type HydrateResult = { scanned: number; hydrated: number; skipped: number; errors: number }

export async function hydrateAmazonAttributes(
  opts: { onlySparse?: boolean; limit?: number } = {},
): Promise<HydrateResult> {
  const onlySparse = opts.onlySparse ?? true
  const all = await prisma.channelListing.findMany({
    where: { channel: 'AMAZON', externalListingId: { not: null } },
    select: { id: true, marketplace: true, platformAttributes: true, product: { select: { sku: true } } },
    take: 5000,
  })
  let targets = onlySparse ? all.filter((l) => isSparse(l.platformAttributes)) : all
  if (opts.limit != null) targets = targets.slice(0, opts.limit)

  const amazon = new AmazonService()
  let hydrated = 0, skipped = 0, errors = 0
  for (const l of targets) {
    const mpId = MARKETPLACE_ID_MAP[l.marketplace] ?? MARKETPLACE_ID_MAP.IT
    try {
      const pulled = await amazon.fetchListingForFlatFile(l.product.sku, mpId)
      const attrs = pulled?.attributes
      if (!attrs || Object.keys(attrs).length === 0) { skipped++; continue }
      const existing = (l.platformAttributes ?? {}) as Record<string, any>
      await prisma.channelListing.update({
        where: { id: l.id },
        data: {
          // ATTRIBUTES-ONLY: replace the attribute set, preserve any other
          // platformAttributes keys, and never touch quantity/price/followMaster*.
          platformAttributes: { ...existing, attributes: attrs },
          lastSyncedAt: new Date(),
        },
      })
      hydrated++
    } catch (e) {
      errors++
      logger.warn('[hydrate-attrs] pull failed', {
        sku: l.product.sku, mp: l.marketplace,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }
  logger.info('[hydrate-attrs] done', { scanned: targets.length, hydrated, skipped, errors, onlySparse })
  return { scanned: targets.length, hydrated, skipped, errors }
}
