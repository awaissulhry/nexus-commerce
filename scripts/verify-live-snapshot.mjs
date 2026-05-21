#!/usr/bin/env node
/**
 * AR.5 — end-to-end verification of the Global Snapshot live pipeline.
 *
 * Runs four checks against prod (or any NEXUS_API_URL):
 *
 *   1. SSE endpoint /api/orders/events responds + sends heartbeats
 *   2. /api/dashboard/global-snapshot returns the AR-series shape
 *      (period, sales, openOrders, marketplace, availableMarketplaces,
 *      sales.total.pending)
 *   3. /api/dashboard/sales-reconciliation responds for yesterday
 *   4. Per-marketplace scoping actually filters (compare ALL vs IT
 *      totals — IT total must be <= ALL total, and IT-only request
 *      shouldn't include other markets' rows)
 *
 * Read-only. Doesn't create orders — proves the pipeline is alive,
 * not that a specific event triggers a refresh (auth-gated Playwright
 * handles that).
 *
 * Usage:
 *   NEXUS_API_URL=https://nexusapi-production-b7bb.up.railway.app \
 *     node scripts/verify-live-snapshot.mjs
 */

import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const BACKEND = process.env.NEXUS_API_URL ?? 'http://localhost:3001'

function ok(label) { console.log(`  ✓ ${label}`) }
function fail(label, detail) { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); process.exitCode = 1 }

console.log(`[verify-live-snapshot] base: ${BACKEND}\n`)

// ── 1. SSE endpoint ──────────────────────────────────────────────────
console.log('1. SSE endpoint /api/orders/events')
{
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 3000)
  try {
    const res = await fetch(`${BACKEND}/api/orders/events`, {
      signal: ac.signal,
      headers: { Accept: 'text/event-stream' },
    })
    clearTimeout(t)
    const ct = res.headers.get('content-type') ?? ''
    if (res.ok && ct.includes('text/event-stream')) ok('SSE stream content-type correct')
    else fail(`SSE not text/event-stream`, `${res.status} ${ct}`)
    // Try to read at least the ping or heartbeat
    const reader = res.body?.getReader()
    if (reader) {
      const { value } = await Promise.race([
        reader.read(),
        new Promise((r) => setTimeout(() => r({ value: null }), 2000)),
      ])
      if (value && value.length > 0) ok('SSE stream emitted at least one frame within 2s')
      else fail('SSE stream silent for 2s')
      try { reader.cancel() } catch {}
    }
  } catch (e) {
    fail('SSE request failed', e.message)
  }
}

// ── 2. Snapshot shape ────────────────────────────────────────────────
console.log('\n2. /api/dashboard/global-snapshot shape')
{
  try {
    const res = await fetch(`${BACKEND}/api/dashboard/global-snapshot?period=today`)
    const d = await res.json()
    if (d.period?.timezone === 'Europe/Rome') ok('period.timezone = Europe/Rome (IT business day)')
    else fail('period.timezone not Europe/Rome', String(d.period?.timezone))
    if (Array.isArray(d.availableMarketplaces)) ok(`availableMarketplaces: ${d.availableMarketplaces.join(', ') || '(none)'}`)
    else fail('availableMarketplaces missing')
    if ('marketplace' in d) ok(`marketplace scope echoed: ${d.marketplace ?? '(all)'}`)
    else fail('marketplace field missing')
    if (typeof d.sales?.total?.valueCents === 'number') ok(`sales.total.valueCents = ${d.sales.total.valueCents}`)
    else fail('sales.total.valueCents missing/wrong type')
    if (d.sales?.total?.pending !== undefined) ok(`sales.total.pending.count = ${d.sales.total.pending.count}`)
    else fail('sales.total.pending missing')
    if (Array.isArray(d.sales?.sparkline) && d.sales.sparkline.length === 7) ok('sales.sparkline: 7 days')
    else fail(`sales.sparkline length ${d.sales?.sparkline?.length}`)
    if (typeof d.openOrders?.total === 'number') ok(`openOrders.total = ${d.openOrders.total}`)
    else fail('openOrders.total missing')
  } catch (e) {
    fail('snapshot request failed', e.message)
  }
}

// ── 3. Reconciliation ────────────────────────────────────────────────
console.log('\n3. /api/dashboard/sales-reconciliation (yesterday)')
{
  try {
    const res = await fetch(`${BACKEND}/api/dashboard/sales-reconciliation`)
    const d = await res.json()
    if (['match', 'drift', 'no-report', 'no-orders'].includes(d.status)) {
      ok(`reconciliation status: ${d.status} — ${d.label}`)
    } else {
      fail('reconciliation status not in expected set', d.status)
    }
  } catch (e) {
    fail('reconciliation request failed', e.message)
  }
}

// ── 4. Marketplace scope filter ─────────────────────────────────────
console.log('\n4. Marketplace scope (ALL vs IT)')
{
  try {
    const [allRes, itRes] = await Promise.all([
      fetch(`${BACKEND}/api/dashboard/global-snapshot?period=today`).then((r) => r.json()),
      fetch(`${BACKEND}/api/dashboard/global-snapshot?period=today&marketplace=IT`).then((r) => r.json()),
    ])
    const allTotal = allRes.sales?.total?.valueCents ?? 0
    const itTotal = itRes.sales?.total?.valueCents ?? 0
    if (itTotal <= allTotal) ok(`IT total (${itTotal}) <= ALL total (${allTotal})`)
    else fail(`IT total exceeded ALL: ${itTotal} > ${allTotal}`)
    const itRows = (itRes.sales?.byMarketplace ?? []).filter((r) => r.marketplace !== 'IT')
    if (itRows.length === 0) ok('IT-scoped response contains only IT rows')
    else fail(`IT-scoped response includes non-IT rows: ${itRows.map((r) => r.marketplace).join(', ')}`)
    if (itRes.marketplace === 'IT') ok('marketplace echoed as IT')
    else fail(`marketplace echo wrong: ${itRes.marketplace}`)
  } catch (e) {
    fail('scope check failed', e.message)
  }
}

console.log(process.exitCode ? '\n✗ verification failed' : '\n✓ all checks passed')
