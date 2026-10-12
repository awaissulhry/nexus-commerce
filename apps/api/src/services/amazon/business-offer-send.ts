/**
 * Amazon Business step 4 — send ONE listing's business offer, inside the Amazon push (`syncToAmazon`, live mode only).
 *
 * The listing's business setting (`@nexus/shared/business-price`) and its normal price give the business instance; a
 * fresh live read of `purchasable_offer` gives what Amazon holds; `amazonBusinessOfferPlan` gives the one patch
 * (merge / replace / delete, or nothing). Before anything is sent the setting is checked again against Amazon's rules
 * and the listing's minimum and maximum price (the normal price may have moved since it was saved). The patch goes
 * through `amazonSpApiClient.patchPurchasableOffer` (the channel gateway). What happened is kept on the listing at
 * `platformAttributes.amazonBusinessOffer` (one key, set atomically — no other key is touched, the version is not bumped).
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { amazonSpApiClient } from '../../clients/amazon-sp-api.client.js'
import { businessPriceOf, businessPriceProblems, type BusinessPriceSetting } from '@nexus/shared/business-price'
import { amazonBusinessElement, amazonBusinessOfferPlan, businessSendLine } from './business-offer.js'
import { readAmazonOfferLive } from './purchasable-offer.js'

/** A `[{ schedule: [{ value_with_tax }] }]` amount, or null. */
function scheduled(v: unknown): number | null {
  const s = Array.isArray(v) ? (v[0] as { schedule?: Array<{ value_with_tax?: unknown; value?: unknown }> } | undefined)?.schedule?.[0] : undefined
  const n = s?.value_with_tax ?? s?.value
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

export interface BusinessSendOutcome {
  ok: boolean
  /** What happened, in a sentence (sent, already held, removed, refused, could not read). */
  line: string
  /** Amazon or Nexus refused THIS listing's data: retrying the same data cannot succeed. */
  itemLevel?: boolean
  /** The live offer could not be read: nothing was sent; a retry may succeed. */
  retryable?: boolean
}

/** Keep what the last business send did, on the listing (`platformAttributes.amazonBusinessOffer`). Best effort. */
export async function recordAmazonBusinessSend(listingId: string, entry: { status: 'SENT' | 'HELD' | 'REMOVED' | 'REFUSED' | 'FAILED'; line: string }): Promise<void> {
  try {
    const value = JSON.stringify({ ...entry, at: new Date().toISOString() })
    await prisma.$executeRaw`UPDATE "ChannelListing" SET "platformAttributes" = jsonb_set(COALESCE("platformAttributes", '{}'::jsonb), '{amazonBusinessOffer}', ${value}::jsonb, true) WHERE id = ${listingId}`
  } catch (err) {
    logger.warn('amazon business offer: send not recorded on the listing', { listingId, error: err instanceof Error ? err.message : String(err) })
  }
}

export async function sendAmazonBusinessOffer(input: {
  listingId: string | null
  sellerId: string
  sku: string
  /** The SP-API marketplace id. */
  marketplaceId: string
  productType: string
  currency: string
  /** The listing's setting at send time; `null` = Nexus keeps none (a business offer Amazon holds is removed). */
  setting: BusinessPriceSetting | null
  /** The normal price the business price follows (the price this push sends, or the one the listing holds). */
  normalPrice: number | null
  minPrice: number | null
  maxPrice: number | null
}): Promise<BusinessSendOutcome> {
  const finish = async (outcome: BusinessSendOutcome, status: 'SENT' | 'HELD' | 'REMOVED' | 'REFUSED' | 'FAILED') => {
    if (input.listingId) await recordAmazonBusinessSend(input.listingId, { status, line: outcome.line })
    return outcome
  }
  const live = await readAmazonOfferLive({ sellerId: input.sellerId, sku: input.sku, marketplaceId: input.marketplaceId })
  if (live.read === 'failed') {
    return finish({ ok: false, retryable: true, line: `Amazon's current offer for ${input.sku} could not be read (${live.error ?? 'no answer'}), so the business price was not sent. It will be retried.` }, 'FAILED')
  }
  let wanted: Record<string, unknown> | null = null
  let line = 'the business offer removed'
  if (input.setting) {
    // The bounds Amazon enforces are the ones it holds now (a minimum set in Seller Central counts too); Nexus's own
    // stored bounds stand where Amazon shows none.
    const normal = live.instances.find((i) => i?.marketplace_id === input.marketplaceId && (i?.audience ?? 'ALL') === 'ALL')
    const minPrice = scheduled(normal?.minimum_seller_allowed_price) ?? input.minPrice
    const maxPrice = scheduled(normal?.maximum_seller_allowed_price) ?? input.maxPrice
    const problems = businessPriceProblems({ setting: input.setting, normalPrice: input.normalPrice, minPrice, maxPrice, currency: input.currency })
    if (problems.length) return finish({ ok: false, itemLevel: true, line: `The business price was not sent: ${problems.join(' ')}` }, 'REFUSED')
    const price = businessPriceOf(input.setting, input.normalPrice) as number
    wanted = amazonBusinessElement({ marketplaceId: input.marketplaceId, currency: input.currency, price, tiers: input.setting.tiers })
    line = `business price ${businessSendLine(price, input.setting.tiers, input.currency)}`
  }
  const plan = amazonBusinessOfferPlan({ wanted: wanted as never, live: live.instances, marketplaceId: input.marketplaceId })
  if (plan.kind === 'none') return finish({ ok: true, line: wanted ? `Amazon already holds the ${line}.` : 'Amazon holds no business offer; nothing to remove.' }, wanted ? 'SENT' : 'REMOVED')
  if (plan.kind === 'refused') return finish({ ok: false, itemLevel: true, line: plan.reason }, 'REFUSED')
  const res = await amazonSpApiClient.patchPurchasableOffer({
    sellerId: input.sellerId, sku: input.sku, marketplaceId: input.marketplaceId, productType: input.productType, op: plan.kind, value: plan.value,
  })
  if (!res.success) return finish({ ok: false, itemLevel: true, line: `Amazon refused the ${line}: ${res.error ?? 'no reason given'}` }, 'REFUSED')
  return finish({ ok: true, line: plan.kind === 'delete' ? 'The business offer was removed on Amazon.' : `Sent to Amazon: ${line}.` }, plan.kind === 'delete' ? 'REMOVED' : 'SENT')
}

