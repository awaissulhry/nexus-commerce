/**
 * ACR.0.2e — capture ONE real SQP payload and print its true key names. READ-ONLY.
 *
 * The previous attempt failed on MY bug, not prod's: Amazon requires
 * `dataEndTime` to be a **Saturday** when reportPeriod=WEEK, and I passed an
 * arbitrary date. Production's own `periodWindow('WEEK')` aligns Sunday→Saturday
 * correctly, so this reuses it rather than hand-rolling dates again.
 *
 * Writes to a file because `railway run` buffers a piped stdout until exit.
 *
 * Usage: railway run npx tsx scripts/_acr02-sqp-shape.mts
 * Output: /tmp/acr02-sqp.json  (+ a summary on stdout)
 */
import { resolve } from 'path'
import { writeFileSync, appendFileSync } from 'fs'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })

const OUT = '/tmp/acr02-sqp.json'
const LOG = '/tmp/acr02-sqp.txt'
writeFileSync(LOG, `ACR.0.2e SQP shape probe — ${new Date().toISOString()}\n`)
const say = (s: string) => { appendFileSync(LOG, s + '\n'); console.log(s) }

const prisma = (await import('../src/db.js')).default
const { ourAsinsForMarketplace, periodWindow } = await import('../src/services/advertising/sqp.service.js')
const { fetchSpApiJsonReport } = await import('../src/services/sp-api-reports.service.js')

const MARKET = process.argv[2] ?? 'IT'
const asin = (await ourAsinsForMarketplace(MARKET, 1))[0]
const mp = await prisma.marketplace.findUnique({ where: { channel_code: { channel: 'AMAZON', code: MARKET } } })
say(`market=${MARKET} marketplaceId=${mp?.marketplaceId} asin=${asin}`)

// Use PRODUCTION's own window rather than hand-rolling dates. Two corrections the first
// two attempts taught: dataEndTime must be a Saturday (Amazon rejects otherwise), and the
// lookback must be 2 — one week back is not published yet and Amazon answers with a generic
// "client error". The DB agrees: the newest stored SQP period is the lookback-2 week.
const LOOKBACK = Math.max(1, Number(process.env.NEXUS_SQP_LOOKBACK) || 2)
const { start, end: lastSat } = periodWindow('WEEK', new Date(), LOOKBACK)
say(`window ${start.toISOString().slice(0, 10)} (Sun) → ${lastSat.toISOString().slice(0, 10)} (Sat, day=${lastSat.getUTCDay()}) lookback=${LOOKBACK}`)

try {
  const payload = await fetchSpApiJsonReport<Record<string, unknown>>({
    reportType: 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',
    marketplaceId: mp!.marketplaceId,
    dataStartTime: start,
    dataEndTime: lastSat,
    reportOptions: { reportPeriod: 'WEEK', asin },
  })
  writeFileSync(OUT, JSON.stringify(payload, null, 2))
  const root = (payload ?? {}) as Record<string, unknown>
  say(`top-level keys: ${Object.keys(root).join(', ')}`)
  const rows = (root.dataByAsin ?? root.dataByDepartmentAndSearchQuery ?? root.records ?? []) as unknown[]
  say(`rows: ${Array.isArray(rows) ? rows.length : 'not an array'}`)
  if (Array.isArray(rows) && rows.length) {
    const r0 = rows[0] as Record<string, unknown>
    say(`row keys: ${Object.keys(r0).join(', ')}`)
    for (const stage of ['impressionData', 'clickData', 'cartAddData', 'purchaseData']) {
      const s = r0[stage] as Record<string, unknown> | undefined
      say(`  ${stage}: ${s ? Object.keys(s).join(', ') : '(absent)'}`)
    }
    say('\nFIRST ROW:\n' + JSON.stringify(r0, null, 2))
    say(`\nfull payload written to ${OUT}`)
  }
} catch (e) {
  say(`FAILED: ${(e as Error).message.slice(0, 800)}`)
}
await prisma.$disconnect()
say('\nDone — read-only.')
process.exit(0)
