/**
 * VP.2 — eBay Volume Pricing push.
 *
 * The EbayVolumePromotion table (schema.prisma:11369) carries operator-defined
 * volume-discount ladders — 1-3 fixed buyer tiers (buy 2 / 3 / 4) with
 * strictly-increasing percentOff — scoped to a marketplace and an explicit SKU
 * list. Until pushed the row lives as DRAFT or SCHEDULED with no eBay-side
 * promotion behind it.
 *
 * pushVolumePromotion(prisma, promotionId) builds the eBay
 * createItemPromotion (VOLUME_DISCOUNT) payload, dispatches it through the
 * connection-aware Sell-Marketing client (VP.0), and updates the
 * EbayVolumePromotion row with externalPromotionId + lastSyncStatus +
 * lastSyncError. It is the single centralized writer for this table — the
 * direct mirror of pushMarkdownToEbay.
 *
 * Safety model (mirrors E.3 markdown):
 *
 *   1. NEXUS_EBAY_VOLUME_LIVE !== '1' → dry-run. Logs the would-be POST body
 *      + sets lastSyncStatus='PENDING'. No outbound HTTP. The operator can
 *      validate the payload shape against eBay's docs before flipping the flag.
 *
 *   2. Status guard. Only DRAFT or SCHEDULED rows may push (the operator's
 *      intent for "push to eBay" is "activate"). ACTIVE / ENDED / CANCELLED /
 *      FAILED are refused so re-pushes can't create duplicate eBay promotions.
 *
 *   3. Tier validation. The fixed buy-2/3/4 ladder + strictly-increasing
 *      percentOff is re-checked at the wire boundary via validateVolumeTiers —
 *      a malformed row never reaches eBay.
 *
 *   4. Inventory size guard. eBay's item_promotion accepts at most 500 SKUs in
 *      INVENTORY_BY_VALUE; beyond that we refuse rather than send a doomed POST.
 *
 * NOT END-TO-END TESTED — needs live eBay OAuth tokens. Without
 * NEXUS_EBAY_VOLUME_LIVE=1 the path is provably side-effect-free (DB status
 * write only).
 */

import type { PrismaClient } from '@prisma/client'
import { logger } from '../utils/logger.js'
import { postEbayMarketing } from './ebay-marketing-dispatch.service.js'
import { validateVolumeTiers, type VolumeTier } from './ebay-volume-pricing.service.js'

export interface PushVolumePromotionResult {
  ok: boolean
  promotionId: string
  liveMode: boolean
  externalPromotionId?: string
  warnings: string[]
  error?: string
  durationMs: number
}

const MAX_SKUS = 500

export async function pushVolumePromotion(
  prisma: PrismaClient,
  promotionId: string,
): Promise<PushVolumePromotionResult> {
  const startedAt = Date.now()
  const liveMode = process.env.NEXUS_EBAY_VOLUME_LIVE === '1'
  const warnings: string[] = []

  const promo = await prisma.ebayVolumePromotion.findUnique({
    where: { id: promotionId },
  })
  if (!promo) {
    return {
      ok: false,
      promotionId,
      liveMode,
      warnings,
      error: 'volume promotion not found',
      durationMs: Date.now() - startedAt,
    }
  }

  // Status guard — refuse re-pushes.
  if (!['DRAFT', 'SCHEDULED'].includes(promo.status)) {
    return {
      ok: false,
      promotionId,
      liveMode,
      warnings,
      error: `cannot push volume promotion in status "${promo.status}" — only DRAFT or SCHEDULED`,
      durationMs: Date.now() - startedAt,
    }
  }

  // Tier validation at the wire boundary.
  const tiers = (Array.isArray(promo.tiers) ? promo.tiers : []) as unknown as VolumeTier[]
  const validation = validateVolumeTiers(tiers)
  warnings.push(...validation.warnings)
  if (!validation.ok) {
    return {
      ok: false,
      promotionId,
      liveMode,
      warnings,
      error: `invalid tiers: ${validation.errors.join('; ')}`,
      durationMs: Date.now() - startedAt,
    }
  }

  // Inventory size guard.
  const skus = (Array.isArray(promo.skus) ? promo.skus : []) as string[]
  if (skus.length > MAX_SKUS) {
    return {
      ok: false,
      promotionId,
      liveMode,
      warnings,
      error: `too many SKUs (${skus.length}) — eBay item_promotion accepts at most ${MAX_SKUS}`,
      durationMs: Date.now() - startedAt,
    }
  }

  const sortedTiers = [...tiers].sort((a, b) => a.minQty - b.minQty)

  // Build the payload. eBay's Marketing API createItemPromotion
  // (VOLUME_DISCOUNT) shape:
  //   { name, marketplaceId, promotionStatus: 'SCHEDULED',
  //     promotionType: 'VOLUME_DISCOUNT', applyDiscountToSingleItemOnly,
  //     startDate, endDate?, inventoryCriterion, discountRules: [...] }
  // The first discountRule is the required baseline: minQuantity 1 / 0% off.
  const payload = {
    name: promo.name,
    marketplaceId: `EBAY_${promo.marketplace}`,
    promotionStatus: 'SCHEDULED' as const,
    promotionType: 'VOLUME_DISCOUNT' as const,
    applyDiscountToSingleItemOnly: true, // multiples of the SAME SKU
    startDate: (promo.startDate ?? new Date()).toISOString(),
    ...(promo.endDate ? { endDate: promo.endDate.toISOString() } : {}),
    inventoryCriterion: skus.length
      ? {
          inventoryCriterionType: 'INVENTORY_BY_VALUE' as const,
          inventoryItems: skus.map((sku) => ({
            inventoryReferenceId: sku,
            inventoryReferenceType: 'INVENTORY_ITEM' as const,
          })),
        }
      : { inventoryCriterionType: 'INVENTORY_ANY' as const },
    discountRules: [
      {
        discountSpecification: { minQuantity: 1 },
        discountBenefit: { percentageOffOrder: '0' },
        ruleOrder: 1,
      },
      ...sortedTiers.map((t, i) => ({
        discountSpecification: { minQuantity: t.minQty },
        discountBenefit: { percentageOffOrder: String(t.percentOff) },
        ruleOrder: i + 2,
      })),
    ],
  }

  if (!liveMode) {
    logger.info('VP.2 eBay volume-pricing dry-run: would push', {
      promotionId,
      marketplace: promo.marketplace,
      payload,
    })
    await prisma.ebayVolumePromotion.update({
      where: { id: promotionId },
      data: {
        lastSyncStatus: 'PENDING',
        lastSyncedAt: new Date(),
        lastSyncError: null,
      },
    })
    return {
      ok: true,
      promotionId,
      liveMode: false,
      warnings: [
        ...warnings,
        'Dry-run: payload logged. Set NEXUS_EBAY_VOLUME_LIVE=1 to dispatch.',
      ],
      durationMs: Date.now() - startedAt,
    }
  }

  // Live path — dispatch via the connection-aware Sell-Marketing client (VP.0).
  const result = await postEbayMarketing('/sell/marketing/v1/item_promotion', payload)
  if (!result.ok) {
    await prisma.ebayVolumePromotion.update({
      where: { id: promotionId },
      data: {
        lastSyncStatus: 'FAILED',
        lastSyncedAt: new Date(),
        lastSyncError: `${result.errorId ?? result.status}: ${result.errorMessage ?? 'dispatch failed'}`,
      },
    })
    return {
      ok: false,
      promotionId,
      liveMode: true,
      warnings,
      error: `eBay dispatch failed (${result.errorId ?? result.status}): ${result.errorMessage ?? 'unknown'}`,
      durationMs: Date.now() - startedAt,
    }
  }
  const now = new Date()
  await prisma.ebayVolumePromotion.update({
    where: { id: promotionId },
    data: {
      status: promo.startDate && promo.startDate <= now ? 'ACTIVE' : 'SCHEDULED',
      externalPromotionId: result.promotionId ?? null,
      lastSyncStatus: 'SUCCESS',
      lastSyncedAt: now,
      lastSyncError: null,
    },
  })
  return {
    ok: true,
    promotionId,
    liveMode: true,
    externalPromotionId: result.promotionId,
    warnings,
    durationMs: Date.now() - startedAt,
  }
}
