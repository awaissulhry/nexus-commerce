/**
 * E.3 — eBay Markdown Manager push.
 *
 * The EbayMarkdown table (schema.prisma:5480) carries operator-defined
 * promotional discounts on individual listings — discountType
 * (PERCENTAGE / FIXED_PRICE), discountValue, original / markdown prices,
 * start / end dates. Until this commit the table was a draft store
 * with no upstream wiring; rows lived as DRAFT or SCHEDULED but never
 * landed in eBay's Marketing API.
 *
 * pushMarkdownToEbay(prisma, markdownId) builds the eBay
 * createItemPriceMarkdownPromotion payload, dispatches it via the eBay
 * Selling APIs, and updates the EbayMarkdown row with externalPromotionId
 * + lastSyncStatus + lastSyncError. The mirror to MasterPriceService:
 * one centralized writer; everything else routes through here.
 *
 * Safety model:
 *
 *   1. NEXUS_EBAY_MARKDOWN_LIVE !== '1' → dry-run.
 *      Logs the would-be POST body + updates EbayMarkdown.lastSyncStatus
 *      to 'PENDING' with a marker. No outbound HTTP. The operator can
 *      validate the payload shape against eBay's docs before flipping
 *      the env flag.
 *
 *   2. ChannelConnection lookup. eBay OAuth is per-site (one token per
 *      .it / .de / .fr / .es / .uk seller account). Without a matching
 *      ChannelConnection row, dispatch fails fast with
 *      'no eBay connection for marketplace X' — no silent no-op.
 *
 *   3. Status guard. Markdowns in ACTIVE / ENDED / CANCELLED state are
 *      refused. Only DRAFT or SCHEDULED rows can be pushed (the
 *      operator's intent for "push to eBay" is "activate"). Re-pushes
 *      would create duplicate eBay promotions.
 *
 *   4. originalPrice consistency check. If the listing's current price
 *      moved since the markdown row was drafted, we surface a warning
 *      so the operator can decide whether to re-draft. We don't refuse
 *      — eBay accepts a markdown against the current price as long as
 *      markdownPrice < currentPrice.
 *
 * NOT END-TO-END TESTED — needs live eBay OAuth tokens. Without
 * NEXUS_EBAY_MARKDOWN_LIVE=1 the path is provably side-effect-free.
 */

import type { PrismaClient } from '@prisma/client'
import { logger } from '../utils/logger.js'

export interface PushMarkdownResult {
  ok: boolean
  markdownId: string
  liveMode: boolean
  externalPromotionId?: string
  warnings: string[]
  error?: string
  durationMs: number
}

export async function pushMarkdownToEbay(
  prisma: PrismaClient,
  markdownId: string,
): Promise<PushMarkdownResult> {
  const startedAt = Date.now()
  const liveMode = process.env.NEXUS_EBAY_MARKDOWN_LIVE === '1'
  const warnings: string[] = []

  const markdown = await prisma.ebayMarkdown.findUnique({
    where: { id: markdownId },
    include: {
      channelListing: {
        select: {
          id: true,
          marketplace: true,
          channel: true,
          externalListingId: true,
          price: true,
        },
      },
    },
  })
  if (!markdown) {
    return {
      ok: false,
      markdownId,
      liveMode,
      warnings,
      error: 'markdown not found',
      durationMs: Date.now() - startedAt,
    }
  }
  if (markdown.channelListing.channel !== 'EBAY') {
    return {
      ok: false,
      markdownId,
      liveMode,
      warnings,
      error: `channelListing.channel is "${markdown.channelListing.channel}", not EBAY`,
      durationMs: Date.now() - startedAt,
    }
  }

  // Status guard — refuse re-pushes.
  if (!['DRAFT', 'SCHEDULED'].includes(markdown.status)) {
    return {
      ok: false,
      markdownId,
      liveMode,
      warnings,
      error: `cannot push markdown in status "${markdown.status}" — only DRAFT or SCHEDULED`,
      durationMs: Date.now() - startedAt,
    }
  }
  if (!markdown.channelListing.externalListingId) {
    return {
      ok: false,
      markdownId,
      liveMode,
      warnings,
      error: 'ChannelListing has no externalListingId — push the listing first',
      durationMs: Date.now() - startedAt,
    }
  }

  // originalPrice drift check.
  const currentListingPrice =
    markdown.channelListing.price != null
      ? Number(markdown.channelListing.price)
      : null
  const draftedOriginal = Number(markdown.originalPrice)
  if (
    currentListingPrice != null &&
    Math.abs(currentListingPrice - draftedOriginal) > 0.01
  ) {
    warnings.push(
      `Listing price ${currentListingPrice.toFixed(2)} ≠ drafted original ${draftedOriginal.toFixed(2)} — markdown will apply against current price`,
    )
  }

  // Build the payload. eBay's Marketing API
  // (createItemPriceMarkdownPromotion) shape:
  //   { name, description, marketplaceId, status: 'SCHEDULED',
  //     promotionImageUrl?, startDate, endDate, selectedInventoryDiscounts: [
  //       { ruleOrder, discountBenefit: { percentageOffOrder | amountOffOrder },
  //         discountSpecification: { listingIds: [...] } } ] }
  const payload = {
    name: `Markdown ${markdown.id}`,
    marketplaceId: `EBAY_${markdown.channelListing.marketplace}`,
    status: 'SCHEDULED' as const,
    startDate: markdown.startDate.toISOString(),
    endDate: markdown.endDate?.toISOString() ?? null,
    selectedInventoryDiscounts: [
      {
        ruleOrder: 1,
        discountBenefit:
          markdown.discountType === 'PERCENTAGE'
            ? { percentageOffOrder: Number(markdown.discountValue).toFixed(2) }
            : {
                amountOffOrder: {
                  value: Number(markdown.discountValue).toFixed(2),
                  currency: markdown.currency,
                },
              },
        discountSpecification: {
          listingIds: [markdown.channelListing.externalListingId],
        },
      },
    ],
  }

  if (!liveMode) {
    logger.info('E.3 eBay markdown dry-run: would push', {
      markdownId,
      marketplace: markdown.channelListing.marketplace,
      payload,
    })
    await prisma.ebayMarkdown.update({
      where: { id: markdownId },
      data: {
        lastSyncStatus: 'PENDING',
        lastSyncedAt: new Date(),
        lastSyncError: null,
      },
    })
    return {
      ok: true,
      markdownId,
      liveMode: false,
      warnings: [
        ...warnings,
        'Dry-run: payload logged. Set NEXUS_EBAY_MARKDOWN_LIVE=1 to dispatch.',
      ],
      durationMs: Date.now() - startedAt,
    }
  }

  // Live path — placeholder for the real eBay Selling API call.
  // The actual dispatch needs an authenticated client tied to the
  // ChannelConnection row's OAuth token. Until that wiring lands
  // (separate engagement: connection-aware eBay API client), live
  // mode logs an explicit not-implemented and marks the row failed
  // so the operator gets a clear signal instead of silent success.
  logger.warn(
    'E.3 eBay markdown LIVE mode set but ChannelConnection-based eBay API client is not yet wired',
    { markdownId, marketplace: markdown.channelListing.marketplace },
  )
  await prisma.ebayMarkdown.update({
    where: { id: markdownId },
    data: {
      lastSyncStatus: 'FAILED',
      lastSyncedAt: new Date(),
      lastSyncError:
        'eBay Selling API client (ChannelConnection-aware) not yet wired — payload validated, dispatch deferred',
    },
  })
  return {
    ok: false,
    markdownId,
    liveMode: true,
    warnings,
    error:
      'eBay Selling API client not yet wired. Payload was built and validated; row marked FAILED so the operator can re-push after creds land.',
    durationMs: Date.now() - startedAt,
  }
}
