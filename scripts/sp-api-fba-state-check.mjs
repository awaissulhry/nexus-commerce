#!/usr/bin/env node
// READ-ONLY: ask Amazon (getListingsItem) what fulfillment state the suspected
// flipped listings actually show right now. No writes. Confirms FBA vs FBM
// (DEFAULT) before any recovery, and validates the un-flip target.
//
// Run: node scripts/sp-api-fba-state-check.mjs
import dotenv from 'dotenv'; import path from 'path'; import { fileURLToPath } from 'url'
const here = path.dirname(fileURLToPath(import.meta.url)); dotenv.config({ path: path.join(here, '..', '.env') })

const clientId = process.env.AMAZON_LWA_CLIENT_ID
const clientSecret = process.env.AMAZON_LWA_CLIENT_SECRET
const refreshToken = process.env.AMAZON_REFRESH_TOKEN
const sellerId = process.env.AMAZON_SELLER_ID
const region = (process.env.AMAZON_REGION ?? 'eu').toLowerCase()
const host = `sellingpartnerapi-${region}.amazon.com`
if (!clientId || !clientSecret || !refreshToken || !sellerId) {
  console.error('Missing AMAZON_LWA_CLIENT_ID / _SECRET / AMAZON_REFRESH_TOKEN / AMAZON_SELLER_ID in .env'); process.exit(1)
}

const MP = { IT: 'APJ6JRA9NG5V4', DE: 'A1PA6795UKMFR9', FR: 'A13V1IB3VIYZZH', ES: 'A1RKKUPIHCS9HS', UK: 'A1F83G8C2ARO7P' }
// Canary set — the SKUs the audit flagged as flipped.
const CANARIES = [
  ['GALE-JACKET-BLACK-MEN-4XL', 'IT'],
  ['GALE-JACKET-BLACK-MEN-4XL', 'DE'],
  ['GALE-JACKET-BLACK-MEN-4XL', 'ES'],
  ['GALE-JACKET-YELLOW-MEN-XL', 'IT'],
]

// LWA refresh
const tokenRes = await fetch('https://api.amazon.com/auth/o2/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
})
if (!tokenRes.ok) { console.error('LWA refresh failed:', await tokenRes.text()); process.exit(1) }
const accessToken = (await tokenRes.json()).access_token
console.log(`LWA ok. host=${host} seller=${sellerId}\n`)

for (const [sku, mkt] of CANARIES) {
  const mpId = MP[mkt]
  const url = `https://${host}/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}`
    + `?marketplaceIds=${mpId}&includedData=summaries,offers,fulfillmentAvailability,issues`
  try {
    const r = await fetch(url, { headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' } })
    const body = await r.json()
    if (!r.ok) { console.log(`${sku} [${mkt}]  HTTP ${r.status}  ${JSON.stringify(body).slice(0, 200)}`); continue }
    const fa = body.fulfillmentAvailability ?? []
    const faStr = fa.length ? fa.map((f) => `${f.fulfillmentChannelCode}${f.quantity != null ? `(qty ${f.quantity})` : ''}`).join(',') : '(none)'
    const offers = body.offers ?? []
    const offerCh = offers.map((o) => o.offerType ?? o.fulfillmentChannelCode ?? '?').join(',') || '(no offers)'
    const status = (body.summaries ?? []).map((s) => s.status?.join('/') ?? '?').join(',')
    // Heuristic verdict
    const isFbm = fa.some((f) => String(f.fulfillmentChannelCode).toUpperCase() === 'DEFAULT')
    const isFba = fa.some((f) => String(f.fulfillmentChannelCode).toUpperCase().startsWith('AMAZON'))
    const verdict = isFbm ? '🔴 FBM (DEFAULT)' : isFba ? '✅ FBA' : '⚠️ unclear'
    console.log(`${sku} [${mkt}]  ${verdict}   fulfillmentAvailability=[${faStr}]  offers=[${offerCh}]  status=${status}`)
  } catch (e) {
    console.log(`${sku} [${mkt}]  ERROR ${e.message}`)
  }
}
console.log('\nDone (read-only — no writes).')
