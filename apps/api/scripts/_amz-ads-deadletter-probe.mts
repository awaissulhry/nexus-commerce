// READ-ONLY: characterise the 662 dead-lettered AD_* writes + structure counts.
const prisma = (await import('../src/db.js')).default
const L = (s = '') => console.log(s)

L('── dead-lettered AD_* writes ───────────────────────────────────────')
const dead = await prisma.outboundSyncQueue.findMany({
  where: { syncType: { startsWith: 'AD_' }, isDead: true },
  select: { syncType: true, diedAt: true, errorMessage: true, payload: true, targetRegion: true },
})
L(`total: ${dead.length}`)

const byType = new Map<string, number>()
const byErr = new Map<string, number>()
const byRegion = new Map<string, number>()
const byDay = new Map<string, number>()
for (const d of dead) {
  byType.set(d.syncType, (byType.get(d.syncType) ?? 0) + 1)
  const e = (d.errorMessage ?? '').match(/"errorType":"(\w+)"/)?.[1] ?? (d.errorMessage ?? 'none').slice(0, 40)
  byErr.set(e, (byErr.get(e) ?? 0) + 1)
  byRegion.set(d.targetRegion ?? '—', (byRegion.get(d.targetRegion ?? '—') ?? 0) + 1)
  const day = d.diedAt?.toISOString().slice(0, 10) ?? 'unknown'
  byDay.set(day, (byDay.get(day) ?? 0) + 1)
}
const show = (label: string, m: Map<string, number>) =>
  L(`\n${label}\n${[...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `  ${String(v).padStart(5)}  ${k}`).join('\n')}`)
show('by syncType:', byType)
show('by Amazon errorType:', byErr)
show('by region:', byRegion)
show('by day died:', byDay)

L('\nsample payload (shape of what we tried to push):')
const s0 = dead.find((d) => d.payload)
L('  ' + JSON.stringify(s0?.payload).slice(0, 300))
L('\nfull error text of one:')
L('  ' + (dead[0]?.errorMessage ?? '').slice(0, 600))

L('\n── structure that replication would have to copy ───────────────────')
for (const [label, n] of [
  ['Portfolio', await prisma.portfolio.count().catch(() => -1)],
  ['Campaign', await prisma.campaign.count().catch(() => -1)],
  ['AdGroup', await prisma.adGroup.count().catch(() => -1)],
  ['CampaignTarget', await prisma.campaignTarget.count().catch(() => -1)],
] as const) L(`  ${label.padEnd(18)} ${n < 0 ? '(model not found)' : n}`)

// campaign type spread — is anything other than Sponsored Products modelled?
const types = await prisma.campaign.groupBy({ by: ['campaignType'], _count: { _all: true } }).catch(() => null)
L(`\ncampaignType spread: ${types ? types.map((t) => `${t.campaignType}=${t._count._all}`).join(' ') : '(no campaignType field)'}`)

// how many targets have no external id (unpushable)
const tgtTotal = await prisma.campaignTarget.count().catch(() => -1)
if (tgtTotal >= 0) {
  const tgtNoExt = await prisma.campaignTarget.count({ where: { OR: [{ externalTargetId: null }, { externalTargetId: '' }] } }).catch(() => -1)
  L(`CampaignTarget without externalTargetId: ${tgtNoExt} / ${tgtTotal}  (these can never reach Amazon)`)
}

await prisma.$disconnect()
L('\n── done (no writes) ──')
