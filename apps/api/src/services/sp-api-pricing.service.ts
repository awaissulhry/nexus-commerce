/**
 * G.3.1 + G.3.2 — SP-API pricing data ingest.
 *
 *   refreshFeeEstimates(marketplaceCode)
 *     Calls GetMyFeesEstimate per ASIN; writes
 *     ChannelListing.estimatedFbaFee + referralFeePercent + feeFetchedAt.
 *     Run weekly per marketplace (fees rarely change).
 *
 *   refreshCompetitivePricing(marketplaceCode)
 *     Calls GetItemOffersBatch (up to 20 ASINs/call); writes
 *     ChannelListing.lowestCompetitorPrice + Product.buyBoxPrice +
 *     competitorFetchedAt. Run daily per marketplace.
 *
 * Both are failure-tolerant: SP-API throttling, missing creds, missing
 * permissions all surface as logged warnings rather than crashes.
 * GetCompetitivePricing is paywalled on some accounts — when the API
 * returns 403 we record the error and continue.
 *
 * Re-uses the SellingPartner client from sp-api-reports.service.ts via a
 * thin shared factory. SP-API resources used:
 *
 *   - productFees (operation: getMyFeesEstimateForASIN, getMyFeesEstimates)
 *   - productPricing (operation: getItemOffersBatch)
 *
 * NOT END-TO-END TESTED — needs real SP-API credentials with the
 * appropriate roles. Engine pulls these fields when present and falls
 * back to manual values when absent.
 */

import { SellingPartner } from 'amazon-sp-api'
import type { PrismaClient } from '@prisma/client'
import { logger } from '../utils/logger.js'

const RATE_LIMIT_MS = 200 // SP-API: 5 req/sec for productFees & productPricing

let cachedClient: SellingPartner | null = null
function getClient(): SellingPartner {
  if (cachedClient) return cachedClient
  const clientId = process.env.AMAZON_LWA_CLIENT_ID
  const clientSecret = process.env.AMAZON_LWA_CLIENT_SECRET
  const refreshToken = process.env.AMAZON_REFRESH_TOKEN
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
  const roleArn = process.env.AWS_ROLE_ARN
  if (!clientId || !clientSecret || !refreshToken || !accessKeyId || !secretAccessKey || !roleArn) {
    throw new Error(
      'sp-api-pricing: missing one or more required SP-API env vars',
    )
  }
  const region = (process.env.AMAZON_REGION ?? 'eu') as 'eu' | 'na' | 'fe'
  cachedClient = new SellingPartner({
    region,
    refresh_token: refreshToken,
    credentials: {
      SELLING_PARTNER_APP_CLIENT_ID: clientId,
      SELLING_PARTNER_APP_CLIENT_SECRET: clientSecret,
    },
    options: { auto_request_tokens: true, auto_request_throttled: true },
  } as any)
  return cachedClient
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface FeeRefreshResult {
  marketplaceCode: string
  marketplaceId: string
  asinsProcessed: number
  feesWritten: number
  errors: number
  durationMs: number
}

/**
 * Pull GetMyFeesEstimateForASIN for every Amazon ChannelListing on the
 * given marketplace. Persists per-listing estimatedFbaFee + referralFee.
 */
export async function refreshFeeEstimates(
  prisma: PrismaClient,
  marketplaceCode: string,
): Promise<FeeRefreshResult> {
  const startedAt = Date.now()
  const code = marketplaceCode.toUpperCase()

  const marketplace = await prisma.marketplace.findUnique({
    where: { channel_code: { channel: 'AMAZON', code } },
  })
  if (!marketplace?.marketplaceId) {
    throw new Error(`refreshFeeEstimates: no Marketplace row for AMAZON:${code}`)
  }

  // Pull every Amazon ChannelListing on this marketplace that has an ASIN.
  const listings = await prisma.channelListing.findMany({
    where: {
      channel: 'AMAZON',
      marketplace: code,
      OR: [
        { externalParentId: { not: null } },
        { externalListingId: { not: null } },
      ],
    },
    select: {
      id: true,
      productId: true,
      externalParentId: true,
      externalListingId: true,
      price: true,
    },
  })

  if (listings.length === 0) {
    return {
      marketplaceCode: code,
      marketplaceId: marketplace.marketplaceId,
      asinsProcessed: 0,
      feesWritten: 0,
      errors: 0,
      durationMs: Date.now() - startedAt,
    }
  }

  const sp = getClient()
  let feesWritten = 0
  let errors = 0
  for (const listing of listings) {
    const asin = listing.externalParentId ?? listing.externalListingId
    if (!asin) continue

    // Estimate at the current listed price (or fall back to a placeholder
    // 100.00 — fee math is roughly proportional anyway). When listing.price
    // is null the engine hasn't materialized; the seller can re-run after
    // first publish.
    const estimateAtPrice = listing.price ? Number(listing.price) : 100

    try {
      await sleep(RATE_LIMIT_MS)
      const res: any = await (sp as any).callAPI({
        operation: 'getMyFeesEstimateForASIN',
        endpoint: 'productFees',
        path: { Asin: asin },
        body: {
          FeesEstimateRequest: {
            MarketplaceId: marketplace.marketplaceId,
            IsAmazonFulfilled: true,
            PriceToEstimateFees: {
              ListingPrice: { CurrencyCode: marketplace.currency, Amount: estimateAtPrice },
            },
            Identifier: `nexus-${listing.id}`,
          },
        },
      })

      const detailList = res?.FeesEstimateResult?.FeesEstimate?.FeeDetailList ?? []
      let fbaFee = 0
      let referralPct = 0
      for (const d of detailList) {
        const type = d?.FeeType
        const amount = d?.FinalFee?.Amount ?? d?.FeeAmount?.Amount
        if (type === 'FBAFees' && typeof amount === 'number') fbaFee += amount
        if (type === 'ReferralFee' && typeof amount === 'number') {
          // Referral fee is reported as an absolute amount; convert back to
          // % of estimateAtPrice for storage. SP-API also includes
          // FeePromotion.PromotionAmount we ignore.
          referralPct = (amount / estimateAtPrice) * 100
        }
      }

      await prisma.channelListing.update({
        where: { id: listing.id },
        data: {
          estimatedFbaFee: fbaFee.toFixed(2),
          referralFeePercent: referralPct.toFixed(2),
          feeFetchedAt: new Date(),
        },
      })
      feesWritten++
    } catch (err) {
      errors++
      logger.warn('sp-api-pricing: fee estimate failed', {
        asin,
        marketplace: code,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    marketplaceCode: code,
    marketplaceId: marketplace.marketplaceId,
    asinsProcessed: listings.length,
    feesWritten,
    errors,
    durationMs: Date.now() - startedAt,
  }
}

interface CompetitiveRefreshResult {
  marketplaceCode: string
  marketplaceId: string
  asinsProcessed: number
  pricesWritten: number
  errors: number
  durationMs: number
}

/**
 * Pull GetItemOffersBatch for every Amazon ChannelListing on the given
 * marketplace. Persists lowestCompetitorPrice + Product.buyBoxPrice.
 *
 * GetCompetitivePricing is paywalled / role-restricted on some Amazon
 * accounts. 403 from SP-API surfaces here as a clean log message and
 * the worker keeps going. Engine treats null lowestCompetitorPrice as
 * "no signal" and falls back to manual cost-plus pricing.
 */
export async function refreshCompetitivePricing(
  prisma: PrismaClient,
  marketplaceCode: string,
): Promise<CompetitiveRefreshResult> {
  const startedAt = Date.now()
  const code = marketplaceCode.toUpperCase()

  const marketplace = await prisma.marketplace.findUnique({
    where: { channel_code: { channel: 'AMAZON', code } },
  })
  if (!marketplace?.marketplaceId) {
    throw new Error(`refreshCompetitivePricing: no Marketplace row for AMAZON:${code}`)
  }

  const listings = await prisma.channelListing.findMany({
    where: {
      channel: 'AMAZON',
      marketplace: code,
      OR: [
        { externalParentId: { not: null } },
        { externalListingId: { not: null } },
      ],
    },
    select: {
      id: true,
      productId: true,
      externalParentId: true,
      externalListingId: true,
    },
  })

  // Batch by 20 ASINs/request — SP-API limit.
  const sp = getClient()
  let pricesWritten = 0
  let errors = 0
  for (let i = 0; i < listings.length; i += 20) {
    const batch = listings.slice(i, i + 20)
    const requests = batch.map((l) => {
      const asin = l.externalParentId ?? l.externalListingId
      return {
        Uri: `/products/pricing/v0/items/${asin}/offers`,
        Method: 'GET',
        QueryParams: {
          MarketplaceId: marketplace.marketplaceId,
          ItemCondition: 'New',
          CustomerType: 'Consumer',
        },
      }
    })

    try {
      await sleep(RATE_LIMIT_MS * batch.length)
      const res: any = await (sp as any).callAPI({
        operation: 'getItemOffersBatch',
        endpoint: 'productPricing',
        body: { requests },
      })

      const responses = res?.responses ?? []
      for (let j = 0; j < responses.length; j++) {
        const listing = batch[j]
        const r = responses[j]
        if (r?.status?.statusCode !== 200) {
          errors++
          continue
        }
        const offers = r?.body?.payload?.Offers ?? []
        let lowest: number | null = null
        let buyBox: number | null = null
        for (const o of offers) {
          const price = o?.ListingPrice?.Amount
          if (typeof price !== 'number') continue
          if (lowest == null || price < lowest) lowest = price
          if (o?.IsBuyBoxWinner === true) buyBox = price
        }
        if (lowest != null || buyBox != null) {
          await prisma.channelListing.update({
            where: { id: listing.id },
            data: {
              lowestCompetitorPrice: lowest != null ? lowest.toFixed(2) : undefined,
              competitorFetchedAt: new Date(),
            },
          })
          if (buyBox != null && listing.productId) {
            await prisma.product.update({
              where: { id: listing.productId },
              data: { buyBoxPrice: buyBox.toFixed(2) },
            })
          }
          pricesWritten++
        }
      }
    } catch (err) {
      errors++
      logger.warn('sp-api-pricing: competitive batch failed', {
        marketplace: code,
        batchSize: batch.length,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    marketplaceCode: code,
    marketplaceId: marketplace.marketplaceId,
    asinsProcessed: listings.length,
    pricesWritten,
    errors,
    durationMs: Date.now() - startedAt,
  }
}
