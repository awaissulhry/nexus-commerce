/**
 * GX.1 — recover the advertised-product days that never landed.
 *
 * Requests RANGES, not days: Amazon allows 31 days per report at DAILY grain, so 136 holes
 * collapse into ~12 jobs instead of 136 in a queue that runs at concurrency 1. Re-requesting a
 * range that includes days we already hold is harmless — the upsert key is the same — and it
 * also repairs any partially-ingested day inside it.
 *
 * Follows the SPC.3 hardening, which was learned the expensive way:
 *  · every DB call wrapped in retry() — Neon drops an idle pooled connection and a loop that
 *    waits 20+ minutes for one Amazon report hits that reliably; the crash looks like the
 *    backfill failed when the job is actually fine;
 *  · ONE direct GET per job rather than pollPendingJobs(), which sweeps and writes to every
 *    pending job in the account and multiplies DB traffic in the fragile loop;
 *  · reads `url`, never the v2 spelling `location`;
 *  · verifies by DATA — it re-counts the gaps at the end — not by job status.
 *
 * Safe to re-run at any time. Idempotent on (profile, adProduct, reportTypeId, start, end).
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { findPerformanceGaps, unattributedSpendOf } =
  await import('../src/services/advertising/ads-report-gapfill.service.js')
const { createReportJob, ingestCompletedJob, ADVERTISED_PRODUCT_REPORT_TYPE_ID, ADVERTISED_PRODUCT_COLUMNS } =
  await import('../src/services/advertising/ads-reports.service.js')
const { liveCall } = await import('../src/services/advertising/ads-api-client.js')

const APPLY = process.argv.includes('--apply')
const MAX_RANGE_DAYS = 31
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function retry<T>(label: string, fn: () => Promise<T>, tries = 4): Promise<T> {
  let last: unknown
  for (let i = 1; i <= tries; i++) {
    try { return await fn() } catch (e) { last = e; console.log(`   retry ${i}/${tries} ${label}: ${(e as Error).message.slice(0, 80)}`); await sleep(3000 * i) }
  }
  throw last
}

const iso = (d: Date) => d.toISOString().slice(0, 10)

// ── 1. what is missing ────────────────────────────────────────────────────────
const gaps = await retry('findPerformanceGaps', () => findPerformanceGaps(120))
const prod = gaps.filter((g) => g.kind === 'advertised-product')
console.log(`gaps: ${gaps.length} total · ${prod.length} product-only · €${unattributedSpendOf(gaps)} unattributed`)
if (!prod.length) { console.log('nothing to do'); await prisma.$disconnect(); process.exit(0) }

// ── 2. collapse each profile's missing days into <=31-day windows ─────────────
type Win = { profileId: string; marketplace: string; region: string; from: string; to: string; days: number; eur: number }
const wins: Win[] = []
const byProfile = new Map<string, typeof prod>()
for (const g of prod) {
  const k = g.profileId
  if (!byProfile.has(k)) byProfile.set(k, [])
  byProfile.get(k)!.push(g)
}
for (const [, list] of byProfile) {
  const sorted = [...list].sort((a, b) => a.date.localeCompare(b.date))
  let cur: Win | null = null
  for (const g of sorted) {
    const span = cur ? (Date.parse(g.date) - Date.parse(cur.from)) / 86_400_000 + 1 : 0
    if (!cur || span > MAX_RANGE_DAYS) {
      cur = { profileId: g.profileId, marketplace: g.marketplace, region: g.region, from: g.date, to: g.date, days: 1, eur: g.unattributedSpend }
      wins.push(cur)
    } else { cur.to = g.date; cur.days++; cur.eur += g.unattributedSpend }
  }
}
console.log(`\n${wins.length} report windows (was ${prod.length} single-day jobs):`)
for (const w of wins) console.log(`  ${w.marketplace}  ${w.from} → ${w.to}  ${String(w.days).padStart(3)} missing days  €${w.eur.toFixed(2)}`)
if (!APPLY) { console.log('\nDRY RUN — pass --apply to create the jobs'); await prisma.$disconnect(); process.exit(0) }

// ── 3. create, poll, ingest ───────────────────────────────────────────────────
let created = 0, ingested = 0, rows = 0
for (const w of wins) {
  const meta = await retry('profile', () => prisma.amazonAdsProfile.findUnique({ where: { profileId: w.profileId }, select: { currencyCode: true } }))
  const region = (w.region === 'NA' || w.region === 'FE') ? w.region : 'EU'
  console.log(`\n▸ ${w.marketplace} ${w.from} → ${w.to}`)
  let job
  try {
    job = await retry('createReportJob', () => createReportJob({
      profileId: w.profileId, region: region as 'EU' | 'NA' | 'FE', marketplace: w.marketplace,
      currencyCode: meta?.currencyCode ?? 'EUR', adProduct: 'SPONSORED_PRODUCTS',
      reportTypeId: ADVERTISED_PRODUCT_REPORT_TYPE_ID, startDate: w.from, endDate: w.to,
      groupBy: ['advertiser'], columns: ADVERTISED_PRODUCT_COLUMNS, timeUnit: 'DAILY',
    }))
  } catch (e) { console.log(`   ✗ create failed: ${(e as Error).message.slice(0, 160)}`); continue }
  created++
  console.log(`   job ${job.jobId} · amazon ${job.externalReportId}${job.alreadyExisted ? ' (already existed)' : ''}`)

  // One direct GET per job. pollPendingJobs() would sweep the whole account.
  for (let i = 0; i < 60; i++) {
    await sleep(30_000)
    let st: { status?: string; url?: string }
    try {
      st = await liveCall<{ status?: string; url?: string }>({
        profileId: w.profileId, region: region as 'EU' | 'NA' | 'FE',
        method: 'GET', path: `/reporting/reports/${job.externalReportId}`,
      })
    } catch (e) { console.log(`   poll error: ${(e as Error).message.slice(0, 80)}`); continue }
    const up = st.status?.toUpperCase() ?? 'PENDING'
    if (up === 'COMPLETED' && st.url) {
      await retry('markCompleted', () => prisma.amazonAdsReportJob.update({
        where: { id: job.jobId }, data: { status: 'COMPLETED', location: st.url, completedAt: new Date() },
      }))
      const r = await retry('ingest', () => ingestCompletedJob(job.jobId))
      ingested++; rows += r.rowsIngested ?? 0
      console.log(`   ✓ ingested ${r.rowsIngested ?? 0} rows after ${(i + 1) * 0.5} min`)
      break
    }
    if (up === 'FAILURE' || up === 'CANCELLED') { console.log(`   ✗ Amazon says ${up}`); break }
    if (i % 4 === 3) console.log(`   …${up} (${(i + 1) * 0.5} min)`)
  }
}

// ── 4. verify by DATA, not by job status ──────────────────────────────────────
const after = await retry('re-check', () => findPerformanceGaps(120))
const afterProd = after.filter((g) => g.kind === 'advertised-product')
console.log(`\njobs created ${created} · ingested ${ingested} · rows ${rows}`)
console.log(`product gaps: ${prod.length} → ${afterProd.length}   unattributed €${unattributedSpendOf(gaps)} → €${unattributedSpendOf(after)}`)
await prisma.$disconnect()
