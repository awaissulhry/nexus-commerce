// READ-ONLY: ask LIVE Amazon whether AIREON jacket + pant share a parent ASIN.
// Uses getListingsItem (seller relationships) + getCatalogItem (catalog parent).
// No writes. Marketplace IT.
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const clientId = process.env.AMAZON_LWA_CLIENT_ID
const clientSecret = process.env.AMAZON_LWA_CLIENT_SECRET
const refreshToken = process.env.AMAZON_REFRESH_TOKEN
const sellerId = process.env.AMAZON_SELLER_ID
const region = (process.env.AMAZON_REGION ?? 'eu').toLowerCase()
const host = `sellingpartnerapi-${region}.amazon.com`
const MK_IT = 'APJ6JRA9NG5V4'

const tokenRes = await fetch('https://api.amazon.com/auth/o2/token', {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }).toString(),
})
const tokJson = await tokenRes.json()
const tok = tokJson.access_token
if (!tok) { console.error('NO TOKEN', tokJson); process.exit(1) }
const H = { 'x-amz-access-token': tok, 'Content-Type': 'application/json' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function listing(sku) {
  const url = `https://${host}/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}?marketplaceIds=${MK_IT}&includedData=summaries,relationships`
  const r = await fetch(url, { headers: H })
  if (!r.ok) return { sku, error: `${r.status} ${(await r.text()).slice(0,120)}` }
  const j = await r.json()
  const summ = (j.summaries ?? [])[0] ?? {}
  const rels = (j.relationships ?? []).flatMap((rg) => (rg.relationships ?? []))
  return { sku, asin: summ.asin, productType: summ.productType, status: summ.status, itemName: (summ.itemName ?? '').slice(0,40),
    relationships: rels.map((x) => ({ type: x.type, parentAsins: x.parentAsins, childAsins: (x.childAsins ?? []).length, variationTheme: x.variationTheme?.theme ?? x.variationTheme })) }
}
async function catalog(asin) {
  const url = `https://${host}/catalog/2022-04-01/items/${asin}?marketplaceIds=${MK_IT}&includedData=relationships,summaries`
  const r = await fetch(url, { headers: H })
  if (!r.ok) return { asin, error: `${r.status} ${(await r.text()).slice(0,120)}` }
  const j = await r.json()
  const rels = (j.relationships ?? []).flatMap((rg) => (rg.relationships ?? []))
  const summ = (j.summaries ?? [])[0] ?? {}
  return { asin, itemName: (summ.itemName ?? '').slice(0,40),
    relationships: rels.map((x) => ({ type: x.type, parentAsins: x.parentAsins, childCount: (x.childAsins ?? []).length, variationTheme: x.variationTheme?.theme ?? x.variationTheme })) }
}

const samples = [
  ['JACKET parent', 'XAVIA-AIREON-GIACCA-DA'],
  ['JACKET child',  'AIREON-JACKET-NERO-NEO-MEN-M'],
  ['PANT parent',   'XAVIA-AIREON-PANTALONI-MOTO'],
  ['PANT child',    'AIREON-PANT-NERO-NEO-MEN-M'],
]
console.log('=== getListingsItem (seller) relationships [IT] ===')
const asins = {}
for (const [label, sku] of samples) {
  const res = await listing(sku); await sleep(250)
  asins[label] = res.asin
  console.log(`\n${label}  sku=${sku}`)
  console.log(`  asin=${res.asin}  productType=${res.productType}  status=${JSON.stringify(res.status)}  error=${res.error ?? '—'}`)
  console.log(`  relationships=${JSON.stringify(res.relationships)}`)
}
console.log('\n=== getCatalogItem relationships [IT] (child ASINs → their parent) ===')
for (const [label, sku] of samples.filter(([l]) => l.includes('child'))) {
  const a = asins[label]; if (!a) continue
  const res = await catalog(a); await sleep(250)
  console.log(`\n${label} asin=${a}`)
  console.log(`  ${JSON.stringify(res.relationships)}  name="${res.itemName}"  error=${res.error ?? '—'}`)
}
