/** READ-ONLY: live per-marketplace quantity for the pilot SKU, with error surfacing. */
import '../src/env.js'
console.log('env check: SELLER_ID set =', Boolean(process.env.AMAZON_SELLER_ID ?? process.env.AMAZON_MERCHANT_ID),
  '| LWA set =', Boolean(process.env.AMAZON_LWA_CLIENT_ID ?? process.env.AMAZON_CLIENT_ID),
  '| REFRESH set =', Boolean(process.env.AMAZON_REFRESH_TOKEN))
const { AmazonService } = await import('../src/services/marketplaces/amazon.service.js')
const svc = new AmazonService()
const MP = { IT: 'APJ6JRA9NG5V4', DE: 'A1PA6795UKMFR9' } as const
const SKU = process.argv[2] ?? 'VENTRA-JACKET-XS-RED-WOMEN'
for (const [mkt, mid] of Object.entries(MP)) {
  try {
    const live = await svc.fetchListingForFlatFile(SKU, mid)
    if (!live) { console.log(`${mkt}: null (not found or API error)`); continue }
    const fa = (live.attributes as any)?.fulfillment_availability
    console.log(`${mkt}: asin=${live.asin} status=${live.listingStatus} fa=${JSON.stringify(fa)}`)
  } catch (e) {
    console.log(`${mkt}: ERROR ${e instanceof Error ? e.message : String(e)}`)
  }
}
process.exit(0)
