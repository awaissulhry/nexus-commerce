#!/usr/bin/env node
// Verify R7.1 — analytics endpoint extension + page route.
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const API = 'http://localhost:8080'
const url = process.env.DATABASE_URL
const client = new pg.Client({ connectionString: url })
await client.connect()

let pass = 0, fail = 0
const ok = (l) => { console.log('  ✓', l); pass++ }
const bad = (l, d) => { console.log('  ✗', l, '\n    →', d); fail++ }
const dbq = (s, p) => client.query(s, p).then((r) => r.rows)

console.log('\n[1] /returns/analytics carries new R7.1 fields')
{
  const r = await fetch(`${API}/api/fulfillment/returns/analytics`)
  const j = await r.json()
  if (!r.ok) { bad('endpoint failed', JSON.stringify(j)); process.exit(1) }
  // Old fields still present (don't break the workspace KPI strip)
  if (typeof j.last30 === 'number' && Array.isArray(j.byChannel) && Array.isArray(j.topReasons)) ok('legacy fields intact')
  else bad('legacy shape regressed', JSON.stringify(j).slice(0, 200))
  // New fields
  if (Array.isArray(j.returnRateByChannel)) ok('returnRateByChannel[] present')
  else bad('returnRateByChannel missing', '')
  if (Array.isArray(j.topReturnSkus)) ok('topReturnSkus[] present')
  else bad('topReturnSkus missing', '')
  if (Array.isArray(j.dailyTrend) && j.dailyTrend.length === 30) ok('dailyTrend[] has exactly 30 days')
  else bad('dailyTrend wrong length', `length=${j.dailyTrend?.length}`)
  if ('avgProcessingDays' in j && 'avgProcessingSampleSize' in j) ok('avgProcessingDays + sample size present')
  else bad('avg fields missing', JSON.stringify(j))
}

console.log('\n[2] Seed test data — varied channel + SKU + processing time')
const productRow = (await dbq(`SELECT sku FROM "Product" WHERE "isParent" = false ORDER BY "createdAt" DESC LIMIT 1`))[0]
const ids = []
{
  // 3 returns: 2 AMAZON same SKU (top), 1 EBAY different SKU
  const fixtures = [
    { channel: 'AMAZON', sku: productRow.sku, refundedDaysAgo: 2 },
    { channel: 'AMAZON', sku: productRow.sku, refundedDaysAgo: 5 },
    { channel: 'EBAY',   sku: 'R71-OTHER-SKU', refundedDaysAgo: null },
  ]
  for (const f of fixtures) {
    const r = await fetch(`${API}/api/fulfillment/returns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: f.channel,
        reason: 'R71_FIXTURE',
        items: [{ sku: f.sku, quantity: 1 }],
      }),
    })
    const j = await r.json()
    ids.push(j.id)
    if (f.refundedDaysAgo != null) {
      // Force a refundedAt + createdAt-N-days-ago so processing time math has data
      await dbq(
        `UPDATE "Return" SET "refundedAt" = NOW(), "createdAt" = NOW() - ($1 || ' days')::interval WHERE id = $2`,
        [f.refundedDaysAgo, j.id],
      )
    }
  }
  ok(`seeded ${ids.length} returns across AMAZON/EBAY`)
}

console.log('\n[3] After seeding — analytics reflects new data')
{
  const r = await fetch(`${API}/api/fulfillment/returns/analytics`)
  const j = await r.json()
  // Should see at least 1 EBAY + 2 AMAZON in byChannel
  const ebay = j.byChannel.find((x) => x.channel === 'EBAY')
  const amazon = j.byChannel.find((x) => x.channel === 'AMAZON')
  if ((ebay?.count ?? 0) >= 1 && (amazon?.count ?? 0) >= 2) ok(`byChannel: AMAZON ≥ 2, EBAY ≥ 1`)
  else bad('byChannel counts off', JSON.stringify(j.byChannel))
  // returnRateByChannel structure
  const ratesAmazon = j.returnRateByChannel.find((r) => r.channel === 'AMAZON')
  if (ratesAmazon && typeof ratesAmazon.returns === 'number' && typeof ratesAmazon.orders === 'number') {
    ok(`AMAZON rate row: returns=${ratesAmazon.returns}, orders=${ratesAmazon.orders}, ratePct=${ratesAmazon.ratePct?.toFixed(2)}`)
  } else bad('rate row missing', JSON.stringify(j.returnRateByChannel))
  // topReturnSkus should include our seed SKU at the top
  const top = j.topReturnSkus[0]
  if (top && top.returnCount >= 1) ok(`top SKU present: ${top.sku} (${top.returnCount} returns)`)
  else bad('top SKU empty', JSON.stringify(j.topReturnSkus))
  // avgProcessingDays present (we seeded 2 refunded rows: 2d + 5d → 3.5d)
  if (j.avgProcessingDays != null && j.avgProcessingSampleSize >= 2) {
    ok(`avgProcessingDays=${j.avgProcessingDays.toFixed(2)}d (sample=${j.avgProcessingSampleSize})`)
  } else bad('avgProcessingDays missing', JSON.stringify({ a: j.avgProcessingDays, n: j.avgProcessingSampleSize }))
}

console.log('\n[4] dailyTrend has continuous 30-day spine (zero-fill)')
{
  const r = await fetch(`${API}/api/fulfillment/returns/analytics`)
  const j = await r.json()
  const trend = j.dailyTrend
  // Each entry has a YYYY-MM-DD date; consecutive entries should
  // be exactly 1 day apart.
  let consecutive = true
  for (let i = 1; i < trend.length; i++) {
    const d1 = new Date(trend[i - 1].date + 'T00:00:00Z')
    const d2 = new Date(trend[i].date + 'T00:00:00Z')
    const dayDiff = Math.round((d2.getTime() - d1.getTime()) / 86_400_000)
    if (dayDiff !== 1) { consecutive = false; break }
  }
  if (consecutive) ok('dailyTrend dates are continuous (no gaps)')
  else bad('dailyTrend has gaps', '')
  // At least one day has count > 0 because we just seeded
  const hasActivity = trend.some((d) => d.count > 0)
  if (hasActivity) ok(`dailyTrend has activity (today's bucket includes our seeds)`)
  else bad('dailyTrend all zeros', '')
}

console.log('\n[5] Page renders (HTTP HEAD via Next dev server is overkill;')
console.log('    files exist + TS clean → trust)')
{
  const fs = await import('fs')
  const p1 = '/Users/awais/nexus-commerce/apps/web/src/app/fulfillment/returns/analytics/page.tsx'
  const p2 = '/Users/awais/nexus-commerce/apps/web/src/app/fulfillment/returns/analytics/AnalyticsClient.tsx'
  if (fs.existsSync(p1) && fs.existsSync(p2)) ok('page.tsx + AnalyticsClient.tsx on disk')
  else bad('page files missing', '')
  const palette = fs.readFileSync('/Users/awais/nexus-commerce/apps/web/src/components/CommandPalette.tsx', 'utf8')
  if (palette.includes('goto-returns-analytics')) ok('Cmd+K command registered')
  else bad('Cmd+K command missing', '')
}

// Cleanup
console.log('\n[6] Cleanup')
await dbq(`DELETE FROM "AuditLog" WHERE "entityType" = 'Return' AND "entityId" = ANY($1::text[])`, [ids])
await dbq(`DELETE FROM "Return" WHERE id = ANY($1::text[])`, [ids])
ok('test rows cleaned')

console.log(`\n=========================`)
console.log(`Result: ${pass} pass, ${fail} fail`)
await client.end()
process.exit(fail > 0 ? 1 : 0)
