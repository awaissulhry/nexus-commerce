#!/usr/bin/env node
// Phase 3b + 3c — non-destructive validation that Amazon SP-API + eBay
// OAuth credentials are working. Makes the lightest possible "are you
// alive" call per channel:
//   Amazon: LWA token exchange + GET /sellers/v1/marketplaceParticipations
//   eBay:   refresh_token grant on the verified ChannelConnection +
//           GET /commerce/identity/v1/user/
//
// NEVER logs token values. Reports success/failure + the response shape
// (marketplace count for Amazon, username prefix for eBay) so the
// operator can confirm "right account connected".

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const banner = (s) => console.log(`\n━━━ ${s} ${'━'.repeat(Math.max(0, 60 - s.length))}`)
const ok = (s) => console.log(`  ✅ ${s}`)
const fail = (s) => console.log(`  ❌ ${s}`)
const info = (s) => console.log(`  · ${s}`)

let allPassed = true

// ───────────────────────────────────────────────────────────────────
// Amazon SP-API validation
// ───────────────────────────────────────────────────────────────────
banner('Amazon SP-API — LWA refresh + getMarketplaceParticipations')

async function validateAmazon() {
  const clientId = process.env.AMAZON_LWA_CLIENT_ID
  const clientSecret = process.env.AMAZON_LWA_CLIENT_SECRET
  const refreshToken = process.env.AMAZON_REFRESH_TOKEN
  const sellerId = process.env.AMAZON_SELLER_ID
  const region = (process.env.AMAZON_REGION || 'eu').toLowerCase()

  // Map AWS region → SP-API slug if needed
  const slugMap = (r) => {
    if (r === 'na' || r === 'eu' || r === 'fe') return r
    if (r.startsWith('us-') || r.startsWith('ca-')) return 'na'
    if (r.startsWith('ap-')) return 'fe'
    if (r.startsWith('eu-') || r.startsWith('me-') || r.startsWith('af-')) return 'eu'
    return 'na'
  }
  const spApiSlug = slugMap(region)
  const host = `sellingpartnerapi-${spApiSlug}.amazon.com`

  info(`env: clientId=${clientId ? 'set' : 'MISSING'}, secret=${clientSecret ? 'set' : 'MISSING'}, refreshToken=${refreshToken ? 'set' : 'MISSING'}, sellerId=${sellerId || 'MISSING'}`)
  info(`region: ${region} → SP-API slug ${spApiSlug} → host ${host}`)

  if (!clientId || !clientSecret || !refreshToken) {
    fail('LWA credentials incomplete in .env')
    return false
  }

  // Step 1: LWA token exchange
  let accessToken
  try {
    const r = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    })
    if (!r.ok) {
      const text = await r.text()
      fail(`LWA token refresh failed (HTTP ${r.status}): ${text.slice(0, 300)}`)
      return false
    }
    const data = await r.json()
    accessToken = data.access_token
    ok(`LWA token refreshed (expires in ${data.expires_in}s, type=${data.token_type})`)
  } catch (e) {
    fail(`LWA token refresh threw: ${e.message}`)
    return false
  }

  // Step 2: getMarketplaceParticipations
  try {
    const r = await fetch(`https://${host}/sellers/v1/marketplaceParticipations`, {
      method: 'GET',
      headers: {
        'x-amz-access-token': accessToken,
        'Content-Type': 'application/json',
      },
    })
    if (!r.ok) {
      const text = await r.text()
      fail(`getMarketplaceParticipations failed (HTTP ${r.status}): ${text.slice(0, 400)}`)
      return false
    }
    const data = await r.json()
    const payload = data.payload || []
    ok(`Connected to ${payload.length} marketplace(s):`)
    payload.forEach(p => {
      const m = p.marketplace || {}
      const part = p.participation || {}
      console.log(`     · ${m.id || '?'} (${m.countryCode || '?'}) "${m.name || '?'}" — hasSuspendedListings=${part.hasSuspendedListings ?? '?'}, isParticipating=${part.isParticipating ?? '?'}`)
    })
    return true
  } catch (e) {
    fail(`getMarketplaceParticipations threw: ${e.message}`)
    return false
  }
}

const amazonOk = await validateAmazon()
if (!amazonOk) allPassed = false

// ───────────────────────────────────────────────────────────────────
// eBay validation
// ───────────────────────────────────────────────────────────────────
banner('eBay — refresh_token grant + identity check')

async function validateEbay() {
  const clientId = process.env.EBAY_CLIENT_ID
  const clientSecret = process.env.EBAY_CLIENT_SECRET
  const env = process.env.EBAY_ENVIRONMENT || 'PRODUCTION'
  const apiBase = env === 'SANDBOX' ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com'

  info(`env: clientId=${clientId ? 'set' : 'MISSING'}, secret=${clientSecret ? 'set' : 'MISSING'}, environment=${env}`)
  info(`apiBase: ${apiBase}`)

  if (!clientId || !clientSecret) {
    fail('eBay app credentials missing')
    return false
  }

  // Pull the verified eBay connection from DB
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await c.connect()
  let refreshToken, displayName, connectionId
  try {
    const r = await c.query(`
      SELECT id, "displayName", "refreshToken", "ebayRefreshToken", "tokenExpiresAt"
      FROM "ChannelConnection"
      WHERE "channelType" = 'EBAY'
        AND ("refreshToken" IS NOT NULL OR "ebayRefreshToken" IS NOT NULL)
      ORDER BY "createdAt" DESC LIMIT 1
    `)
    if (r.rows.length === 0) {
      fail('No eBay ChannelConnection with a refresh token found in DB')
      return false
    }
    const row = r.rows[0]
    refreshToken = row.refreshToken || row.ebayRefreshToken
    displayName = row.displayName
    connectionId = row.id
    info(`using connection ${connectionId} (displayName="${displayName}")`)
  } finally {
    await c.end()
  }

  // Refresh access token
  let accessToken
  try {
    const r = await fetch(`${apiBase}/identity/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: [
          'https://api.ebay.com/oauth/api_scope',
          'https://api.ebay.com/oauth/api_scope/sell.account',
          'https://api.ebay.com/oauth/api_scope/sell.inventory',
          'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
        ].join(' '),
      }).toString(),
    })
    if (!r.ok) {
      const text = await r.text()
      fail(`eBay refresh_token grant failed (HTTP ${r.status}): ${text.slice(0, 400)}`)
      return false
    }
    const data = await r.json()
    accessToken = data.access_token
    ok(`eBay access token refreshed (expires in ${data.expires_in}s)`)
  } catch (e) {
    fail(`eBay refresh_token grant threw: ${e.message}`)
    return false
  }

  // Identity check: GET /commerce/identity/v1/user/
  try {
    const r = await fetch(`${apiBase}/commerce/identity/v1/user/`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!r.ok) {
      const text = await r.text()
      // Identity scope may not be granted; try a fulfillment-scope call instead
      info(`identity call returned HTTP ${r.status} (scope may not be granted)`)
      const r2 = await fetch(`${apiBase}/sell/fulfillment/v1/order?limit=1`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!r2.ok) {
        const text2 = await r2.text()
        fail(`Fallback fulfillment ping failed (HTTP ${r2.status}): ${text2.slice(0, 400)}`)
        return false
      }
      const d2 = await r2.json()
      ok(`Fulfillment scope verified (total orders accessible: ${d2.total ?? '?'})`)
      return true
    }
    const data = await r.json()
    const u = data?.user || data?.username || data
    const username = u?.username || u?.userId || u?.individualAccount?.firstName
    ok(`Connected as eBay user: ${typeof username === 'string' ? username : JSON.stringify(u).slice(0, 100)}`)
    return true
  } catch (e) {
    fail(`identity check threw: ${e.message}`)
    return false
  }
}

const ebayOk = await validateEbay()
if (!ebayOk) allPassed = false

// ───────────────────────────────────────────────────────────────────
// Shopify (expected: not configured)
// ───────────────────────────────────────────────────────────────────
banner('Shopify — connection inventory')

async function checkShopify() {
  const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN
  const apiKey = process.env.SHOPIFY_API_KEY

  if (!shopDomain && !accessToken && !apiKey) {
    info('No Shopify env vars set (SHOPIFY_SHOP_DOMAIN / SHOPIFY_ACCESS_TOKEN / SHOPIFY_API_KEY)')
  } else {
    info(`Shopify env: shopDomain=${shopDomain ? 'set' : 'MISSING'}, accessToken=${accessToken ? 'set' : 'MISSING'}`)
  }

  const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await c.connect()
  try {
    const r = await c.query(`SELECT count(*) AS rows FROM "ChannelConnection" WHERE "channelType" = 'SHOPIFY'`)
    info(`ChannelConnection rows with channelType=SHOPIFY: ${r.rows[0].rows}`)
  } finally {
    await c.end()
  }

  if (!shopDomain || !accessToken) {
    info('Shopify integration NOT configured. Memory says channel scope is Amazon + eBay + Shopify, so this is a gap to fill before Phase 4 if Xavia has a live Shopify store.')
    return null  // not a failure, but a flag
  }

  // Could ping /admin/api/2024-07/shop.json here if creds were present
  return true
}

await checkShopify()

// ───────────────────────────────────────────────────────────────────
banner('Summary')
console.log(`  Amazon SP-API:  ${amazonOk ? '✅ OK' : '❌ FAILED'}`)
console.log(`  eBay OAuth:     ${ebayOk ? '✅ OK' : '❌ FAILED'}`)
console.log(`  Shopify:        ⚠ not configured (out of scope unless added)`)
console.log('')
process.exit(allPassed ? 0 : 1)
