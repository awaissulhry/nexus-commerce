/**
 * A live Amazon `purchasable_offer` for tests of the price push (queue and pricing engine), and a model of what Amazon
 * does with a patch to it — so a test checks the RESULT on the offer, not only the patch.
 *
 * The fixture is one IT offer carrying everything Nexus never sends (a Seller Central sale, map_price, the min/max
 * seller-allowed prices, the offer dates), its B2B twin, and a DE offer. All values are made up; marketplace ids are
 * Amazon's public ones.
 */
export const IT = 'APJ6JRA9NG5V4'
export const DE = 'A1PA6795UKMFR9'

export const sellerCentralSale = [{ schedule: [{ start_at: '2026-09-20', end_at: '2026-10-20', value_with_tax: 99 }] }]

export const liveOffer = (): Array<Record<string, unknown>> => [
  {
    audience: 'ALL', currency: 'EUR', marketplace_id: IT,
    our_price: [{ schedule: [{ value_with_tax: 120 }] }],
    discounted_price: sellerCentralSale,
    map_price: [{ schedule: [{ value_with_tax: 110 }] }],
    minimum_seller_allowed_price: [{ schedule: [{ value_with_tax: 90 }] }],
    maximum_seller_allowed_price: [{ schedule: [{ value_with_tax: 150 }] }],
    start_at: { value: '2026-01-01' },
    end_at: { value: '2027-12-31' },
  },
  { audience: 'B2B', currency: 'EUR', marketplace_id: IT, our_price: [{ schedule: [{ value_with_tax: 100 }] }], quantity_discount_plan: [{ schedule: [{ discount_type: 'percent', levels: [{ lower_bound: 5, value: 3 }] }] }] },
  { audience: 'ALL', currency: 'EUR', marketplace_id: DE, our_price: [{ schedule: [{ value_with_tax: 125 }] }] },
]

/** A `getListingsItem` answer carrying `instances` as the live purchasable_offer (and a merchant quantity it must not touch). */
export const liveRead = (instances: unknown, sku = 'TEST-SKU-1') => ({
  success: true, sku, asin: 'TEST-ASIN-1', status: 'BUYABLE',
  rawResponse: { summaries: [{ productType: 'OUTERWEAR' }], attributes: { purchasable_offer: instances, fulfillment_availability: [{ fulfillment_channel_code: 'DEFAULT', quantity: 4 }] } },
})

/**
 * Amazon's documented patch semantics on `purchasable_offer`, as a model to check the RESULT against:
 *   merge   — on the instance its selectors name ({marketplace_id, currency, audience}), only the sub-attributes it
 *             carries change; `null` deletes one; everything else stays
 *             (https://developer-docs.amazon/sp-api/docs/manage-purchasable-offer);
 *   replace — the pessimistic reading of the op table ("adds or replaces the target property"): the attribute becomes
 *             the value sent. That is the behaviour the merge must never depend on.
 */
export function applyToOffer(live: Array<Record<string, unknown>>, patch: { op: string; value: Array<Record<string, unknown>> }) {
  if (patch.op === 'replace') return structuredClone(patch.value)
  if (patch.op !== 'merge') throw new Error(`unmodelled op ${patch.op}`)
  const key = (x: Record<string, unknown>) => `${x.marketplace_id}|${x.currency}|${x.audience ?? 'ALL'}`
  const out = structuredClone(live)
  for (const entry of patch.value) {
    const at = out.find((x) => key(x) === key(entry))
    if (!at) throw new Error(`the merge names no live instance: ${key(entry)}`)
    for (const [name, value] of Object.entries(entry)) {
      if (name === 'marketplace_id' || name === 'currency' || name === 'audience') continue
      if (value === null) delete at[name]
      else at[name] = value
    }
  }
  return out
}
