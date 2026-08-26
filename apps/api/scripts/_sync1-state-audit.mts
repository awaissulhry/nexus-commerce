/**
 * SYNC.1 — why does the Ad Manager show ENABLED for campaigns paused on Amazon?
 * Read-only. Facts first: is the cron running, what does the drift table already know,
 * and which campaigns can the v3 settings sync even SEE.
 */
import prisma from '../src/db.js'

const ago = (d: Date | null) => (d ? `${((Date.now() - d.getTime()) / 60000).toFixed(0)}m ago` : 'never')

const runs = await prisma.cronRun.findMany({
  where: { jobName: 'ads-campaign-settings-sync' },
  orderBy: { startedAt: 'desc' }, take: 8,
  select: { startedAt: true, status: true, outputSummary: true, errorMessage: true },
})
console.log('=== ads-campaign-settings-sync — last 8 runs ===')
if (!runs.length) console.log('  NO RUNS EVER RECORDED')
for (const r of runs) console.log(`  ${r.startedAt.toISOString()} ${String(r.status).padEnd(8)} ${r.outputSummary ?? ''} ${r.errorMessage ? '!! ' + r.errorMessage.slice(0, 140) : ''}`)

console.log('\n=== Campaign population by adProduct x status ===')
const pop = await prisma.$queryRawUnsafe<any[]>(`
  SELECT "adProduct", status, COUNT(*)::int AS n,
         COUNT("settingsSyncedAt")::int AS with_settings_sync,
         MAX("settingsSyncedAt") AS newest_settings_sync
  FROM "Campaign" WHERE "externalCampaignId" IS NOT NULL
  GROUP BY 1,2 ORDER BY 1,2`)
for (const r of pop) console.log(`  ${String(r.adProduct).padEnd(20)} ${String(r.status).padEnd(9)} n=${String(r.n).padStart(4)}  settingsSyncedAt on ${String(r.with_settings_sync).padStart(4)}  newest=${r.newest_settings_sync ? ago(r.newest_settings_sync) : '-'}`)

console.log('\n=== AdDrift - open CAMPAIGN rows by field ===')
const drift = await prisma.$queryRawUnsafe<any[]>(`
  SELECT field, classification, COUNT(*)::int AS n, MIN("firstDetectedAt") AS oldest, MAX("lastDetectedAt") AS newest
  FROM "AdDrift" WHERE "resolvedAt" IS NULL AND "entityType"='CAMPAIGN'
  GROUP BY 1,2 ORDER BY 3 DESC`)
if (!drift.length) console.log('  (no open campaign drift rows)')
for (const d of drift) console.log(`  ${String(d.field).padEnd(16)} ${String(d.classification).padEnd(16)} n=${String(d.n).padStart(4)} oldest=${d.oldest?.toISOString?.().slice(0,16) ?? '-'} newest=${d.newest?.toISOString?.().slice(0,16) ?? '-'}`)

console.log('\n=== AdDrift - open STATUS rows ===')
const st = await prisma.adDrift.findMany({
  where: { entityType: 'CAMPAIGN', field: 'status', resolvedAt: null },
  orderBy: { firstDetectedAt: 'asc' }, take: 25,
  select: { entityName: true, ourValue: true, amazonValue: true, classification: true, firstDetectedAt: true, occurrences: true },
})
if (!st.length) console.log('  (none open)')
for (const d of st) console.log(`  ${String(d.entityName).slice(0,44).padEnd(44)} ours=${String(d.ourValue).padEnd(9)} amazon=${String(d.amazonValue).padEnd(9)} ${d.classification} since=${d.firstDetectedAt.toISOString().slice(0,16)} x${d.occurrences}`)

console.log('\n=== Blind spot: non-SP campaigns (listCampaignsV3 is the SP endpoint) ===')
const blind = await prisma.$queryRawUnsafe<any[]>(`
  SELECT "adProduct", status, COUNT(*)::int AS n FROM "Campaign"
  WHERE "externalCampaignId" IS NOT NULL AND "adProduct" <> 'SPONSORED_PRODUCTS'
  GROUP BY 1,2 ORDER BY 1,2`)
if (!blind.length) console.log('  (all campaigns are SPONSORED_PRODUCTS)')
for (const r of blind) console.log(`  ${String(r.adProduct).padEnd(20)} ${String(r.status).padEnd(9)} n=${r.n}`)

console.log('\n=== settingsSyncedAt staleness, ENABLED campaigns ===')
const stale = await prisma.$queryRawUnsafe<any[]>(`
  SELECT "adProduct", COUNT(*)::int AS enabled_n,
         COUNT(*) FILTER (WHERE "settingsSyncedAt" IS NULL)::int AS never,
         COUNT(*) FILTER (WHERE "settingsSyncedAt" < now() - interval '2 hours')::int AS older_2h,
         COUNT(*) FILTER (WHERE "settingsSyncedAt" < now() - interval '24 hours')::int AS older_24h
  FROM "Campaign" WHERE status='ENABLED' AND "externalCampaignId" IS NOT NULL
  GROUP BY 1 ORDER BY 1`)
for (const r of stale) console.log(`  ${String(r.adProduct).padEnd(20)} enabled=${String(r.enabled_n).padStart(4)} never=${String(r.never).padStart(4)} >2h=${String(r.older_2h).padStart(4)} >24h=${String(r.older_24h).padStart(4)}`)

await prisma.$disconnect()
