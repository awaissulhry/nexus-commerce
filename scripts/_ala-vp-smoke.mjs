#!/usr/bin/env node
// READ-ONLY smoke test for ALA Phase 3 — proves Amazon's VALIDATION_PREVIEW mode
// (mode=VALIDATION_PREVIEW) works against a real listing and catches a bad value,
// WITHOUT writing anything (preview never commits). Mirrors validateListing's
// PATCH path (JSON Patch RFC 6902). Pulls one real Amazon SKU from the DB.
//
// Run: node scripts/_ala-vp-smoke.mjs
import { PrismaClient } from '@prisma/client'
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
config({ path: join(here, '..', '.env') })
const prisma = new PrismaClient()

const MP = { IT: 'APJ6JRA9NG5V4', DE: 'A1PA6795UKMFR9', FR: 'A13V1IB3VIYZZH', ES: 'A1RKKUPIHCS9HS', UK: 'A1F83G8C2ARO7P' }

const clientId = process.env.AMAZON_LWA_CLIENT_ID
const clientSecret = process.env.AMAZON_LWA_CLIENT_SECRET
const refreshToken = process.env.AMAZON_REFRESH_TOKEN
const sellerId = process.env.AMAZON_SELLER_ID
const region = (process.env.AMAZON_REGION ?? 'eu').toLowerCase()
const host = `sellingpartnerapi-${region}.amazon.com`
if (!clientId || !clientSecret || !refreshToken || !sellerId) {
  console.error('Missing AMAZON creds in .env'); process.exit(1)
}

// Find one Amazon listing whose product has a known productType + an IT/DE/etc market.
const listing = await prisma.channelListing.findFirst({
  where: { channel: 'AMAZON', marketplace: { in: Object.keys(MP) }, product: { deletedAt: null, sku: { not: '' } } },
  select: { marketplace: true, product: { select: { sku: true, productType: true, name: true } } },
  orderBy: { updatedAt: 'desc' },
})
await prisma.$disconnect()
if (!listing?.product?.sku) { console.log('no Amazon listing found to smoke-test'); process.exit(0) }

const { sku, productType, name } = listing.product
const mkt = listing.marketplace
const mpId = MP[mkt]
console.log(`Smoke target: sku=${sku} market=${mkt} productType=${productType}\n`)

const tokenRes = await fetch('https://api.amazon.com/auth/o2/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
})
if (!tokenRes.ok) { console.error('LWA failed:', await tokenRes.text()); process.exit(1) }
const accessToken = (await tokenRes.json()).access_token

async function preview(label, itemName) {
  const url = `https://${host}/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}`
    + `?marketplaceIds=${mpId}&mode=VALIDATION_PREVIEW`
  const patches = [{
    op: 'replace',
    path: '/attributes/item_name',
    value: [{ value: itemName, language_tag: 'it_IT', marketplace_id: mpId }],
  }]
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ productType, patches }),
  })
  const body = await r.json().catch(() => ({}))
  const issues = body.issues ?? []
  const errs = issues.filter((i) => (i.severity ?? 'ERROR').toUpperCase() === 'ERROR')
  console.log(`── ${label} ──`)
  console.log(`  HTTP ${r.status}  status=${body.status ?? '?'}  issues=${issues.length} (errors=${errs.length})`)
  for (const i of issues.slice(0, 6)) {
    console.log(`    [${i.severity}] ${i.code}: ${String(i.message).slice(0, 110)}${i.attributeNames ? ` {${i.attributeNames.join(',')}}` : ''}`)
  }
  return { status: r.status, errs: errs.length }
}

// 1) A reasonable title — should not produce a length error.
const good = await preview('GOOD title (current/short)', (name ?? 'Test').slice(0, 80))
// 2) A deliberately over-length title — should produce a validation/length error,
//    proving the preview catches what our pre-check would block. NOT written (preview).
const bad = await preview('BAD title (600 chars, over byte cap)', 'À'.repeat(600))

console.log('\n── verdict ──')
console.log(`  VALIDATION_PREVIEW reachable:        ${good.status === 200 || good.status === 207 ? 'YES' : `NO (HTTP ${good.status})`}`)
console.log(`  caught the over-length title:        ${bad.errs > 0 ? 'YES (errors returned)' : 'no errors (check schema cap)'}`)
console.log('  (no writes — mode=VALIDATION_PREVIEW never commits)')
