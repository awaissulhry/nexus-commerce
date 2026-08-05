/**
 * ACR.0.2c — surface the ToS-IS error that has been counted and never logged. READ-ONLY.
 *
 * Prod runs `profiles=9 rowsFetched=0 withIS=0 rowsUpdated=0 errors=9` nightly with CronRun
 * status SUCCESS. The messages exist in the service's result object; only their COUNT is logged.
 * This reproduces the exact fetch for every profile and prints what each one says.
 *
 * Writes to a FILE, not stdout: `railway run` buffers a piped stdout until exit, which makes a
 * long run look like a hang. Nothing here touches the ingest's updateMany.
 *
 * Usage: NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_acr02-tosis-error.mts
 * Output: /tmp/acr02-tosis.txt
 */
import { resolve } from 'path'
import { appendFileSync, writeFileSync } from 'fs'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })

const OUT = '/tmp/acr02-tosis.txt'
writeFileSync(OUT, `ACR.0.2c ToS-IS probe — ${new Date().toISOString()}\n`)
const say = (s: string) => { appendFileSync(OUT, s + '\n'); console.log(s) }

say(`ads mode = ${process.env.NEXUS_AMAZON_ADS_MODE ?? '(unset)'}`)

const prisma = (await import('../src/db.js')).default
const { fetchReport } = await import('../src/services/advertising/ads-api-client.js')

const conns = await prisma.amazonAdsConnection.findMany({
  where: { isActive: true },
  select: { profileId: true, region: true, marketplace: true, mode: true },
})
say(`active connections: ${conns.length}`)

const end = new Date(); const start = new Date(); start.setUTCDate(start.getUTCDate() - 7)
const fmt = (d: Date) => d.toISOString().slice(0, 10)
const COLS = ['date', 'campaignId', 'impressions', 'topOfSearchImpressionShare']

for (const c of conns) {
  const ctx = { profileId: c.profileId, region: c.region as 'eu' }
  // (a) what the ingest asks for
  let aMsg: string
  try {
    const rows = (await fetchReport(ctx, { reportType: 'campaigns', startDate: fmt(start), endDate: fmt(end), columnsOverride: COLS })) as unknown[]
    const keys = rows.length ? Object.keys(rows[0] as object).join(',') : '(no rows)'
    const withIS = rows.filter((r) => (r as Record<string, unknown>).topOfSearchImpressionShare != null).length
    aMsg = `OK rows=${rows.length} withIS=${withIS} keys=[${keys}]`
  } catch (e) { aMsg = `FAIL ${(e as Error).message.slice(0, 300)}` }

  // (b) control — identical request minus the one extra column
  let bMsg: string
  try {
    const rows = (await fetchReport(ctx, { reportType: 'campaigns', startDate: fmt(start), endDate: fmt(end), columnsOverride: ['date', 'campaignId', 'impressions'] })) as unknown[]
    bMsg = `OK rows=${rows.length}`
  } catch (e) { bMsg = `FAIL ${(e as Error).message.slice(0, 200)}` }

  say(`\n${c.marketplace} profile=${c.profileId} mode=${c.mode}\n  (a) with tosIS : ${aMsg}\n  (b) control    : ${bMsg}`)
}

// Corrected 2026-08-05 after the first run: "both FAIL" does NOT imply unavailable.
// The observed failure was `timed out after 10 minutes` on BOTH requests — i.e. the report
// is accepted and simply outlives fetchReport's 60×10s poll. Read the message, not the shape.
say('\nReading:')
say('  (a) FAIL + (b) OK                     ⇒ the extra column is rejected.')
say('  both FAIL with "timed out"            ⇒ LATENCY: the report outlives the 10-min poll.')
say('  both FAIL with 4xx/auth               ⇒ credentials or entitlement.')
say('  (a) OK, rows>0, withIS=0              ⇒ Amazon accepts the column and returns it empty.')
await prisma.$disconnect()
say('\nDone — read-only.')
process.exit(0)
