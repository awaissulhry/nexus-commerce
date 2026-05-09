/**
 * W5.49 — listing recovery orchestrator.
 *
 * Operator-facing recovery flow for stuck or broken listings. Five
 * scenarios, each preserving / resetting different identity:
 *
 *   REPUBLISH_IN_PLACE  — PATCH the listing with same data; no delete,
 *                         no identifier change. Clears transient
 *                         errors. Fastest, safest, most-common case.
 *   DELETE_RELIST_SAME  — delete + recreate with same ASIN + same SKU.
 *                         Reviews stay on ASIN. Risks Amazon's ~30-day
 *                         SKU-cooldown if Amazon refuses re-creation.
 *   SAME_ASIN_NEW_SKU   — keeps reviews (ASIN unchanged), bypasses SKU
 *                         cooldown via new internal SKU. The cleanest
 *                         "rename SKU without losing rating" path.
 *   NEW_ASIN_SAME_SKU   — fresh ASIN; loses old reviews. Same SKU may
 *                         hit cooldown.
 *   FULL_RESET          — new ASIN + new SKU. Reviews lost, no cooldown.
 *
 * MVP architecture: the service handles preview + the destructive
 * delete + SKU rename, then hands off to the existing list-wizard for
 * the recreate step. The wizard already knows how to compose Amazon
 * payloads from Product + ChannelListing fields; rebuilding that
 * inside this service would duplicate ~1000 lines of payload
 * composition. Audit row tracks the full lifecycle including the
 * post-handoff wizard completion (set via PATCH after the wizard
 * publishes).
 *
 * Channel sensitivity:
 *   - AMAZON: SP-API delete + put. Real cooldown risk.
 *   - EBAY: trading API EndItem + AddFixedPriceItem (W5.49b — stubbed
 *           today; service throws with clear "not yet" message).
 *   - SHOPIFY/WOOCOMMERCE/ETSY: app-tied review systems lose data on
 *     product delete. Service rejects destructive actions; only
 *     REPUBLISH_IN_PLACE is allowed (handed off to wizard).
 */

import { prisma } from '@nexus/database'
import { amazonSpApiClient } from '../../clients/amazon-sp-api.client.js'
import { logger } from '../../utils/logger.js'

export type RecoveryAction =
  | 'REPUBLISH_IN_PLACE'
  | 'DELETE_RELIST_SAME'
  | 'SAME_ASIN_NEW_SKU'
  | 'NEW_ASIN_SAME_SKU'
  | 'FULL_RESET'

export interface RecoveryRequest {
  productId: string
  channel: string
  marketplace: string
  action: RecoveryAction
  /** Required for SAME_ASIN_NEW_SKU + FULL_RESET. New SKU the operator
   *  wants on the recreated listing. Must be unique across Product.sku. */
  newSku?: string
  /** Operator user ID for the audit trail. */
  initiatedBy?: string
}

export interface RecoveryPreview {
  action: RecoveryAction
  channel: string
  marketplace: string
  consequences: {
    reviewsPreserved: boolean
    asinPreserved: boolean
    skuPreserved: boolean
    skuCooldownRisk: boolean
    blockers: string[]
    warnings: string[]
  }
  before: { asin: string | null; sku: string }
  after: { asin: string | null; sku: string }
  estimatedDurationSeconds: number
}

const SHOPIFY_LIKE = new Set(['SHOPIFY', 'WOOCOMMERCE', 'ETSY'])

/**
 * Pure preview — no side effects. Computes what the action will
 * preserve / lose and surfaces channel-specific blockers. UI calls
 * this on every action-card hover so the operator sees the
 * consequence before clicking.
 */
export async function previewRecovery(
  req: RecoveryRequest,
): Promise<RecoveryPreview> {
  const product = await prisma.product.findUnique({
    where: { id: req.productId },
    select: { sku: true },
  })
  if (!product) throw new Error(`Product ${req.productId} not found`)

  const listing = await prisma.channelListing.findFirst({
    where: {
      productId: req.productId,
      channel: req.channel,
      marketplace: req.marketplace,
    },
    select: { externalListingId: true, listingStatus: true },
  })

  const oldAsin = listing?.externalListingId ?? null
  const oldSku = product.sku

  const consequences: RecoveryPreview['consequences'] = {
    reviewsPreserved: false,
    asinPreserved: false,
    skuPreserved: false,
    skuCooldownRisk: false,
    blockers: [],
    warnings: [],
  }

  // Channel-level blockers first.
  if (SHOPIFY_LIKE.has(req.channel) && req.action !== 'REPUBLISH_IN_PLACE') {
    consequences.blockers.push(
      `${req.channel} loses app-tied reviews on product delete; only REPUBLISH_IN_PLACE allowed.`,
    )
  }
  if (
    req.channel === 'AMAZON' &&
    !oldAsin &&
    req.action !== 'REPUBLISH_IN_PLACE'
  ) {
    consequences.blockers.push(
      'No ASIN on this Amazon listing yet — nothing to delete. Publish via the wizard instead.',
    )
  }
  if (
    (req.action === 'SAME_ASIN_NEW_SKU' || req.action === 'FULL_RESET') &&
    !req.newSku?.trim()
  ) {
    consequences.blockers.push(
      'newSku required for SAME_ASIN_NEW_SKU + FULL_RESET actions.',
    )
  }
  if (req.newSku && req.newSku.trim() === oldSku) {
    consequences.blockers.push(
      `newSku "${req.newSku}" matches the current SKU. Pick the appropriate "same SKU" action instead.`,
    )
  }

  // Per-action consequence shape.
  switch (req.action) {
    case 'REPUBLISH_IN_PLACE':
      consequences.reviewsPreserved = true
      consequences.asinPreserved = true
      consequences.skuPreserved = true
      break
    case 'DELETE_RELIST_SAME':
      consequences.reviewsPreserved = req.channel === 'AMAZON'
      consequences.asinPreserved = true
      consequences.skuPreserved = true
      consequences.skuCooldownRisk = req.channel === 'AMAZON'
      if (req.channel === 'AMAZON') {
        consequences.warnings.push(
          'Amazon may hold the SKU in a ~30-day cooldown after delete. Recreate may fail; consider SAME_ASIN_NEW_SKU.',
        )
      }
      break
    case 'SAME_ASIN_NEW_SKU':
      consequences.reviewsPreserved = req.channel === 'AMAZON'
      consequences.asinPreserved = true
      consequences.skuPreserved = false
      consequences.warnings.push(
        'Old SKU is soft-deleted on Amazon and a new SKU is attached to the same ASIN. Reviews stay on the ASIN.',
      )
      break
    case 'NEW_ASIN_SAME_SKU':
      consequences.reviewsPreserved = false
      consequences.asinPreserved = false
      consequences.skuPreserved = true
      consequences.skuCooldownRisk = req.channel === 'AMAZON'
      consequences.warnings.push(
        'Old reviews are lost (Amazon reviews are ASIN-bound). New ASIN assigned by Amazon at create-time.',
      )
      break
    case 'FULL_RESET':
      consequences.reviewsPreserved = false
      consequences.asinPreserved = false
      consequences.skuPreserved = false
      consequences.warnings.push(
        'Full reset — both ASIN and SKU change. Use only when accounting / catalog hygiene requires a clean break.',
      )
      break
  }

  return {
    action: req.action,
    channel: req.channel,
    marketplace: req.marketplace,
    consequences,
    before: { asin: oldAsin, sku: oldSku },
    after: {
      asin: consequences.asinPreserved ? oldAsin : null,
      sku: consequences.skuPreserved ? oldSku : (req.newSku?.trim() ?? oldSku),
    },
    estimatedDurationSeconds:
      req.action === 'REPUBLISH_IN_PLACE'
        ? 5
        : req.action === 'DELETE_RELIST_SAME' || req.action === 'SAME_ASIN_NEW_SKU'
          ? 60
          : 90,
  }
}

/**
 * Execute the destructive part of the recovery: delete the existing
 * listing on the channel + rename the Product.sku if the action calls
 * for it. After this returns SUCCEEDED, the UI redirects the operator
 * to the list-wizard pre-populated with the right channel /
 * marketplace / target-ASIN-or-create. The recreate completes through
 * the existing publish flow.
 *
 * The audit row's status moves PENDING → IN_FLIGHT → SUCCEEDED|FAILED
 * across this call. After the wizard recreate completes, the route
 * caller PATCHes the audit row with the new ASIN + completedSteps
 * extension to capture the full lifecycle.
 *
 * REPUBLISH_IN_PLACE is a no-destructive-action path; the service
 * just records the intent + returns immediately so the UI can bounce
 * the operator to the wizard's republish flow.
 */
export async function executeRecovery(req: RecoveryRequest): Promise<{
  eventId: string
  status: 'SUCCEEDED' | 'FAILED'
  completedSteps: string[]
  /** When set, the UI should redirect here for the recreate step.
   *  Includes ?recoveryEventId so the wizard can link its publish back
   *  to this audit row. */
  wizardUrl?: string
  error?: string
}> {
  const preview = await previewRecovery(req)
  if (preview.consequences.blockers.length > 0) {
    throw new Error(
      `Cannot execute: ${preview.consequences.blockers.join('; ')}`,
    )
  }

  const event = await prisma.listingRecoveryEvent.create({
    data: {
      productId: req.productId,
      channel: req.channel,
      marketplace: req.marketplace,
      action: req.action,
      oldAsin: preview.before.asin,
      oldSku: preview.before.sku,
      newSku:
        preview.after.sku !== preview.before.sku ? preview.after.sku : null,
      status: 'IN_FLIGHT',
      initiatedBy: req.initiatedBy ?? null,
    },
  })

  const startedAt = Date.now()
  const steps: string[] = []
  const submissionIds: string[] = []

  const pushStep = async (step: string) => {
    steps.push(step)
    await prisma.listingRecoveryEvent.update({
      where: { id: event.id },
      data: { completedSteps: steps },
    })
  }

  try {
    // ── Step 1: republish-in-place short-circuits. No delete, no
    // rename. UI redirects to wizard's republish path which re-uses
    // the existing payload composition.
    if (req.action === 'REPUBLISH_IN_PLACE') {
      await pushStep('handed_off_to_wizard_republish')
      const durationMs = Date.now() - startedAt
      await prisma.listingRecoveryEvent.update({
        where: { id: event.id },
        data: {
          status: 'SUCCEEDED',
          completedSteps: steps,
          completedAt: new Date(),
          durationMs,
        },
      })
      return {
        eventId: event.id,
        status: 'SUCCEEDED',
        completedSteps: steps,
        wizardUrl: `/products/${req.productId}/list-wizard?channel=${req.channel}&marketplace=${req.marketplace}&recoveryEventId=${event.id}&mode=republish`,
      }
    }

    // ── Step 2: channel-specific delete.
    if (req.channel === 'AMAZON') {
      await pushStep('deleting_old_listing')
      // Mirror outbound-sync.service.ts: SP-API merchant id comes from
      // env, not a per-row column. Falls back across the two legacy
      // names.
      const sellerId =
        process.env.AMAZON_SELLER_ID ??
        process.env.AMAZON_MERCHANT_ID ??
        ''
      if (!sellerId) {
        throw new Error(
          'AMAZON_SELLER_ID / AMAZON_MERCHANT_ID is not set — cannot call SP-API.',
        )
      }
      const mp = await prisma.marketplace.findFirst({
        where: { channel: 'AMAZON', code: req.marketplace },
        select: { marketplaceId: true },
      })
      if (!mp?.marketplaceId) {
        throw new Error(
          `No Marketplace row for AMAZON ${req.marketplace} — seed-marketplaces.ts may be stale.`,
        )
      }
      const deleteResult = await amazonSpApiClient.deleteListingsItem({
        sellerId,
        sku: preview.before.sku,
        marketplaceId: mp.marketplaceId,
      })
      if (!deleteResult.success) {
        throw new Error(
          `Delete failed: ${deleteResult.error ?? 'unknown error'}`,
        )
      }
      if (deleteResult.submissionId) submissionIds.push(deleteResult.submissionId)
      await pushStep('deleted_old_listing')

      // ChannelListing row is NOT deleted from our DB — we need it
      // around for the wizard to re-publish against. Mark it ENDED so
      // the operator + the publish path know it's not live.
      await prisma.channelListing.updateMany({
        where: {
          productId: req.productId,
          channel: 'AMAZON',
          marketplace: req.marketplace,
        },
        data: {
          listingStatus: 'ENDED',
          isPublished: false,
          // For NEW_ASIN_* actions, clear the ASIN so the wizard's
          // publish path doesn't try to attach to the old catalog item.
          externalListingId:
            req.action === 'DELETE_RELIST_SAME' ||
            req.action === 'SAME_ASIN_NEW_SKU'
              ? preview.before.asin
              : null,
        },
      })
      await pushStep('flagged_listing_ended')
    } else if (req.channel === 'EBAY') {
      throw new Error(
        'eBay recovery not yet implemented — use Seller Hub manually until W5.49b lands the trading-API orchestration.',
      )
    } else {
      throw new Error(`Channel ${req.channel} not supported by recovery flow.`)
    }

    // ── Step 3: rename Product.sku for SAME_ASIN_NEW_SKU + FULL_RESET.
    if (req.action === 'SAME_ASIN_NEW_SKU' || req.action === 'FULL_RESET') {
      const newSku = req.newSku?.trim()
      if (!newSku) throw new Error('newSku required for this action.')
      const existing = await prisma.product.findUnique({
        where: { sku: newSku },
        select: { id: true },
      })
      if (existing && existing.id !== req.productId) {
        throw new Error(
          `SKU ${newSku} is already in use by another product (${existing.id}).`,
        )
      }
      await prisma.product.update({
        where: { id: req.productId },
        data: { sku: newSku },
      })
      await pushStep('renamed_sku')
    }

    // ── Step 4: small propagation delay (Amazon side) before handing
    // off to the wizard. The wizard's publish-gate will additionally
    // poll if needed; this is just a courtesy buffer.
    await new Promise((r) => setTimeout(r, 3000))
    await pushStep('waited_for_propagation')

    // ── Step 5: hand off to the wizard for recreate.
    const durationMs = Date.now() - startedAt
    await prisma.listingRecoveryEvent.update({
      where: { id: event.id },
      data: {
        status: 'SUCCEEDED',
        completedSteps: steps,
        amazonSubmissionIds: submissionIds,
        completedAt: new Date(),
        durationMs,
      },
    })
    return {
      eventId: event.id,
      status: 'SUCCEEDED',
      completedSteps: steps,
      wizardUrl: `/products/${req.productId}/list-wizard?channel=${req.channel}&marketplace=${req.marketplace}&recoveryEventId=${event.id}&mode=recreate`,
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    const durationMs = Date.now() - startedAt
    await prisma.listingRecoveryEvent.update({
      where: { id: event.id },
      data: {
        status: 'FAILED',
        completedSteps: steps,
        amazonSubmissionIds: submissionIds,
        error,
        completedAt: new Date(),
        durationMs,
      },
    })
    logger.error('listing recovery failed', {
      eventId: event.id,
      productId: req.productId,
      action: req.action,
      error,
    })
    return {
      eventId: event.id,
      status: 'FAILED',
      completedSteps: steps,
      error,
    }
  }
}
