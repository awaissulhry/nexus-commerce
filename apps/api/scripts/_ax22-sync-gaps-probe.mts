// READ-ONLY — characterise the AX2.2 sync gaps before fixing them.
const prisma = (await import('../src/db.js')).default
const L = (s = '') => console.log(s)
const now = Date.now()

L('── 1. campaigns that can never resolve against Amazon ──────────────')
const noExt = await prisma.campaign.findMany({
  where: { OR: [{ externalCampaignId: null }, { externalCampaignId: '' }] },
  select: { id: true, name: true, marketplace: true, status: true, createdAt: true, lastSyncedAt: true, lastSyncStatus: true },
})
for (const c of noExt) {
  L(`  · ${c.name}`)
  L(`      market=${c.marketplace} status=${c.status} created=${c.createdAt.toISOString().slice(0, 10)} lastSynced=${c.lastSyncedAt?.toISOString().slice(0, 16) ?? 'NEVER'} (${c.lastSyncStatus ?? '—'})`)
}
if (!noExt.length) L('  (none)')

L('\n── 2. never-synced campaigns ───────────────────────────────────────')
const never = await prisma.campaign.findMany({
  where: { lastSyncedAt: null },
  select: { id: true, name: true, marketplace: true, status: true, externalCampaignId: true, createdAt: true },
})
for (const c of never) {
  L(`  · ${c.name}`)
  L(`      market=${c.marketplace} status=${c.status} ext=${c.externalCampaignId ?? 'NULL'} created=${c.createdAt.toISOString().slice(0, 10)}`)
}
if (!never.length) L('  (none)')

L('\n── 3. settings-sync freshness (why is nothing < 30 min?) ───────────')
const camps = await prisma.campaign.findMany({
  select: { marketplace: true, lastSyncedAt: true, status: true },
})
const byMarket = new Map<string, { n: number; freshest: Date | null; stalest: Date | null }>()
for (const c of camps) {
  const k = c.marketplace ?? '—'
  const e = byMarket.get(k) ?? { n: 0, freshest: null, stalest: null }
  e.n++
  if (c.lastSyncedAt) {
    if (!e.freshest || c.lastSyncedAt > e.freshest) e.freshest = c.lastSyncedAt
    if (!e.stalest || c.lastSyncedAt < e.stalest) e.stalest = c.lastSyncedAt
  }
  byMarket.set(k, e)
}
for (const [m, e] of [...byMarket.entries()].sort()) {
  const fa = e.freshest ? Math.round((now - e.freshest.getTime()) / 60000) : null
  const sa = e.stalest ? Math.round((now - e.stalest.getTime()) / 60000) : null
  L(`  ${m.padEnd(5)} n=${String(e.n).padStart(4)}  freshest=${fa != null ? `${fa}m ago` : '—'}  stalest=${sa != null ? `${sa}m ago` : '—'}`)
}

L('\n── 4. ads-keyword-bid-resync — stuck runs? ─────────────────────────')
const runs = await prisma.cronRun.findMany({
  where: { jobName: 'ads-keyword-bid-resync' },
  orderBy: { startedAt: 'desc' }, take: 12,
  select: { startedAt: true, finishedAt: true, status: true, errorMessage: true },
})
for (const r of runs) {
  const dur = r.finishedAt ? `${Math.round((r.finishedAt.getTime() - r.startedAt.getTime()) / 1000)}s` : 'UNFINISHED'
  L(`  ${r.startedAt.toISOString().slice(0, 16)}  ${String(r.status).padEnd(8)} ${dur.padStart(11)}  ${(r.errorMessage ?? '').slice(0, 50)}`)
}
const stuck = runs.filter((r) => !r.finishedAt).length
L(stuck > 1 ? `  ⚠️ ${stuck} runs never finished — overlap lock suspect` : '  ✓ at most one unfinished run')

L('\n── 5. is any cron leaving RUNNING rows behind? ─────────────────────')
const unfinished = await prisma.cronRun.groupBy({
  by: ['jobName'],
  where: { finishedAt: null, startedAt: { lt: new Date(now - 2 * 3600e3) } },
  _count: { _all: true },
})
for (const u of unfinished.sort((a, b) => b._count._all - a._count._all).slice(0, 10)) {
  L(`  ${u.jobName.padEnd(34)} ${u._count._all} run(s) >2h old with no finishedAt`)
}
if (!unfinished.length) L('  (none older than 2h)')

L('\n── 6. CampaignTarget — the dead twin ───────────────────────────────')
L(`  CampaignTarget rows: ${await prisma.campaignTarget.count()}`)
L(`  AdTarget rows      : ${await prisma.adTarget.count()}`)

await prisma.$disconnect()
L('\n── done (no writes) ──')
