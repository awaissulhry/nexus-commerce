/**
 * M0 read-only probe: SP-API getMarketplaceParticipations + per-market
 * order volume count.
 *
 * Output: prints a per-marketplace table showing
 *   - participation status (auth scope)
 *   - reported store name + listing count (if available)
 *   - 365-day order count via getOrders MaxResultsPerPage=1
 *
 * Used by the multi-marketplace backfill engagement (M0 audit) to scope
 * which markets are actually reachable + how much data each holds.
 *
 * Read-only. Makes no writes.
 */

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const CLIENT_ID = process.env.AMAZON_LWA_CLIENT_ID
const CLIENT_SECRET = process.env.AMAZON_LWA_CLIENT_SECRET
const REFRESH_TOKEN = process.env.AMAZON_REFRESH_TOKEN
const REGION = process.env.AMAZON_REGION ?? 'eu'
const HOST = `sellingpartnerapi-${REGION}.amazon.com`

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  console.error('Missing SP-API LWA credentials. Need AMAZON_LWA_CLIENT_ID, AMAZON_LWA_CLIENT_SECRET, AMAZON_REFRESH_TOKEN in env.')
  process.exit(1)
}

async function getAccessToken() {
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: REFRESH_TOKEN,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }).toString(),
  })
  if (!res.ok) {
    throw new Error(`LWA token exchange failed: ${res.status} ${await res.text()}`)
  }
  const data = await res.json()
  return data.access_token
}

async function fetchParticipations(accessToken) {
  const url = `https://${HOST}/sellers/v1/marketplaceParticipations`
  const res = await fetch(url, {
    headers: { 'x-amz-access-token': accessToken },
  })
  if (!res.ok) {
    const body = await res.text()
    return { error: `${res.status} ${body.slice(0, 200)}` }
  }
  const data = await res.json()
  return { payload: data.payload ?? [] }
}

async function countOrdersForMarketplace(accessToken, marketplaceId, daysBack = 365) {
  const to = new Date(Date.now() - 180_000) // 2-min SP-API skew
  const from = new Date(to.getTime() - daysBack * 24 * 60 * 60 * 1000)
  let total = 0
  let pages = 0
  let nextToken
  // Read ALL pages to get exact count. Cap at 50 pages = 5000 orders to
  // avoid runaway; for higher-volume markets we'd want a streaming counter.
  while (pages < 50) {
    const params = new URLSearchParams(
      nextToken
        ? { NextToken: nextToken }
        : {
            MarketplaceIds: marketplaceId,
            CreatedAfter: from.toISOString(),
            CreatedBefore: to.toISOString(),
            MaxResultsPerPage: '100',
          },
    )
    const url = `https://${HOST}/orders/v0/orders?${params}`
    const res = await fetch(url, {
      headers: { 'x-amz-access-token': accessToken },
    })
    if (!res.ok) {
      const body = await res.text()
      return { error: `${res.status} ${body.slice(0, 120)}`, count: total, pages }
    }
    const data = await res.json()
    const orders = data.payload?.Orders ?? []
    total += orders.length
    pages++
    nextToken = data.payload?.NextToken
    if (!nextToken) break
    // Short pause to respect burst budget (0.0167 req/s sustained, 20 burst)
    await new Promise((r) => setTimeout(r, 2_000))
  }
  return { count: total, pages, capped: pages === 50 }
}

const MARKETPLACE_NAMES = {
  APJ6JRA9NG5V4: 'Italy (IT)',
  A1PA6795UKMFR9: 'Germany (DE)',
  A13V1IB3VIYZZH: 'France (FR)',
  A1RKKUPIHCS9HS: 'Spain (ES)',
  A1805IZSGTT6HS: 'Netherlands (NL)',
  A1F83G8C2ARO7P: 'United Kingdom (UK)',
  A1C3SOZRARQ6R3: 'Poland (PL)',
  A2NODRKZP88ZB9: 'Sweden (SE)',
  ATVPDKIKX0DER: 'United States (US)',
}

async function main() {
  console.log('=== M0 multi-marketplace probe ===')
  console.log(`Region: ${REGION}`)
  console.log(`Host: ${HOST}`)
  console.log()

  console.log('[1/3] Exchanging LWA refresh token for access token...')
  const accessToken = await getAccessToken()
  console.log('  ✓ access token acquired')
  console.log()

  console.log('[2/3] Calling getMarketplaceParticipations...')
  const result = await fetchParticipations(accessToken)
  if (result.error) {
    console.error(`  ✗ failed: ${result.error}`)
    console.error('  This usually means LWA scope does not include the "Selling Partner Insights" role.')
    process.exit(1)
  }
  const participations = result.payload
  console.log(`  ✓ ${participations.length} marketplace participations returned`)
  console.log()

  // Compose participations table.
  const rows = participations.map((p) => ({
    marketplaceId: p.marketplace?.id ?? 'NULL',
    name: p.marketplace?.name ?? MARKETPLACE_NAMES[p.marketplace?.id] ?? '?',
    country: p.marketplace?.countryCode ?? '?',
    currency: p.marketplace?.defaultCurrencyCode ?? '?',
    language: p.marketplace?.defaultLanguageCode ?? '?',
    canSell: p.participation?.isParticipating ?? false,
    hasSuspendedListings: p.participation?.hasSuspendedListings ?? false,
  }))
  console.table(rows)
  console.log()

  console.log('[3/3] Per-marketplace 365-day order count (sequential, ~2s/page)...')
  const orderCounts = []
  for (const p of rows.filter((r) => r.canSell)) {
    process.stdout.write(`  ${p.name.padEnd(28)} `)
    const start = Date.now()
    const probe = await countOrdersForMarketplace(accessToken, p.marketplaceId, 365)
    const seconds = Math.round((Date.now() - start) / 1000)
    if (probe.error) {
      console.log(`✗ ${probe.error}`)
    } else {
      const cappedNote = probe.capped ? ' (CAPPED at 5000)' : ''
      console.log(`${String(probe.count).padStart(6)} orders / ${probe.pages} pages / ${seconds}s${cappedNote}`)
    }
    orderCounts.push({
      marketplace: p.name,
      marketplaceId: p.marketplaceId,
      currency: p.currency,
      canSell: p.canSell,
      orders365d: probe.count ?? 0,
      probePages: probe.pages ?? 0,
      probeError: probe.error ?? null,
      capped: probe.capped ?? false,
    })
  }
  console.log()

  console.log('=== Per-market 365-day order volume ===')
  console.table(orderCounts)

  // Write JSON output for downstream use in the audit report.
  const fs = await import('node:fs')
  const out = path.join(here, '..', 'docs', 'multi-marketplace-2026-05-21', 'M0-probe-results.json')
  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        region: REGION,
        participations: rows,
        orderCounts,
      },
      null,
      2,
    ),
  )
  console.log()
  console.log(`Results saved → ${out}`)
}

main().catch((err) => {
  console.error('M0 probe failed:', err)
  process.exit(1)
})
