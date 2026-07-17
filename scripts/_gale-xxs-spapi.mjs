// READ-ONLY: check current Amazon state for XXS + XS Gale SKUs — listings + FBA inventory
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
const here = path.dirname(fileURLToPath(import.meta.url)); dotenv.config({ path: path.join(here, '..', '.env') })

const clientId = process.env.AMAZON_LWA_CLIENT_ID
const clientSecret = process.env.AMAZON_LWA_CLIENT_SECRET
const refreshToken = process.env.AMAZON_REFRESH_TOKEN
const sellerId = process.env.AMAZON_SELLER_ID
const region = (process.env.AMAZON_REGION ?? 'eu').toLowerCase()
const host = `sellingpartnerapi-${region}.amazon.com`
if (!clientId || !clientSecret || !refreshToken || !sellerId) {
  console.error('Missing env vars. Checking what is set:')
  console.error({ clientId: !!clientId, clientSecret: !!clientSecret, refreshToken: !!refreshToken, sellerId: !!sellerId })
  process.exit(1)
}

const MP_IT = 'APJ6JRA9NG5V4'

// LWA token
const tokenRes = await fetch('https://api.amazon.com/auth/o2/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
})
if (!tokenRes.ok) { console.error('LWA refresh failed:', await tokenRes.text()); process.exit(1) }
const { access_token: tok } = await tokenRes.json()
console.log(`LWA ok. seller=${sellerId}\n`)

const H = { 'x-amz-access-token': tok, 'Content-Type': 'application/json' }

const SKUS = ['GALE-JACKET-BLACK-MEN-XXS', 'GALE-JACKET-YELLOW-MEN-XXS', 'GALE-JACKET-BLACK-MEN-XS', 'GALE-JACKET-YELLOW-MEN-XS']

// 1) Listings Items API — current attributes per SKU
console.log('════════════ Listings Items (IT) ════════════')
for (const sku of SKUS) {
  const url = `https://${host}/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}`
    + `?marketplaceIds=${MP_IT}&includedData=summaries,attributes,issues,fulfillmentAvailability`
  const r = await fetch(url, { headers: H })
  const body = await r.json()
  if (!r.ok) {
    console.log(`\n${sku}: HTTP ${r.status}  ${JSON.stringify(body).slice(0, 200)}`)
    continue
  }
  const summaries = body.summaries ?? []
  const status = summaries.map((s) => `${s.marketplaceId}: status=${JSON.stringify(s.status)}`).join(' | ')
  const fa = body.fulfillmentAvailability ?? []
  const faStr = fa.map((f) => `${f.fulfillmentChannelCode}(qty=${f.quantity})`).join(' ')
  const attrs = body.attributes ?? {}
  const asin = summaries[0]?.asin ?? '—'
  const fn = attrs.fulfillment_availability?.[0]?.fulfillment_channel_code ?? '—'
  const size = JSON.stringify(attrs.size ?? attrs.apparel_size ?? '—').slice(0, 60)
  const parentageLvl = JSON.stringify(attrs.parentage_level ?? '—').slice(0, 40)
  const parentSku = JSON.stringify(attrs.child_parent_sku_relationship ?? '—').slice(0, 80)
  const msa = JSON.stringify(attrs.merchant_suggested_asin ?? '—').slice(0, 80)
  const issues = body.issues ?? []
  console.log(`\n── ${sku} ──`)
  console.log(`  ASIN=${asin}  fulfillment=[${faStr}]`)
  console.log(`  status: ${status}`)
  console.log(`  size: ${size}`)
  console.log(`  parentage_level: ${parentageLvl}`)
  console.log(`  child_parent_sku_relationship: ${parentSku}`)
  console.log(`  merchant_suggested_asin: ${msa}`)
  if (issues.length) {
    for (const i of issues) console.log(`  ISSUE [${i.severity}] ${i.code}: ${i.message?.slice(0, 120)} {${(i.attributeNames ?? []).join(',')}}`)
  }
}

// 2) FBA Inventory — get FNSKUs
console.log('\n════════════ FBA Inventory Summaries ════════════')
let nextToken
const fnskuMap = {}
let page = 0
do {
  const url = new URL(`https://${host}/fba/inventory/v1/summaries`)
  url.searchParams.set('details', 'true')
  url.searchParams.set('granularityType', 'Marketplace')
  url.searchParams.set('granularityId', MP_IT)
  url.searchParams.set('marketplaceIds', MP_IT)
  if (nextToken) url.searchParams.set('nextToken', nextToken)
  const r = await fetch(url.toString(), { headers: H })
  if (!r.ok) { console.error('FBA inventory API failed:', r.status, await r.text().catch(() => '')); break }
  const body = await r.json()
  const items = body.payload?.inventorySummaries ?? []
  for (const it of items) {
    if (it.sellerSku && it.fnSku) fnskuMap[it.sellerSku] = { fnsku: it.fnSku, asin: it.asin, totalQty: it.totalQuantity }
  }
  nextToken = body.payload?.nextToken
  page++
  if (page > 20) break // safety
} while (nextToken)

for (const sku of SKUS) {
  const entry = fnskuMap[sku]
  if (entry) {
    console.log(`  ${sku}: FNSKU=${entry.fnsku}  ASIN=${entry.asin}  qty=${entry.totalQty}`)
  } else {
    console.log(`  ${sku}: (not in FBA inventory for IT marketplace)`)
  }
}
