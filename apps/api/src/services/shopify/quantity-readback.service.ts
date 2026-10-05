/**
 * P4.3f — Shopify quantity READ-BACK: the closed loop, on the third channel.
 *
 * Amazon has had one since P0c (`jobs/amazon-qty-readback.job.ts`, daily 04:15)
 * and eBay since P5.2 (`services/ebay-inventory-readback.service.ts`, every 6 h).
 * Shopify had none.
 *
 * 🔴 It is not that Shopify was unverified. `syncShopifyLinkedListing` reads the
 * variant BEFORE the write, sends `changeFromQuantity: observed` as a
 * compare-and-set, reads it back AFTER and throws if the two disagree — a
 * stronger write-time check than either sibling has. **But a read-back that only
 * runs when we push cannot detect drift.** Between two pushes, a shop-side edit,
 * a third-party app or a Shopify order adjustment moves the number and nothing
 * here notices. That is the same lesson P4.2c drew for images, where all three
 * channels had the FUNCTION and only one had the HABIT.
 *
 * What runs here:
 *   1. every live, linked, account-bearing Shopify listing, bounded per run;
 *   2. Shopify's own `available`, through `readShopifyAvailable` — the WRITE
 *      path's identity and location rules, not a second copy of them;
 *   3. the intended quantity from `resolveIntendedQuantity`, the same core the
 *      cascade and the dispatch clamp use;
 *   4. a divergence → `SyncHealthLog` `CHANNEL_QTY_READBACK`, deduped 24 h per
 *      product, exactly as the two siblings do it;
 *   5. a bounded corrective push, re-enqueued as an ordinary queue row that
 *      NAMES its listing (P4.3c), so the dispatch re-read and the routed clamp
 *      apply to it like any other.
 *
 * 🔴 It never compares against an unknown. A listing whose resolution is
 * FBA_EXCLUDED, CLOSED, PAUSED, PINNED or UNCOUNTED is counted as SKIPPED with
 * its reason, and a variant not stocked at the reviewed location is UNREADABLE —
 * "could not read" is not "reads zero", and neither becomes a mismatch.
 *
 * ⚠️ Credentials: this runs on `shopifyAdmin(accountId)`, which uses the CX
 * connection's OAuth token. It is NOT affected by production having no
 * `SHOPIFY_*` variable — that gates only the legacy REST
 * `services/images/shopify-live-images.service.ts` (`hasCreds()`), which is the
 * one thing P5.3 warns about. A shop with no connection simply yields no rows.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { createOutboundRow } from '../outbound-rows.js'
import { loadChannelPolicies, policyFor } from '../sync-control-policy.service.js'
import { ledgerInputs, loadSyncLedgers } from '../stock-pool/sync-ledgers.js'
import { resolveIntendedQuantity } from '../sync-control-core.js'
import { priceDrift, priceDriftMessage } from '../price-readback.service.js'
import { shopifyAdmin } from './admin-client.js'
import { readShopifyAvailable, type LinkedListingRow } from './listing-write.service.js'
import { recordChannelReadback } from '../channel-drift.service.js'
import { reportedSkuOf } from '../listings/reported-sku.js'

export const SHOPIFY_QTY_READBACK = 'shopify-qty-readback'

export interface ShopifyQtyMismatch {
  listingId: string
  productId: string
  sku: string
  accountId: string
  shopifyQty: number
  intendedQty: number
  locationId: string
}

export interface ShopifyPriceMismatch {
  listingId: string
  productId: string
  sku: string
  shopifyPrice: number
  intendedPrice: number
}

export interface ShopifyQtyReadbackResult {
  checked: number
  /** Shopify could not be asked, or the variant is not stocked at the reviewed location. */
  unreadable: number
  /** The resolution is not a number we may push (paused, pinned, FBA, closed, uncounted). */
  skipped: number
  mismatches: ShopifyQtyMismatch[]
  logged: number
  healed: number
  /** P4.4e — the price arm, reported BESIDE the quantity arm and never folded
   *  into it: a clean quantity run with drifted prices is not a clean run. */
  priceMismatches: ShopifyPriceMismatch[]
  priceLogged: number
  /** True when the run was cut short by its own cap — the census is partial, and says so. */
  capped: boolean
}

const intEnv = (name: string, fallback: number): number => {
  const raw = Number(process.env[name])
  return Number.isSafeInteger(raw) && raw > 0 ? raw : fallback
}

/**
 * The per-listing verdict, pure so it can be tested by VALUE.
 *
 * `kind` is the only thing a caller reads: `COMPARE` carries the number to diff
 * against, everything else carries why there is nothing to diff.
 */
export function readbackVerdict(args: {
  shopifyAvailable: number | null
  resolutionKind: string
  resolutionQuantity: number | null | undefined
}): { kind: 'COMPARE' | 'UNREADABLE' | 'SKIPPED'; intended: number | null; reason: string } {
  // Order matters: "we could not read Shopify" is reported as such even when the
  // listing is also paused, because the two need different fixes.
  if (args.shopifyAvailable === null) {
    return { kind: 'UNREADABLE', intended: null, reason: 'Shopify has no available quantity for this variant at the reviewed location.' }
  }
  // Only FOLLOW is a number derived from the pool. A PIN is the operator's number
  // and a read-back must not "correct" the shop back to it behind their back; the
  // rest are states in which we push nothing at all.
  if (args.resolutionKind !== 'FOLLOW') {
    return { kind: 'SKIPPED', intended: null, reason: `The listing resolves to ${args.resolutionKind}, which is not a quantity this loop may push.` }
  }
  if (!Number.isSafeInteger(args.resolutionQuantity)) {
    return { kind: 'SKIPPED', intended: null, reason: 'The intended quantity is not a whole number.' }
  }
  return { kind: 'COMPARE', intended: Number(args.resolutionQuantity), reason: '' }
}

/** One page of candidate listings: live, linked, with an account, newest cursor last. */
async function candidates(take: number, after?: string) {
  return prisma.channelListing.findMany({
    where: {
      channel: 'SHOPIFY',
      channelConnectionId: { not: null },
      listingStatus: 'ACTIVE',
      syncPaused: false,
      product: { deletedAt: null },
    },
    select: {
      id: true, productId: true, marketplace: true, quantity: true, price: true, stockBuffer: true,
      fulfillmentMethod: true, syncPaused: true, offerClosedAt: true, followMasterQuantity: true,
      sourceLocationCodes: true, channelConnectionId: true, platformAttributes: true,
      externalListingId: true, listingStatus: true, syncLocked: true,
      // S7 — the facts the listing's own SKU is read from (`reportedSkuOf`).
      channel: true, aliasKey: true, channelSku: true, liveChannelSku: true, isPublished: true, overrideData: true,
      alias: { select: { sku: true, productId: true } },
      product: { select: { id: true, sku: true } },
    },
    orderBy: { id: 'asc' },
    take,
    ...(after ? { cursor: { id: after }, skip: 1 } : {}),
  })
}

export async function readBackShopifyQuantities(options: { heal?: boolean } = {}): Promise<ShopifyQtyReadbackResult> {
  const result: ShopifyQtyReadbackResult = { checked: 0, unreadable: 0, skipped: 0, mismatches: [], logged: 0, healed: 0, priceMismatches: [], priceLogged: 0, capped: false }
  const maxPerRun = intEnv('NEXUS_SHOPIFY_QTY_READBACK_MAX_PER_RUN', 400)
  const maxHeal = intEnv('NEXUS_SHOPIFY_QTY_READBACK_MAX_HEAL', 25)
  const heal = options.heal ?? process.env.NEXUS_SHOPIFY_QTY_READBACK_HEAL !== '0'
  const policies = await loadChannelPolicies()
  // One client per account, not per listing.
  const clients = new Map<string, Awaited<ReturnType<typeof shopifyAdmin>> | null>()

  let after: string | undefined
  let seen = 0
  do {
    const page = await candidates(Math.min(25, maxPerRun - seen), after)
    if (page.length === 0) break
    seen += page.length

    const ledgers = await loadSyncLedgers(prisma, page.map((l) => l.productId).filter((id): id is string => !!id))

    for (const listing of page) {
      const accountId = listing.channelConnectionId as string
      const productId = listing.productId as string
      // S7 — the SKU Shopify knows this listing by: its own (or its extra listing's own) SKU, else the product SKU, as
      // before. The write path finds a variant without stored ids by this SKU, so the read uses it too.
      const answer = reportedSkuOf(listing, listing.product?.sku ?? '')
      const sku = answer.sku ?? ''
      if (answer.sku === null && listing.product?.sku) {
        result.unreadable++
        logger.warn(`[${SHOPIFY_QTY_READBACK}] listing has no single SKU — not read`, { listingId: listing.id, reason: answer.conflict.sentence })
        continue
      }
      try {
        if (!clients.has(accountId)) {
          clients.set(accountId, await shopifyAdmin(accountId).catch((err) => {
            logger.warn(`[${SHOPIFY_QTY_READBACK}] account unavailable`, { accountId, error: err instanceof Error ? err.message : String(err) })
            return null
          }))
        }
        const client = clients.get(accountId)
        if (!client) { result.unreadable++; continue }

        const row: LinkedListingRow = {
          id: listing.id,
          syncType: 'QUANTITY_UPDATE',
          product: listing.product ? { id: listing.product.id, sku } : null,
          channelListing: listing as never,
        }
        const live = await readShopifyAvailable(client.graphql, row)

        const productLedger = ledgers.get(productId)
        const inputs = ledgerInputs(productLedger, (listing.sourceLocationCodes as string[] | null) ?? [])
        const resolution = resolveIntendedQuantity({
          channel: 'SHOPIFY',
          marketplace: listing.marketplace ?? 'GLOBAL',
          // Shopify carries no FBA offers; the FBA arm belongs to Amazon.
          isFba: false,
          offerClosed: !!listing.offerClosedAt,
          followMasterQuantity: listing.followMasterQuantity ?? true,
          syncPaused: listing.syncPaused ?? false,
          pinnedQuantity: listing.quantity,
          stockBuffer: listing.stockBuffer ?? 0,
          channelPolicy: policyFor(policies, 'SHOPIFY', listing.marketplace ?? 'GLOBAL', listing.channelConnectionId),
          ledger: inputs.ledger,
          sourceLocationCodes: inputs.sourceLocationCodes,
          uncountedIsZero: inputs.uncountedIsZero,
        })

        // ── P4.4e — the PRICE arm, from the SAME response ──────────────────
        // `readShopifyAvailable` ran one query that already selected `price`.
        // No extra call. A PAUSED or PINNED listing is skipped for quantity but
        // its price still matters, so this runs before the quantity verdict.
        const drift = priceDrift({ channelPrice: live.price, intendedPrice: listing.price == null ? null : Number(listing.price) })
        if (drift) {
          result.priceMismatches.push({ listingId: listing.id, productId, sku, shopifyPrice: drift.channelPrice, intendedPrice: drift.intendedPrice })
        }

        const verdict = readbackVerdict({
          shopifyAvailable: live.available,
          resolutionKind: resolution.kind,
          resolutionQuantity: (resolution as { quantity?: number | null }).quantity,
        })
        // A-36 (Step 3.5a) — one ChannelDrift record per listing, before the quantity skips: a paused listing's price
        // still counts. A field is only "compared" when both sides answered (priceDrift's and the verdict's own rules).
        const qtyCompared = verdict.kind !== 'UNREADABLE' && verdict.kind !== 'SKIPPED'
        const priceCompared = live.price != null && Number.isFinite(live.price) && listing.price != null
        const compared = [...(qtyCompared ? ['quantity'] : []), ...(priceCompared ? ['price'] : [])]
        if (compared.length) {
          const intended = (verdict as { intended?: number | null }).intended
          const differing = [
            ...(qtyCompared && live.available !== intended ? [{ field: 'quantity', ours: intended, theirs: live.available }] : []),
            ...(drift ? [{ field: 'price', ours: drift.intendedPrice, theirs: drift.channelPrice }] : []),
          ]
          // Best effort, and never this listing's verdict: a failed drift write must not turn into "unreadable".
          try {
            await recordChannelReadback({ channelListingId: listing.id, channel: 'SHOPIFY', marketplace: listing.marketplace ?? 'GLOBAL',
              source: 'shopify-inventory-level', compared, differing })
          } catch { /* observability best-effort */ }
        }
        if (verdict.kind === 'UNREADABLE') { result.unreadable++; continue }
        if (verdict.kind === 'SKIPPED') { result.skipped++; continue }

        result.checked++
        if (live.available !== verdict.intended) {
          result.mismatches.push({
            listingId: listing.id, productId, sku, accountId,
            shopifyQty: live.available as number, intendedQty: verdict.intended as number,
            locationId: live.locationId,
          })
        }
      } catch (err) {
        // One listing's failure is one listing's failure. It is counted, never
        // swallowed into the checked total, so a run of read failures cannot read
        // as a clean run.
        result.unreadable++
        logger.warn(`[${SHOPIFY_QTY_READBACK}] listing unreadable`, { listingId: listing.id, sku, error: err instanceof Error ? err.message : String(err) })
      }
    }

    after = page.length > 0 ? page[page.length - 1].id : undefined
    if (seen >= maxPerRun) { result.capped = true; break }
  } while (after)

  for (const mismatch of result.mismatches) {
    try {
      const existing = await prisma.syncHealthLog.findFirst({
        where: {
          productId: mismatch.productId,
          channel: 'SHOPIFY',
          conflictType: 'CHANNEL_QTY_READBACK',
          resolutionStatus: 'UNRESOLVED',
          createdAt: { gte: new Date(Date.now() - 24 * 3600e3) },
        },
        select: { id: true },
      })
      if (existing) continue
      const { syncHealthService } = await import('../sync-health.service.js')
      await syncHealthService.logConflict({
        channel: 'SHOPIFY',
        conflictType: 'CHANNEL_QTY_READBACK',
        message: `Shopify shows qty ${mismatch.shopifyQty} but the pool intends ${mismatch.intendedQty} for ${mismatch.sku || mismatch.listingId}`,
        productId: mismatch.productId,
        localData: { intendedQty: mismatch.intendedQty },
        remoteData: { source: 'SHOPIFY_INVENTORY_LEVEL', shopifyQty: mismatch.shopifyQty, locationId: mismatch.locationId, listingId: mismatch.listingId },
      })
      result.logged++
    } catch (err) {
      logger.warn(`[${SHOPIFY_QTY_READBACK}] could not log a mismatch`, { listingId: mismatch.listingId, error: err instanceof Error ? err.message : String(err) })
    }
  }

  // P4.4e — one SyncHealthLog row per drifted price, deduped 24 h per product,
  // exactly as the quantity arm does it. 🔴 Nothing heals: a price correction is
  // a money write made by a machine on a schedule, and the Owner has not ruled
  // on it. The switch is `NEXUS_ENABLE_PRICE_READBACK_HEAL`.
  for (const mismatch of result.priceMismatches) {
    try {
      const existing = await prisma.syncHealthLog.findFirst({
        where: {
          productId: mismatch.productId, channel: 'SHOPIFY', conflictType: 'CHANNEL_PRICE_READBACK',
          resolutionStatus: 'UNRESOLVED', createdAt: { gte: new Date(Date.now() - 24 * 3600e3) },
        },
        select: { id: true },
      })
      if (existing) continue
      const { syncHealthService } = await import('../sync-health.service.js')
      await syncHealthService.logConflict({
        channel: 'SHOPIFY',
        conflictType: 'CHANNEL_PRICE_READBACK',
        message: priceDriftMessage({ channel: 'Shopify', sku: mismatch.sku || mismatch.listingId, drift: { channelPrice: mismatch.shopifyPrice, intendedPrice: mismatch.intendedPrice, difference: mismatch.shopifyPrice - mismatch.intendedPrice } }),
        productId: mismatch.productId,
        localData: { intendedPrice: mismatch.intendedPrice },
        remoteData: { source: 'SHOPIFY_VARIANT', shopifyPrice: mismatch.shopifyPrice, listingId: mismatch.listingId },
      })
      result.priceLogged++
    } catch (err) {
      logger.warn(`[${SHOPIFY_QTY_READBACK}] could not log a price mismatch`, { listingId: mismatch.listingId, error: err instanceof Error ? err.message : String(err) })
    }
  }

  if (heal) {
    for (const mismatch of result.mismatches.slice(0, maxHeal)) {
      try {
        // An ordinary queue row that NAMES its listing (P4.3c), so the dispatch
        // re-read, the routed ceiling and the push lock all apply to the heal
        // exactly as they do to an operator's own change. The read-back never
        // writes to Shopify itself.
        await createOutboundRow(prisma, {
          data: {
            productId: mismatch.productId,
            channelListingId: mismatch.listingId,
            channelConnectionId: mismatch.accountId,
            targetChannel: 'SHOPIFY',
            syncStatus: 'PENDING',
            syncType: 'QUANTITY_UPDATE',
            maxRetries: 3,
            holdUntil: new Date(),
            payload: {
              source: 'SHOPIFY_QTY_READBACK',
              productId: mismatch.productId,
              quantity: mismatch.intendedQty,
              observedOnChannel: mismatch.shopifyQty,
            },
          } as never,
        })
        result.healed++
      } catch (err) {
        logger.warn(`[${SHOPIFY_QTY_READBACK}] heal enqueue failed`, { listingId: mismatch.listingId, error: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  return result
}
