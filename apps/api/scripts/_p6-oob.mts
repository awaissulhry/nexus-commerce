const { default: prisma } = await import('../src/db.js')
const { readBudgetUsageHours, readCurrentBudgetUsage } = await import('../src/services/advertising/ads-budget-usage.service.js')
const hot = await prisma.adBudgetUsageSample.findMany({ where: { percent: { gte: 95 } }, orderBy: { percent: 'desc' } })
const camps = await prisma.campaign.findMany({ where: { id: { in: hot.map(h => h.campaignId) } }, select: { id: true, name: true, marketplace: true, status: true, adProduct: true, dailyBudget: true } })
const byId = new Map(camps.map(c => [c.id, c]))
const hrs = await readBudgetUsageHours(camps)
const cur = await readCurrentBudgetUsage(camps)
console.log('== campaigns at or above 95% of budget today ==')
for (const h of hot) {
  const c = byId.get(h.campaignId)!
  const u = hrs.get(c.id)!, n = cur.get(c.id)!
  console.log(`   ${c.marketplace} ${c.name.slice(0, 32).padEnd(34)} ${String(c.status).padEnd(8)} ${h.percent}% of EUR${(h.budgetCents / 100).toFixed(2)}  reading ${h.usageUpdatedAt.toISOString()}  observed ${h.firstSeenAt.toISOString().slice(11,19)}→${h.lastSeenAt.toISOString().slice(11,19)}`)
  console.log(`      now: ${n.state} ${n.fraction != null ? (n.fraction * 100).toFixed(1) + '%' : '—'} · hours obs=${u.observed} oob=${u.outOfBudget} actBid=${u.actBid}`)
}
await prisma.$disconnect()
