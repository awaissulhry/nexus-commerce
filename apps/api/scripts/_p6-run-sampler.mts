const { sampleBudgetUsage, readCurrentBudgetUsage, readBudgetUsageHours, budgetUsageSamplingSince, budgetDayStartUtc } = await import('../src/services/advertising/ads-budget-usage.service.js')
const { default: prisma } = await import('../src/db.js')
const now = new Date()
console.log('now', now.toISOString(), '· budget day starts', budgetDayStartUtc(now).toISOString())
const s = await sampleBudgetUsage(now)
console.log('\n== sampler ==')
console.log(' ', JSON.stringify(s))
const camps = await prisma.campaign.findMany({ select: { id: true, name: true, status: true, adProduct: true, dailyBudget: true, marketplace: true } })
const cur = await readCurrentBudgetUsage(camps, new Date())
const hrs = await readBudgetUsageHours(camps, new Date())
const tally = new Map<string, number>()
for (const c of camps) tally.set(cur.get(c.id)!.state, (tally.get(cur.get(c.id)!.state) ?? 0) + 1)
console.log('\n== state census over all', camps.length, 'campaigns ==')
for (const [k, v] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`   ${k.padEnd(12)} ${v}`)
console.log('\n== every campaign with a reading above zero ==')
for (const c of camps) {
  const u = cur.get(c.id)!
  if (u.fraction == null || u.fraction <= 0) continue
  const h = hrs.get(c.id)!
  console.log(`   ${c.marketplace} ${c.name.slice(0, 30).padEnd(32)} ${String(c.status).padEnd(8)} ${u.state.padEnd(8)} ${(u.fraction * 100).toFixed(1).padStart(6)}% of EUR${((u.budgetCents ?? 0) / 100).toFixed(2).padStart(7)}  asOf=${u.asOf}  hours obs=${h.observed} oob=${h.outOfBudget} act=${h.actBid}`)
}
console.log('\n== sampling since ==', (await budgetUsageSamplingSince())?.toISOString() ?? 'never')
await prisma.$disconnect()
