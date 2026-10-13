/**
 * Amazon Business step 4 — send ONE listing's business offer, inside the Amazon push (`syncToAmazon`, live mode only).
 *
 * The listing's business setting (`@nexus/shared/business-price`) and its normal price give the business instance; a
 * live read of `purchasable_offer` gives what Amazon holds; `amazonBusinessOfferPlan` gives the one patch (merge /
 * replace / delete, or nothing). Before anything is sent the setting is checked again against Amazon's rules and the
 * strictest minimum and maximum price Amazon or Nexus holds (the normal price may have moved since it was saved). The
 * patch goes through `amazonSpApiClient.patchPurchasableOffer` (the channel gateway), named with the product type Amazon
 * holds for the SKU.
 *
 * Two lanes:
 *   - `row` — a `BUSINESS_PRICE_UPDATE` row: may create the business offer (a replace), but only while the listing is as
 *     the job read it (`unchanged`), so a normal price change saved meanwhile is never overwritten by an older one.
 *   - `follow` — right after a normal price push, for a percent-off price: never a replace (the read may predate that
 *     push); a first offer, or a failure that may pass later, is handed back `retryable` for a business row to do.
 *
 * What the last send did is kept on the listing at `platformAttributes.amazonBusinessSend` (one key, set atomically).
 */
import prisma from '../../db.js'
import { announceListingValues } from '../listing-values-events.js'
import { logger } from '../../utils/logger.js'
import { amazonSpApiClient } from '../../clients/amazon-sp-api.client.js'
import { businessPriceOf, businessPriceProblems, type BusinessPriceSetting } from '@nexus/shared/business-price'
import type { AmazonOfferFacts } from './offer-facts.js'
import { amazonPurchasableOffer } from './offer-attributes.js'
import { amazonBusinessElement, amazonBusinessOfferPlan, businessSendLine, liveBusinessInstance, liveNormalInstance } from './business-offer.js'
import { readAmazonOfferLive } from './purchasable-offer.js'

type SendStatus = 'SENT' | 'REMOVED' | 'REFUSED' | 'FAILED' | 'DEFERRED'
export interface BusinessSendOutcome {
  ok: boolean
  /** What happened, in a sentence (sent, already held, removed, refused, could not read, handed to a business row). */
  line: string
  status: SendStatus
  /** Amazon or Nexus refused THIS listing's data: sending it again cannot succeed. */
  itemLevel?: boolean
  /** Nothing was sent and it may pass later (no answer, throttled, the listing moved, a first offer in the follow lane). */
  retryable?: boolean
}

/**
 * What a send was about: the setting and the normal price it follows. The nightly check does not queue the same refused
 * send again until one of them changes (`business-offer-adopt.service.ts`).
 */
export const businessSendSignature = (setting: BusinessPriceSetting | null, normalPrice: number | null) => JSON.stringify({ setting, normalPrice })

/** Keep what the last business send did, on the listing (`platformAttributes.amazonBusinessSend`). Best effort. */
export async function recordAmazonBusinessSend(listingId: string, entry: { status: SendStatus; line: string; signature?: string }): Promise<void> {
  try {
    const value = JSON.stringify({ ...entry, at: new Date().toISOString() })
    await prisma.$executeRaw`UPDATE "ChannelListing" SET "platformAttributes" = jsonb_set(COALESCE("platformAttributes", '{}'::jsonb), '{amazonBusinessSend}', ${value}::jsonb, true) WHERE id = ${listingId}`
    // The open Matrix re-reads the cell: its send state (sent, refused, removed) shows without a reload.
    announceListingValues([listingId], ['businessPrice'], 'business-send')
  } catch (err) {
    logger.warn('amazon business offer: send not recorded on the listing', { listingId, error: err instanceof Error ? err.message : String(err) })
  }
}

/** A `[{ schedule: [{ value_with_tax }] }]` amount, or null. */
function scheduled(v: unknown): number | null {
  const s = Array.isArray(v) ? (v[0] as { schedule?: Array<{ value_with_tax?: unknown; value?: unknown }> } | undefined)?.schedule?.[0] : undefined
  const n = s?.value_with_tax ?? s?.value
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}
const strictest = (pick: (a: number, b: number) => number, ...values: Array<number | null | undefined>) =>
  values.filter((v): v is number => typeof v === 'number').reduce<number | null>((acc, v) => (acc == null ? v : pick(acc, v)), null)

export async function sendAmazonBusinessOffer(input: {
  lane: 'row' | 'follow'
  listingId: string | null
  sellerId: string
  sku: string
  /** The SP-API marketplace id. */
  marketplaceId: string
  /** Nexus's product type; Amazon's own (from the live read) wins. */
  productType: string
  currency: string
  /** The listing's setting at send time; `null` = Nexus keeps none (a business offer Amazon holds is removed). */
  setting: BusinessPriceSetting | null
  /** The normal price the business price follows: the price this push sends, or the one the listing holds. */
  normalPrice: number | null
  /** The listing's job-lane offer facts: Nexus's bounds, and the normal offer a first business offer's replace carries. */
  facts: Pick<AmazonOfferFacts, 'values' | 'source'>
  /** `follow` lane: the instances the normal push read just before it sent (its merge leaves the business instance alone). */
  live?: Array<Record<string, unknown>>
  /** `follow` lane: the product type that read named. */
  liveProductType?: string | null
  /** Why the normal price a first offer's replace would carry may not be sent (floor/ceiling, Amazon bounds); null = it may. */
  normalRefusal?: string | null
  /** `row` lane: is the listing still as the job read it? Asked right before a replace. */
  unchanged?: () => Promise<boolean>
  /** Any send: is the business setting still the one this job read? A newer one goes out with its own row. */
  settingUnchanged?: () => Promise<boolean>
}): Promise<BusinessSendOutcome> {
  const signature = businessSendSignature(input.setting, input.normalPrice)
  const finish = async (outcome: BusinessSendOutcome) => {
    if (input.listingId) await recordAmazonBusinessSend(input.listingId, { status: outcome.status, line: outcome.line, signature })
    return outcome
  }
  const read = input.live ? { read: 'ok' as const, instances: input.live, productType: input.liveProductType ?? null, error: undefined as string | undefined }
    : await readAmazonOfferLive({ sellerId: input.sellerId, sku: input.sku, marketplaceId: input.marketplaceId })
  if (read.read === 'failed') {
    return finish({ ok: false, retryable: true, status: 'FAILED', line: `Amazon's current offer for ${input.sku} could not be read (${read.error ?? 'no answer'}), so the business price was not sent.` })
  }
  const productType = read.productType || input.productType
  let wanted: Record<string, unknown> | null = null
  let line = 'the business offer removed'
  if (input.setting) {
    // The bounds Amazon enforces are the ones it holds now — on the normal offer or the business one, a minimum set in
    // Seller Central too — and Nexus's own stored ones: the strictest of them all.
    const normal = liveNormalInstance(read.instances, input.marketplaceId)
    const business = liveBusinessInstance(read.instances, input.marketplaceId)
    const minPrice = strictest(Math.max, scheduled(normal?.minimum_seller_allowed_price), scheduled(business?.minimum_seller_allowed_price), input.facts.values.minimum_seller_allowed_price)
    const maxPrice = strictest(Math.min, scheduled(normal?.maximum_seller_allowed_price), scheduled(business?.maximum_seller_allowed_price), input.facts.values.maximum_seller_allowed_price)
    const problems = businessPriceProblems({ setting: input.setting, normalPrice: input.normalPrice, minPrice, maxPrice, currency: input.currency })
    if (problems.length) return finish({ ok: false, itemLevel: true, status: 'REFUSED', line: `The business price was not sent: ${problems.join(' ')}` })
    const price = businessPriceOf(input.setting, input.normalPrice) as number
    wanted = amazonBusinessElement({ marketplaceId: input.marketplaceId, currency: input.currency, price, tiers: input.setting.tiers })
    line = `business price ${businessSendLine(price, input.setting.tiers, input.currency)}`
  }
  // The follow lane never creates a business offer (its read may predate the push it follows): a business row does.
  if (input.lane === 'follow' && wanted && !liveBusinessInstance(read.instances, input.marketplaceId)) {
    return finish({ ok: false, retryable: true, status: 'DEFERRED', line: `Amazon holds no business offer yet: the ${line} is sent by its own business row.` })
  }
  const normalRoot = amazonPurchasableOffer({ marketplaceId: input.marketplaceId, currency: input.currency, facts: input.facts, base: read.instances, sendPrice: input.normalPrice })
  const plan = amazonBusinessOfferPlan({ wanted: wanted as never, live: read.instances as never, marketplaceId: input.marketplaceId, normalRoot: normalRoot as never })
  if (plan.kind === 'none') {
    return finish({ ok: true, status: wanted ? 'SENT' : 'REMOVED', line: wanted ? `Amazon already holds the ${line}.` : 'Amazon holds no business offer; nothing to remove.' })
  }
  if (plan.kind === 'refused') return finish({ ok: false, itemLevel: true, status: 'REFUSED', line: plan.reason })
  if (plan.kind === 'replace' && input.lane === 'follow') {
    return finish({ ok: false, retryable: true, status: 'DEFERRED', line: `Amazon holds no business offer yet: the ${line} is sent by its own business row.` })
  }
  if (plan.kind === 'replace' && input.normalRefusal) {
    return finish({ ok: false, itemLevel: true, status: 'REFUSED', line: `The first business offer is sent with the normal offer, and its price may not go: ${input.normalRefusal}` })
  }
  /* A FIRST business offer is sent with the normal offer (a replace): while Amazon's shopper price is not Nexus's, it would
     also change what shoppers pay (10-13: a −5 % copy moved a size from €105 to €99). Not sent, with both numbers; tried
     again by itself (a price push still on its way to Amazon catches up), and the nightly check sends it once the two
     prices agree — never a final refusal that would keep it from going once they do. */
  if (plan.kind === 'replace') {
    const amazonNormal = scheduled(liveNormalInstance(read.instances, input.marketplaceId)?.our_price)
    if (amazonNormal != null && input.normalPrice != null && Math.abs(amazonNormal - input.normalPrice) >= 0.005) {
      const money = (v: number) => `${input.currency} ${v.toFixed(2)}`
      return finish({ ok: false, retryable: true, status: 'FAILED', line: `Not sent: Amazon's shopper price is ${money(amazonNormal)} and Nexus's is ${money(input.normalPrice)}. A first business price is sent with the shopper price, so it would change what shoppers pay. Make the two prices the same; the business price is then sent by itself.` })
    }
  }
  if (plan.kind === 'replace' && input.unchanged && !(await input.unchanged())) {
    return finish({ ok: false, retryable: true, status: 'DEFERRED', line: 'The listing changed while its business price was being sent; it is sent again from the newer values.' })
  }
  /* Any send (a change, a removal too): never an OLDER setting over a newer one a person saved meanwhile — that write
     queued its own row, which sends the newer one. */
  if (input.settingUnchanged && !(await input.settingUnchanged())) {
    return finish({ ok: false, retryable: true, status: 'DEFERRED', line: 'The business price changed while it was being sent; the newer one is sent by its own row.' })
  }
  if (!productType) return finish({ ok: false, itemLevel: true, status: 'REFUSED', line: `Nothing was sent: Amazon names no product type for ${input.sku}, and Nexus holds none for this listing or its product.` })
  const res = await amazonSpApiClient.patchPurchasableOffer({
    sellerId: input.sellerId, sku: input.sku, marketplaceId: input.marketplaceId, productType, op: plan.kind, value: plan.value,
  })
  if (!res.success) {
    return res.itemLevel
      ? finish({ ok: false, itemLevel: true, status: 'REFUSED', line: `Amazon refused the ${line}: ${res.error ?? 'no reason given'}` })
      : finish({ ok: false, retryable: true, status: 'FAILED', line: `The ${line} did not reach Amazon (${res.error ?? 'no answer'}).` })
  }
  return finish({ ok: true, status: plan.kind === 'delete' ? 'REMOVED' : 'SENT', line: plan.kind === 'delete' ? 'The business offer was removed on Amazon.' : `Sent to Amazon: ${line}.` })
}
