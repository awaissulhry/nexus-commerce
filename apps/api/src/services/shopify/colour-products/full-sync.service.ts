/**
 * Start full sync: the operator's explicit step out of adopt only (`ShopifyColourSync.adoptOnly`, confirm.service.ts) for
 * one family on one Shopify destination. It writes nothing to Shopify itself. In one transaction, under the colour lock:
 * the family leaves adopt only; each size listing the adopt-only link paused (`shopifyColourAdoptPaused`) is resumed — a
 * row the operator paused keeps its pause —; every linked size's stock is queued (`shopifyColourStockPending`), as a full
 * Confirm queues it; and the family's colour sync is due now. From then on the colour sync runs as it always has: it
 * sends stock, creates missing sizes (at zero stock, at the listing's price), orders the sizes, archives a colour Nexus
 * no longer has and writes the colour swatch fields (`custom.variation_value` / `variation_products`).
 *
 * Every gate of the writers stays: Shopify writes on for this server, the store switch on, a linked colour, the lock.
 * The body must say `{ "confirm": true }`: the swatch writer then replaces the store's colour names and colour groups with
 * this family's, so nothing starts it by accident.
 */
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { WorkspaceScopeError } from '../../pim/workspace-destination.js'
import { getShopifyPublishMode } from '../../shopify-publish-gate.service.js'
import { productReadCacheService } from '../../product-read-cache.service.js'
import { contentDestination, object, type ContentScope } from '../content-workspace.service.js'
import { logger } from '../../../utils/logger.js'
import { ADOPT_PAUSED_KEY } from './confirm.service.js'
import { colourProductsView, planFor, rowsWhere, type Destination } from './find.service.js'
import { colourAdoptOnly, commitColourSyncChange, setColourAdoptOnly, withColourSyncLock } from './sync-work.js'

const bodySchema = z.object({ confirm: z.literal(true, { message: 'Review what the full sync turns on, then confirm it. Nothing was changed.' }) }).strict()

export async function startFullColourSync(productId: string, scope: ContentScope, body: unknown) {
  bodySchema.parse(body ?? {})
  if (getShopifyPublishMode() !== 'live') throw new WorkspaceScopeError('Shopify writes are switched off on this server. Nothing was changed.', 409)
  const destination = await contentDestination(productId, scope)
  return withColourSyncLock(destination, () => startDestination(destination))
}

async function startDestination(d: Destination) {
  const { rows, settings, plan } = await planFor(d)
  if (!settings.enabled) throw new WorkspaceScopeError('Switch on colour products for this Shopify store first. Nothing was changed.', 409)
  const linked = rows.filter(r => r.state === 'LINKED' && r.shopifyProductId)
  if (!linked.length) throw new WorkspaceScopeError('No colour of this family is linked to a Shopify product yet. Confirm a colour first. Nothing was changed.', 409)
  // Already in full sync: nothing to start (a double click, or another tab).
  if (!await colourAdoptOnly(d)) return { ...await colourProductsView(d, plan, settings), started: { resumed: 0, stockQueued: 0, alreadyRunning: true } }
  const started = await commitColourSyncChange(async tx => {
    if (!await colourAdoptOnly(d, tx)) return { resumed: 0, stockQueued: 0, alreadyRunning: true }
    const listings = await tx.channelListing.findMany({ where: { channel: 'SHOPIFY', marketplace: d.marketplace, channelConnectionId: d.accountId, aliasKey: d.aliasKey ?? '',
      OR: linked.map(r => ({ platformAttributes: { path: ['shopifyColourProductId'], equals: r.id } })) } })
    let resumed = 0, stockQueued = 0
    for (const listing of listings) {
      const pa = { ...object(listing.platformAttributes) }
      const resume = pa[ADOPT_PAUSED_KEY] === true
      delete pa[ADOPT_PAUSED_KEY]
      // As a full Confirm does: a linked size's stock is sent once the sync runs (a size still unlinked has no variant).
      if (pa.variantId) { pa.shopifyColourStockPending = true; stockQueued++ }
      if (resume && listing.syncPaused) resumed++
      await tx.channelListing.update({ where: { id: listing.id }, data: { platformAttributes: pa as Prisma.InputJsonValue, ...(resume ? { syncPaused: false } : {}), version: { increment: 1 } } })
    }
    await setColourAdoptOnly(tx, d, false)
    // Due now: the colour worker picks the family up on its next poll.
    await tx.shopifyColourSync.updateMany({ where: { familyId: d.familyId, channelConnectionId: d.accountId, marketplace: d.marketplace, aliasKey: d.aliasKey ?? '' }, data: { dueAt: new Date(), revision: { increment: 1 } } })
    // "Linked ✓" is the link writer's, after its read-back: none yet.
    await tx.shopifyColourProduct.updateMany({ where: { ...rowsWhere(d), linkVerifiedAt: { not: null } }, data: { linkVerifiedAt: null } })
    return { resumed, stockQueued, alreadyRunning: false }
  })
  await productReadCacheService.refreshMany([d.familyId]).catch(err => logger.warn('[shopify-colour-full-sync] product read cache refresh failed', { familyId: d.familyId, error: err instanceof Error ? err.message : String(err) }))
  return { ...await colourProductsView(d, plan, settings), started }
}
