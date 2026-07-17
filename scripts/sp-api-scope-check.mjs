#!/usr/bin/env node
// SP-API role/scope probe — calls one canary endpoint per SP-API role
// and reports which ones the current AMAZON_REFRESH_TOKEN can access.
//
// LWA refresh tokens are opaque (not JWT — can't decode scope locally),
// so the only way to determine effective scope is to actually call the
// SP-API and observe 200 vs 403/Access-denied per endpoint.
//
// Reads creds from .env. Read-only — no DB writes, no side effects.

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const clientId = process.env.AMAZON_LWA_CLIENT_ID
const clientSecret = process.env.AMAZON_LWA_CLIENT_SECRET
const refreshToken = process.env.AMAZON_REFRESH_TOKEN
const sellerId = process.env.AMAZON_SELLER_ID
const region = (process.env.AMAZON_REGION ?? 'eu').toLowerCase()
const marketplaceId = process.env.AMAZON_MARKETPLACE_ID ?? 'APJ6JRA9NG5V4'

const slugMap = (r) => {
  if (r === 'na' || r === 'eu' || r === 'fe') return r
  if (r.startsWith('us-') || r.startsWith('ca-')) return 'na'
  if (r.startsWith('ap-')) return 'fe'
  if (r.startsWith('eu-') || r.startsWith('me-') || r.startsWith('af-')) return 'eu'
  return 'na'
}
const host = `sellingpartnerapi-${slugMap(region)}.amazon.com`

if (!clientId || !clientSecret || !refreshToken) {
  console.error('Missing LWA env vars'); process.exit(1)
}

// ── 1. LWA refresh ──────────────────────────────────────────────────
console.log('\n━━━ Step 1: LWA token refresh ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
const tokenRes = await fetch('https://api.amazon.com/auth/o2/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  }).toString(),
})
if (!tokenRes.ok) {
  console.error('LWA refresh failed:', await tokenRes.text())
  process.exit(1)
}
const tokenData = await tokenRes.json()
const accessToken = tokenData.access_token
console.log(`  ✅ access_token (${accessToken.length} chars), expires_in=${tokenData.expires_in}s`)
console.log(`  scope field in response: ${tokenData.scope ?? '(not provided — typical for SP-API tokens)'}`)

// ── 2. Probe each SP-API role ──────────────────────────────────────
console.log(`\n━━━ Step 2: Role probes (host: ${host}) ━━━━━━━━━━━━━━━━━━━━━━`)

// Pull a real ASIN + SKU from DB for the catalog/listings probes
const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()
const productRow = await c.query(`
  SELECT sku, "amazonAsin" FROM "Product"
  WHERE "amazonAsin" IS NOT NULL AND sku IS NOT NULL
  LIMIT 1
`)
await c.end()
const probeSku = productRow.rows[0]?.sku ?? 'NONE'
const probeAsin = productRow.rows[0]?.amazonAsin ?? 'B000NONE'
console.log(`  using probe SKU=${probeSku}, ASIN=${probeAsin} for catalog/listings probes\n`)

const probes = [
  {
    role: '(none — universal)',
    label: 'Sellers — getMarketplaceParticipations',
    path: '/sellers/v1/marketplaceParticipations',
    query: '',
  },
  {
    role: 'Inventory and Order Tracking',
    label: 'Orders v0 — getOrders',
    path: '/orders/v0/orders',
    query: `?MarketplaceIds=${marketplaceId}&CreatedAfter=${new Date(Date.now() - 7 * 86400_000).toISOString()}&MaxResultsPerPage=1`,
  },
  {
    role: 'Inventory and Order Tracking',
    label: 'FBA Inventory — getInventorySummaries',
    path: '/fba/inventory/v1/summaries',
    query: `?marketplaceIds=${marketplaceId}&granularityType=Marketplace&granularityId=${marketplaceId}&details=false`,
  },
  {
    role: 'Pricing',
    label: 'Pricing v0 — getItemOffers',
    path: `/products/pricing/v0/items/${probeAsin}/offers`,
    query: `?MarketplaceId=${marketplaceId}&ItemCondition=New`,
  },
  {
    role: 'Product Listing',
    label: 'Listings 2021-08-01 — getListingsItem',
    path: `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(probeSku)}`,
    query: `?marketplaceIds=${marketplaceId}&includedData=summaries`,
  },
  {
    role: 'Reports/Catalogs/Listings',
    label: 'Reports 2021-06-30 — getReports (settlement)',
    path: '/reports/2021-06-30/reports',
    query: `?reportTypes=GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2&pageSize=10`,
  },
  {
    role: '★ Finance and Accounting ★',
    label: 'Finances v0 — listFinancialEvents',
    path: '/finances/v0/financialEvents',
    query: `?PostedAfter=${new Date(Date.now() - 7 * 86400_000).toISOString()}&MaxResultsPerPage=10`,
  },
  {
    role: '★ Finance and Accounting ★',
    label: 'Finances 2024-06-19 — listTransactions',
    path: '/finances/2024-06-19/transactions',
    query: `?postedAfter=${new Date(Date.now() - 7 * 86400_000).toISOString()}&marketplaceId=${marketplaceId}`,
  },
  {
    role: '★ Brand Analytics — DATA KIOSK (R1) ★',
    label: 'Data Kiosk 2023-11-15 — getQueries',
    path: '/dataKiosk/2023-11-15/queries',
    query: '?pageSize=10',
  },
]

const summary = []
for (const p of probes) {
  const url = `https://${host}${p.path}${p.query}`
  let status, body
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: {
        'x-amz-access-token': accessToken,
        'Content-Type': 'application/json',
      },
    })
    status = r.status
    body = await r.text()
  } catch (e) {
    status = 0
    body = e.message
  }

  let verdict, hint
  if (status === 200) {
    verdict = '✅ OK'
    hint = ''
  } else if (status === 403) {
    verdict = '❌ 403'
    if (body.includes('denied') || body.includes('Access')) {
      hint = 'role not granted'
    } else if (body.includes('Unauthorized')) {
      hint = 'role granted but other auth issue'
    } else {
      hint = ''
    }
  } else if (status === 404) {
    verdict = '⚠ 404'
    hint = 'endpoint OK but resource not found (role likely granted)'
  } else if (status === 400) {
    verdict = '⚠ 400'
    hint = 'bad request — role likely granted but params wrong'
  } else if (status === 429) {
    verdict = '⏳ 429'
    hint = 'throttled — try again'
  } else {
    verdict = `? ${status}`
    hint = body.slice(0, 80)
  }

  console.log(`  ${verdict.padEnd(8)} ${p.label}`)
  console.log(`           role: ${p.role}`)
  if (status !== 200 && body) {
    let parsed
    try { parsed = JSON.parse(body) } catch { parsed = body }
    const errMsg =
      parsed?.errors?.[0]?.message ?? parsed?.message ?? String(parsed).slice(0, 200)
    console.log(`           → ${errMsg}`)
  }
  if (hint) console.log(`           hint: ${hint}`)
  console.log('')
  summary.push({ role: p.role, label: p.label, status, verdict })
}

console.log(`\n━━━ Summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
const granted = summary.filter(s => s.status === 200 || s.status === 400 || s.status === 404).map(s => s.role)
const denied = summary.filter(s => s.status === 403).map(s => s.role)
console.log('Granted roles (endpoint returned 200 or expected 4xx):')
console.log('  ' + [...new Set(granted)].join(', '))
console.log('Denied roles (endpoint returned 403):')
console.log('  ' + ([...new Set(denied)].join(', ') || '(none)'))
console.log('')
if (denied.length > 0) {
  console.log('FIX: Re-authorize the SP-API app in Seller Central to mint a new')
  console.log('refresh token with the currently-checked role set. If denied roles')
  console.log('include "Finance and Accounting" and that role is NOT visible as a')
  console.log('checkbox in your app config, you need to request the role via Amazon')
  console.log('(Developer Central → Request additional roles, or a case via Seller')
  console.log('Central Help).')
}
