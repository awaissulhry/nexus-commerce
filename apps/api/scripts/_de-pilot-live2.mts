/** READ-ONLY: live per-marketplace qty via the raw SP-API client. */
import '../src/env.js'
const { amazonSpApiClient } = await import('../src/clients/amazon-sp-api.client.js')
const MP = { IT: 'APJ6JRA9NG5V4', DE: 'A1PA6795UKMFR9' } as const
const SKU = process.argv[2] ?? 'VENTRA-JACKET-XS-RED-WOMEN'
const sellerId = process.env.AMAZON_SELLER_ID ?? process.env.AMAZON_MERCHANT_ID ?? ''
for (const [mkt, mid] of Object.entries(MP)) {
  const r = await amazonSpApiClient.getListingsItem({
    sellerId, sku: SKU, marketplaceId: mid,
    includedData: ['summaries', 'fulfillmentAvailability'],
  } as never)
  const raw = (r as any).rawResponse
  const fa = raw?.fulfillmentAvailability ?? (raw?.attributes as any)?.fulfillment_availability
  console.log(`${mkt}: success=${r.success} asin=${r.asin} status=${r.status} error=${(r as any).error ?? '-'}`)
  console.log(`   fulfillmentAvailability=${JSON.stringify(fa)}`)
}
process.exit(0)
