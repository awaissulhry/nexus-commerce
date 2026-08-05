/**
 * ACR.2.2 — backfill AD_TARGET-grain history so the consolidation analysis has evidence.
 *
 * The target-grain report cycle (`spTargeting`) was added 2026-08-04 and has run on schedule
 * exactly once, so the grain holds TWO days: 07-28 (a first manual run) and 08-04. The GALE
 * consolidation analysis needs per-(term × match) performance to pick a champion, and on two
 * days every pair ties at zero sales — which is why that analysis could rank nothing.
 *
 * Amazon still serves those days. This asks for them.
 *
 * Scoped deliberately:
 *   · Only profiles that HAVE campaigns. Five EU profiles (IE/NL/PL/SE/UK) carry none, and
 *     `runTargetingReportCycle` does not filter — pointing it at a 30-day range would create
 *     150 jobs that can only ever return zero. The gap-fill service already refuses to do this
 *     for the same reason; the daily cycles simply predate the rule.
 *   · Never yesterday or today. Amazon has not closed the day and the daily cron owns it.
 *
 * `createReportJob` is idempotent on (profile, adProduct, reportTypeId, range) while a job is
 * PENDING|IN_PROGRESS, so re-running this is safe. The existing poll + ingest crons drain the
 * queue; nothing here waits on them.
 *
 * Usage: cd apps/api && npx tsx scripts/_acr2-target-backfill.mts [days=30] [market=ALL] [--dry]
 */
import '../src/env.js'

const DAYS = Math.max(1, Math.min(90, Number(process.argv[2] ?? 30)))
const MARKET = (process.argv[3] ?? 'ALL').toUpperCase()
const DRY = process.argv.includes('--dry')

const { default: prisma } = await import('../src/db.js')
const { createReportJob, TARGETING_REPORT_TYPE_ID, TARGETING_COLUMNS } = await import('../src/services/advertising/ads-reports.service.js')

const conns = await prisma.amazonAdsConnection.findMany({
  where: { isActive: true },
  select: { profileId: true, region: true, marketplace: true },
})
const withCampaigns: typeof conns = []
for (const c of conns) {
  const n = await prisma.campaign.count({ where: { marketplace: c.marketplace } })
  if (n > 0 && (MARKET === 'ALL' || c.marketplace === MARKET)) withCampaigns.push(c)
}

// Yesterday is owned by the daily cron; start two days back.
const days: string[] = []
for (let i = 2; i < 2 + DAYS; i++) {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - i)
  days.push(d.toISOString().slice(0, 10))
}

const have = await prisma.$queryRawUnsafe<{ day: string }[]>(`
  SELECT DISTINCT date::text AS day FROM "AmazonAdsDailyPerformance" WHERE "entityType" = 'AD_TARGET'`)
const haveSet = new Set(have.map((r) => r.day.slice(0, 10)))
const missing = days.filter((d) => !haveSet.has(d))

console.log(`\nProfiles with campaigns: ${withCampaigns.map((c) => `${c.marketplace}(${c.profileId})`).join(', ')}`)
console.log(`Skipped (no campaigns): ${conns.filter((c) => !withCampaigns.includes(c)).map((c) => c.marketplace).join(', ') || 'none'}`)
console.log(`Days requested: ${missing.length} of ${DAYS} (${haveSet.size} already have rows)`)
console.log(`Range: ${missing[missing.length - 1] ?? '—'} → ${missing[0] ?? '—'}`)
console.log(`Jobs to create: ${withCampaigns.length * missing.length}  ${DRY ? '(DRY RUN)' : ''}\n`)

if (DRY) { await prisma.$disconnect(); process.exit(0) }

let created = 0, skipped = 0
const errors: string[] = []
for (const c of withCampaigns) {
  const meta = await prisma.amazonAdsProfile.findUnique({ where: { profileId: c.profileId }, select: { currencyCode: true } })
  for (const day of missing) {
    try {
      const out = await createReportJob({
        profileId: c.profileId,
        region: (c.region === 'NA' || c.region === 'FE') ? c.region : 'EU',
        marketplace: c.marketplace,
        currencyCode: meta?.currencyCode ?? 'EUR',
        adProduct: 'SPONSORED_PRODUCTS',
        reportTypeId: TARGETING_REPORT_TYPE_ID,
        startDate: day,
        endDate: day,
        groupBy: ['targeting'],
        columns: TARGETING_COLUMNS,
        timeUnit: 'DAILY',
      })
      if (out.alreadyExisted) skipped += 1; else created += 1
    } catch (err) {
      errors.push(`${c.marketplace} ${day}: ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}`)
    }
  }
}

console.log(`created=${created} alreadyQueued=${skipped} errors=${errors.length}`)
for (const e of errors.slice(0, 10)) console.log(`  ! ${e}`)
console.log(`\nThe poll cron (every 10 min) and ingest cron (4x/hour) drain these. Nothing here waits.\n`)
await prisma.$disconnect()
