/** READ-ONLY. Is our stored dailyBudget stale, or did somebody deliberately set EUR1? */
const { default: prisma } = await import('../src/db.js')
const names = ['MOSS-Brand-SP-KW-TM', 'MOSS-Auto-SP-KW-TM', 'MOSS-Competitor-SP-KW-TM']
const camps = await prisma.campaign.findMany({ where: { name: { in: names } }, select: { id: true, name: true, externalCampaignId: true, dailyBudget: true, status: true, updatedAt: true, lastSyncedAt: true, lastSyncStatus: true, minBudgetCents: true, maxBudgetCents: true } })
for (const c of camps) {
  console.log(`\n== ${c.name} · ${c.status} · ours EUR${c.dailyBudget} · updatedAt ${c.updatedAt.toISOString()} · lastSynced ${c.lastSyncedAt?.toISOString() ?? 'never'} (${c.lastSyncStatus ?? '-'})`)
  console.log(`   guardrails: min=${c.minBudgetCents ?? '-'} max=${c.maxBudgetCents ?? '-'}`)
  const logs = await prisma.advertisingActionLog.findMany({ where: { entityId: { in: [c.id, c.externalCampaignId ?? ''] } }, orderBy: { createdAt: 'desc' }, take: 6, select: { createdAt: true, action: true, actor: true, status: true, details: true } }).catch(() => [])
  if (!logs.length) console.log('   action log: (no rows)')
  for (const l of logs) console.log(`   ${l.createdAt.toISOString()} ${l.action} by=${l.actor} ${l.status} ${JSON.stringify(l.details).slice(0, 110)}`)
  const daily = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
    SELECT "date"::text AS d, "campaignBudgetCents" FROM "AmazonAdsDailyPerformance"
    WHERE "entityType"='CAMPAIGN' AND "localEntityId"=$1 AND "campaignBudgetCents" IS NOT NULL
    ORDER BY "date" DESC LIMIT 5`, c.id)
  console.log('   what AMAZON reported the budget was, per day: ' + (daily.length ? daily.map(r => `${r.d}=${Number(r.campaignBudgetCents)/100}`).join(' ') : '(no rows)'))
}
await prisma.$disconnect()
