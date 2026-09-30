/**
 * The live `purchasable_offer` of one SKU in one Amazon market, and a price push that changes only what Nexus means to
 * change in it.
 *
 * ONE reader, moved here from `amazon-market-offer.service.ts` (SCT.6) so the queue's price push can use it without the
 * flat-file module that service imports: `getListingsItem` with attributes + summaries, through `amazonSpApiClient` and
 * so through the channel gateway (P1.2). SCT.6's close snapshots the offer with it; `outbound-sync.service.ts` reads it
 * before an Amazon price push to find the instance it prices.
 *
 * Why the price push needs it. `buildAmazonListingPatch` emits `op: replace` on `/attributes/purchasable_offer` with ONE
 * instance holding `currency`, `our_price` and `marketplace_id` (and `discounted_price` when Nexus owns a sale). A
 * replace sets the attribute it names (op table: "adds or replaces the target property"), so whatever Nexus does not
 * send could go with it: a sale set in Seller Central, `map_price`, the minimum/maximum seller-allowed prices, the offer's
 * start/end dates, the B2B (`audience`) instance. Amazon documents a finer op for exactly this case: `merge` on
 * `purchasable_offer` "surgically updates OR deletes individual sub-attributes (set to `null` to delete)" on the offer
 * instance its selectors name (`marketplace_id`, `currency`, `audience`), and leaves what it omits —
 * https://developer-docs.amazon/sp-api/docs/manage-purchasable-offer (updated 2026-09-09) and the `PatchOperation` op
 * enum (`add | replace | merge | delete`) in listingsItems_2021-08-01.json. The live read gives the merge its exact
 * selectors, and tells a first offer (no instance yet: the builder's replace goes as before) from an existing one.
 *
 * Two senders use it, behind ONE switch: the queue's price push (`outbound-sync.service.ts`) and the pricing-engine push
 * (`pricing-outbound.service.ts`).
 */
import { amazonSpApiClient } from '../../clients/amazon-sp-api.client.js'

/**
 * 🔴 The switch: `NEXUS_AMAZON_OFFER_MERGE=1` turns the read + merge on; unset or anything else keeps today's
 * `replace` and makes no live read. Read at send time, so a Railway variable change needs no code change.
 *
 * Why it exists (Owner, 2026-09-30): the merge ships OFF, is proven on Amazon without changing anything
 * (`scripts/amazon-offer-merge-proof.mts`, VALIDATION_PREVIEW only), and is switched on only after that.
 * When it may go: once it has run ON in production and a price push has been read back with the rest of the offer
 * intact — then delete this function, its two call sites and the OFF arms of their tests, in one change.
 */
export const AMAZON_OFFER_MERGE_ENV = 'NEXUS_AMAZON_OFFER_MERGE'
export function amazonOfferMergeEnabled(): boolean {
  return process.env[AMAZON_OFFER_MERGE_ENV] === '1'
}

/** The reason a price push sent nothing because the live offer could not be read. Each sender adds how it retries. */
export function amazonOfferReadFailure(sku: string, error: string | undefined): string {
  return `Amazon's current offer for ${sku} could not be read (${error ?? 'no answer'}), so the price was not sent: sent without it, the push could clear the offer's sale and the other parts Nexus does not set.`
}

/**
 * The offer instance the pricing-engine push prices — the one `amazonSpApiClient.patchListingPrice` sends (its
 * replace is left exactly as it was; `clients/amazon-sp-api.price-offer-parity.vitest.test.ts` pins the two to the same bytes).
 */
export function amazonListingPriceOffer(input: { marketplaceId: string; currencyCode: string; price: number; taxInclusive: boolean }): Record<string, unknown> {
  const { marketplaceId, currencyCode, price, taxInclusive } = input
  return {
    marketplace_id: marketplaceId,
    currency: currencyCode,
    our_price: taxInclusive ? [{ schedule: [{ value_with_tax: price }] }] : [{ schedule: [{ value: price, currency: currencyCode }] }],
  }
}

/** What the live read saw, handed to a caller's `refuse` check before anything is sent. */
export interface AmazonOfferLiveRead {
  /** 'failed' = the read threw or answered success:false — nothing about the listing is known. */
  read: 'ok' | 'failed'
  offers: Array<Record<string, unknown>>
  /** fulfillment_availability[].fulfillment_channel_code, e.g. DEFAULT (merchant) or AMAZON_EU (FBA). */
  fulfillmentChannels: string[]
  error?: string
  /** Every live purchasable_offer instance the answer carried, verbatim — every audience, every market. */
  instances: Array<Record<string, unknown>>
  /** The live product type (`summaries[0].productType`), upper case; null when the answer names none. */
  productType: string | null
}

/** The marketplace's purchasable_offer instances from a live attributes read. */
export function offerInstancesFor(attrs: Record<string, unknown> | null | undefined, marketplaceId: string): Array<Record<string, unknown>> {
  const po = (attrs as { purchasable_offer?: Array<Record<string, unknown>> } | null | undefined)?.purchasable_offer
  if (!Array.isArray(po)) return []
  return po.filter((x) => x && (x.marketplace_id === marketplaceId || po.length === 1))
}

/**
 * Read one SKU's live offer in one market. Never throws: a failed read answers `read: 'failed'` with the reason.
 * `client` defaults to the gateway client; the offer-merge proof passes its read-and-preview-only wrapper.
 */
export async function readAmazonOfferLive(
  input: { sellerId: string; sku: string; marketplaceId: string },
  client: Pick<typeof amazonSpApiClient, 'getListingsItem'> = amazonSpApiClient,
): Promise<AmazonOfferLiveRead> {
  const { sellerId, sku, marketplaceId } = input
  const live: AmazonOfferLiveRead = { read: 'ok', offers: [], fulfillmentChannels: [], instances: [], productType: null }
  try {
    const answer = await client.getListingsItem({
      sellerId, sku, marketplaceId, includedData: ['attributes', 'summaries'],
    } as never)
    const raw = (answer as { rawResponse?: { attributes?: Record<string, unknown>; summaries?: Array<{ productType?: string }> } }).rawResponse
    if ((answer as { success?: boolean }).success === false) {
      live.read = 'failed'
      live.error = (answer as { error?: string }).error ?? 'the listing read answered success:false'
    }
    live.offers = offerInstancesFor(raw?.attributes, marketplaceId)
    const po = (raw?.attributes as { purchasable_offer?: unknown } | undefined)?.purchasable_offer
    live.instances = Array.isArray(po) ? po.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []
    const fa = (raw?.attributes as { fulfillment_availability?: Array<{ fulfillment_channel_code?: unknown }> } | undefined)?.fulfillment_availability
    live.fulfillmentChannels = Array.isArray(fa) ? fa.map((f) => String(f?.fulfillment_channel_code ?? '').toUpperCase()) : []
    const liveType = raw?.summaries?.[0]?.productType
    if (liveType) live.productType = String(liveType).toUpperCase()
  } catch (err) {
    live.read = 'failed'
    live.error = err instanceof Error ? err.message : String(err)
  }
  return live
}

export type AmazonPriceOfferPlan =
  /** Send this ONE merge instead of the builder's replace. */
  | { kind: 'merge'; patch: { op: 'merge'; path: '/attributes/purchasable_offer'; value: Array<Record<string, unknown>> } }
  /** No live instance in this market: the builder's replace goes as it always has (it creates the offer). */
  | { kind: 'first-offer' }
  /** Nothing is sent, and the row says why (terminal: a person has to look). */
  | { kind: 'refused'; reason: string }

/**
 * A price push against the live offer. The instance it prices is this market's default-audience (`ALL`) offer in the
 * currency Nexus prices the market in; `built` is the one instance the builder made.
 *
 * The merge carries that instance's selectors, `our_price`, and the sale only as far as Nexus owns it:
 *   - the builder carries `discounted_price` (Nexus's sale: a value with both dates) → it is sent, as before;
 *   - a person removed Nexus's own sale (`saleRemoved`, set by `writeChannelPrices`) and Amazon still shows a sale →
 *     `discounted_price: null`, the documented delete;
 *   - otherwise nothing: the sale Amazon holds (Seller Central, or none) is left as it is.
 * Every other sub-attribute and every other instance is left out of the patch, so Amazon keeps it.
 *
 * Instances in this market, but none that is the default audience in Nexus's currency → refused: a merge would name an
 * instance that is not there, and a replace would erase the ones that are.
 */
export function amazonPriceOfferPlan(input: {
  built: Record<string, unknown>
  /** `AmazonOfferLiveRead.instances` of a successful read. */
  live: ReadonlyArray<Record<string, unknown>>
  /** The Amazon marketplace id the push goes to. */
  marketplaceId: string
  saleRemoved: boolean
}): AmazonPriceOfferPlan {
  const { built, marketplaceId } = input
  const currency = String(built.currency ?? '').toUpperCase()
  // The read is scoped to this market (?marketplaceIds), so an instance that names no market is this market's.
  const here = input.live.filter((x) => x.marketplace_id == null || x.marketplace_id === marketplaceId)
  if (here.length === 0) return { kind: 'first-offer' }
  const audienceOf = (x: Record<string, unknown>) => String(x.audience ?? 'ALL').toUpperCase()
  const target = here.find((x) => audienceOf(x) === 'ALL' && (x.currency == null || String(x.currency).toUpperCase() === currency))
  if (!target) {
    const held = here.map((x) => `${audienceOf(x)} in ${String(x.currency ?? 'no currency')}`).join(', ')
    return { kind: 'refused', reason: `Amazon holds this market's offer as ${held}, but Nexus prices it for all buyers in ${currency}, so the price was not sent. Check the offer in Seller Central.` }
  }
  const value: Record<string, unknown> = {
    currency: target.currency ?? built.currency,
    audience: target.audience ?? 'ALL',
    marketplace_id: marketplaceId,
    our_price: built.our_price,
  }
  if (built.discounted_price != null) value.discounted_price = built.discounted_price
  else if (input.saleRemoved && target.discounted_price != null) value.discounted_price = null
  return { kind: 'merge', patch: { op: 'merge', path: '/attributes/purchasable_offer', value: [value] } }
}
