/**
 * ACR.0.2b — capture what Amazon actually returns for the two coverage feeds. READ-ONLY.
 *
 * The DB pass (_acr02-coverage-feeds.mts) established:
 *   • ToS-IS  — every profile errors every night (profiles=9 … errors=9) yet the cron
 *     records SUCCESS. The error TEXT is aggregated into a count and never logged, so
 *     nine identical failures a night have been invisible since the job shipped.
 *   • SQP     — 9,232 rows land with totals populated (53.1M impressions) and every
 *     brand/share column at 0. The parser reads `brandCount ?? asinCount ?? brand`;
 *     none of those appear anywhere else in the codebase and the unit test asserts
 *     against an INVENTED fixture, so the mapping has never met a real payload.
 *
 * This harness asks Amazon directly and prints the SHAPE (keys, one sample row) rather
 * than trusting either side's success counter — the same move that cracked the IT
 * ingest drop, where a live capture disproved the leading hypothesis.
 *
 * Writes nothing: it calls the fetch layer, never the ingest's updateMany/upsert.
 *
 * Usage (needs prod credentials):
 *   NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_acr02-capture-payloads.mts
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })

const h = (s: string) => console.log(`\n${'─'.repeat(78)}\n${s}\n${'─'.repeat(78)}`)
const keysOf = (o: unknown, depth = 0): string => {
  if (o == null || typeof o !== 'object') return typeof o
  if (Array.isArray(o)) return `Array(${o.length})${o.length ? ' of ' + keysOf(o[0], depth) : ''}`
  const e = Object.entries(o as Record<string, unknown>)
  if (depth >= 2) return `{${e.map(([k]) => k).join(', ')}}`
  return `{\n${e.map(([k, v]) => `${'  '.repeat(depth + 1)}${k}: ${keysOf(v, depth + 1)}`).join('\n')}\n${'  '.repeat(depth)}}`
}

// ── 1. ToS-IS: reproduce the exact fetch the ingest makes, and SHOW the error ──
h('1. ToS-IS — the swallowed error, surfaced')
try {
  const prismaMod = await import('../src/db.js')
  const prisma = prismaMod.default
  const { fetchReport } = await import('../src/services/advertising/ads-api-client.js')

  const conns = await prisma.amazonAdsConnection.findMany({
    where: { isActive: true },
    select: { profileId: true, region: true, marketplace: true },
  })
  console.log(`  active connections: ${conns.length}`)

  const end = new Date(); const start = new Date(); start.setUTCDate(start.getUTCDate() - 7)
  const fmt = (d: Date) => d.toISOString().slice(0, 10)

  // One profile is enough — all nine fail identically.
  const conn = conns[0]
  if (!conn) { console.log('  no active connection to test'); }
  else {
    console.log(`  probing profile=${conn.profileId} market=${conn.marketplace} region=${conn.region}`)
    // (a) EXACTLY what the ingest asks for today.
    try {
      const rows = await fetchReport(
        { profileId: conn.profileId, region: conn.region as 'eu' },
        { reportType: 'campaigns', startDate: fmt(start), endDate: fmt(end),
          columnsOverride: ['date', 'campaignId', 'impressions', 'topOfSearchImpressionShare'] },
      ) as unknown[]
      console.log(`  (a) WITH topOfSearchImpressionShare → ok, ${rows.length} rows`)
      if (rows.length) console.log('      sample: ' + keysOf(rows[0]))
    } catch (e) {
      console.log(`  (a) WITH topOfSearchImpressionShare → FAILED:\n      ${(e as Error).message.slice(0, 600)}`)
    }
    // (b) Control: same request WITHOUT the extra column. If this succeeds, the
    //     column is the problem, not credentials/quota/the report type.
    try {
      const rows = await fetchReport(
        { profileId: conn.profileId, region: conn.region as 'eu' },
        { reportType: 'campaigns', startDate: fmt(start), endDate: fmt(end),
          columnsOverride: ['date', 'campaignId', 'impressions'] },
      ) as unknown[]
      console.log(`  (b) WITHOUT it (control) → ok, ${rows.length} rows`)
      if (rows.length) console.log('      sample: ' + keysOf(rows[0]))
    } catch (e) {
      console.log(`  (b) WITHOUT it (control) → also FAILED:\n      ${(e as Error).message.slice(0, 400)}`)
      console.log('      ⇒ not a column problem; the campaigns report itself is unavailable here.')
    }
  }
} catch (e) {
  console.log(`  ToS-IS probe could not run: ${(e as Error).message}`)
}

// ── 2. SQP: fetch one real report and print its true key names ──
h('2. SQP — the real payload shape vs what the parser looks for')
try {
  const { ourAsinsForMarketplace } = await import('../src/services/advertising/sqp.service.js')
  const asins = await ourAsinsForMarketplace('IT', 1)
  console.log(`  test ASIN: ${asins[0] ?? '(none found)'}`)
  if (asins[0]) {
    const prismaMod = await import('../src/db.js')
    const mp = await prismaMod.default.marketplace.findUnique({ where: { channel_code: { channel: 'AMAZON', code: 'IT' } } })
    const { fetchSpApiJsonReport } = await import('../src/services/sp-api-reports.service.js')
    const end = new Date(); end.setUTCDate(end.getUTCDate() - 3)
    const start = new Date(end); start.setUTCDate(start.getUTCDate() - 7)
    const payload = await (fetchSpApiJsonReport as (a: unknown) => Promise<unknown>)({
      reportType: 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',
      marketplaceId: mp?.marketplaceId,
      dataStartTime: start, dataEndTime: end,
      reportOptions: { reportPeriod: 'WEEK', asin: asins[0] },
    })
    const root = (payload ?? {}) as Record<string, unknown>
    console.log('  top-level keys: ' + Object.keys(root).join(', '))
    const rows = (root.dataByAsin ?? root.dataByDepartmentAndSearchQuery ?? root.records ?? []) as unknown[]
    console.log(`  row array length: ${Array.isArray(rows) ? rows.length : 'not an array'}`)
    if (Array.isArray(rows) && rows.length) {
      console.log('\n  FIRST ROW SHAPE:\n' + keysOf(rows[0]))
      console.log('\n  FIRST ROW VALUES:\n  ' + JSON.stringify(rows[0], null, 2).split('\n').join('\n  '))
      console.log('\n  The parser reads: impressionData.{totalCount|totalQueryImpressionCount|total}')
      console.log('                and impressionData.{brandCount|asinCount|brand}')
      console.log('  Compare against the real keys above — the brand side is the one that is 0.')
    }
  }
} catch (e) {
  console.log(`  SQP capture could not run: ${(e as Error).message.slice(0, 500)}`)
}

console.log('\nDone. Read-only — no ingest ran, nothing was written.\n')
process.exit(0)
