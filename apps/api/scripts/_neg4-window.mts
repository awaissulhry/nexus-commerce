/**
 * NEG.4 — 🔴 Detector A's zero is a property of the WINDOW, not of the account. READ-ONLY.
 *
 * The 30-day answer is 0. At 60 days it is 2, at 120 days it is 9. The brief and the study both
 * treat "0 blocking conflicts" as a fact about the account; it is a fact about the last 30 days.
 * This prints the rows so the claim is auditable rather than asserted.
 */
import '../src/env.js'
const { getAttention } = await import('../src/services/advertising/negatives-attention.service.js')
const { default: prisma } = await import('../src/db.js')
const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const int = (n: number) => n.toLocaleString('en-IE')

for (const w of [30, 60, 120] as const) {
  const a = await getAttention({ market: 'all', window: w })
  console.log(`\n═══ window ${w}d — ${a.conflicts.total} blocking conflicts of ${int(a.denominators.blockingNegations)} blocking negations (relaxed overlaps ${a.conflicts.overlapsRelaxedUnscoped}) ═══`)
  for (const c of a.conflicts.rows) {
    console.log(`  🔴 「${c.term}」 ${c.match}`)
    console.log(`     ${c.campaignName} › ${c.adGroupName}  (${c.market})`)
    console.log(`     THAT ad group's own traffic in ${w}d: ${int(c.adGroupTraffic.impressions)} impr · ${c.adGroupTraffic.clicks} clicks · ${c.adGroupTraffic.orders} orders · ${eur(c.adGroupTraffic.salesCents)} · spend ${eur(c.adGroupTraffic.spendCents)}`)
    console.log(`     negated in ${c.negatedIn} ad groups · runs in ${c.runsIn} · ${c.overlapRows} negation row(s) here · actionable=${c.actionable}`)
  }
  if (a.conflicts.total === 0) console.log('  (none)')
}

// Are the 120d conflicts genuinely blocking right now, or historical traffic against a negation
// added later? The negation's createdAt vs the traffic window is the question.
console.log('\n═══ Are the 120d conflicts current, or did the negation arrive after the traffic? ═══')
const a120 = await getAttention({ market: 'all', window: 120 })
for (const c of a120.conflicts.rows) {
  const rows = await prisma.adTarget.findMany({
    where: { isNegative: true, adGroup: { externalAdGroupId: c.externalAdGroupId }, expressionValue: c.term },
    select: { createdAt: true, status: true, expressionType: true },
  })
  const latest = await prisma.amazonAdsSearchTerm.aggregate({
    where: { query: c.termKey, adGroupId: c.externalAdGroupId }, _max: { date: true },
  })
  console.log(`  「${c.term}」 @ ${c.adGroupName}`)
  console.log(`     negation(s) created: ${rows.map((r) => r.createdAt.toISOString().slice(0, 10)).join(', ')}`)
  console.log(`     last impression for this term IN THIS AD GROUP: ${latest._max.date?.toISOString().slice(0, 10) ?? 'none'}`)
}
await prisma.$disconnect()
