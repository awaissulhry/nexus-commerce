// READ-ONLY Amazon Ads sync health. No writes, no Amazon calls.
const prisma = (await import('../src/db.js')).default
const L = (s = '') => console.log(s)

L('── connection + mode ───────────────────────────────────────────────')
L(`NEXUS_AMAZON_ADS_MODE      = ${process.env.NEXUS_AMAZON_ADS_MODE ?? '(unset → sandbox)'}`)
L(`NEXUS_ENABLE_AMAZON_ADS_CRON = ${process.env.NEXUS_ENABLE_AMAZON_ADS_CRON ?? '(unset)'}`)
L(`NEXUS_AMS_DESTINATION_ARN  = ${process.env.NEXUS_AMS_DESTINATION_ARN ? '(set)' : '(unset → no intraday stream)'}`)

const conns = await prisma.amazonAdsConnection.findMany({
  select: { id: true, profileId: true, region: true, mode: true, isActive: true, writesEnabledAt: true, marketplace: true, lastWriteAt: true, lastVerifiedAt: true, lastError: true },
})
L(`\nAmazonAdsConnection rows: ${conns.length}`)
for (const c of conns) {
  L(`  · profile=${c.profileId} ${c.marketplace ?? '?'} ${c.region ?? '?'} mode=${c.mode} active=${c.isActive} writesEnabledAt=${c.writesEnabledAt ? c.writesEnabledAt.toISOString().slice(0,16) : 'NULL (writes blocked)'} lastWrite=${c.lastWriteAt?.toISOString().slice(0,16) ?? '-'} lastErr=${(c.lastError ?? '').slice(0,60)}`)
}

L('\n── campaign inventory + write eligibility ──────────────────────────')
const total = await prisma.campaign.count()
const byStatus = await prisma.campaign.groupBy({ by: ['status'], _count: { _all: true } })
L(`Campaign rows: ${total}  [${byStatus.map((s) => `${s.status}=${s._count._all}`).join(' ')}]`)
const liveWrites = await prisma.campaign.count({ where: { liveBidWritesEnabled: true } })
L(`liveBidWritesEnabled = true : ${liveWrites} / ${total}${liveWrites === 0 ? '   ⛔ no campaign can push bids to Amazon' : ''}`)
const noExternal = await prisma.campaign.count({ where: { OR: [{ externalCampaignId: null }, { externalCampaignId: '' }] } })
L(`externalCampaignId missing  : ${noExternal}${noExternal ? '   ⚠️ these can never be resolved against Amazon' : ''}`)

L('\n── freshness: how stale is the mirror? ─────────────────────────────')
const now = Date.now()
const camps = await prisma.campaign.findMany({ select: { lastSyncedAt: true, lastSyncStatus: true }, take: 5000 })
const buckets = { '<30m': 0, '30m-2h': 0, '2h-24h': 0, '>24h': 0, never: 0 }
for (const c of camps) {
  if (!c.lastSyncedAt) { buckets.never++; continue }
  const age = (now - c.lastSyncedAt.getTime()) / 60000
  if (age < 30) buckets['<30m']++
  else if (age < 120) buckets['30m-2h']++
  else if (age < 1440) buckets['2h-24h']++
  else buckets['>24h']++
}
L(`lastSyncedAt age: ${Object.entries(buckets).map(([k, v]) => `${k}=${v}`).join('  ')}`)
const statuses = await prisma.campaign.groupBy({ by: ['lastSyncStatus'], _count: { _all: true } })
L(`lastSyncStatus: ${statuses.map((s) => `${s.lastSyncStatus ?? 'null'}=${s._count._all}`).join(' ')}`)

L('\n── outbound write queue (AD_* lane) ────────────────────────────────')
const statusCounts: string[] = []
for (const st of ['PENDING', 'IN_PROGRESS', 'SUCCESS', 'FAILED', 'SKIPPED', 'CANCELLED'] as const) {
  const n = await prisma.outboundSyncQueue.count({ where: { syncType: { startsWith: 'AD_' }, syncStatus: st } })
  if (n) statusCounts.push(`${st}=${n}`)
}
L(`AD_* rows by status: ${statusCounts.join(' ') || '(none)'}`)
const dead = await prisma.outboundSyncQueue.count({ where: { syncType: { startsWith: 'AD_' }, isDead: true } })
L(`dead-lettered: ${dead}`)
const recentDead = await prisma.outboundSyncQueue.findMany({
  where: { syncType: { startsWith: 'AD_' }, isDead: true },
  orderBy: { diedAt: 'desc' }, take: 6,
  select: { syncType: true, diedAt: true, errorMessage: true, retryCount: true },
})
for (const d of recentDead) {
  L(`  ✗ ${d.diedAt?.toISOString().slice(0, 16)} ${d.syncType} retries=${d.retryCount} ${(d.errorMessage ?? '').slice(0, 110)}`)
}

L('\n── ads cron health (last run per job) ──────────────────────────────')
const jobs = await prisma.cronRun.findMany({
  where: { OR: [{ jobName: { contains: 'ads' } }, { jobName: { contains: 'rank' } }, { jobName: { contains: 'daypart' } }] },
  orderBy: { startedAt: 'desc' }, take: 300,
  select: { jobName: true, startedAt: true, status: true, errorMessage: true },
})
const seen = new Map<string, { at: Date; status: string; err: string | null }>()
for (const j of jobs) if (!seen.has(j.jobName)) seen.set(j.jobName, { at: j.startedAt, status: String(j.status), err: j.errorMessage })
for (const [name, v] of [...seen.entries()].sort()) {
  const ageMin = Math.round((now - v.at.getTime()) / 60000)
  L(`  ${name.padEnd(34)} ${v.status.padEnd(8)} ${String(ageMin).padStart(5)}m ago  ${(v.err ?? '').slice(0, 70)}`)
}

L('\n── portfolios + structure (what replication would copy) ────────────')
for (const [label, n] of [
  ['Portfolio', await prisma.portfolio.count().catch(() => -1)],
  ['AdGroup', await prisma.adGroup.count().catch(() => -1)],
  ['CampaignTarget', await prisma.campaignTarget.count().catch(() => -1)],
] as const) L(`  ${label.padEnd(16)} ${n < 0 ? '(model not found)' : n}`)

await prisma.$disconnect()
L('\n── done (no writes) ──')
