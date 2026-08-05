import { config } from 'dotenv'
config({ path: '/Users/awais/nexus-commerce/.env' })
const { computeBudgetEnforcement } = await import('../src/services/advertising/ads-budget-enforce.service.js')
const r = await computeBudgetEnforcement({ month: '2026-08' })
const eur = (c: number | null | undefined) => c == null ? '—' : `EUR ${(c / 100).toFixed(2)}`
console.log('\n================ BUDGET ENFORCEMENT PREVIEW (2026-08) ================')
for (const p of r.plans) {
  console.log(`\n${p.marketplace}  cap=${eur(p.capCents)}  mtd=${eur(p.mtdSpendCents)}  remaining=${eur(p.remainingBudgetCents)}`)
  console.log(`   day ${p.dayOfMonth}/${p.daysInMonth}, ${p.remainingDays} left | pacing=${p.autoPacing} stop=${p.stopOverSpend} capReached=${p.capReached}`)
  console.log(`   today's target across ${p.campaigns.length} campaigns: ${eur(p.todayTargetCents)}`)
  const moves = p.campaigns.filter((c) => c.deltaCents !== 0 || c.suppress || c.restore)
  console.log(`   campaigns that would CHANGE: ${moves.length}`)
  for (const c of moves.slice(0, 6)) {
    console.log(`     ${c.suppress ? 'SUPPRESS' : c.restore ? 'RESTORE ' : 'BUDGET  '} ${c.name.slice(0, 46).padEnd(46)} ${eur(c.currentDailyCents)} -> ${eur(c.targetDailyCents)}${c.clamp ? ` [${c.clamp}]` : ''}`)
  }
}
console.log('\nTOTALS:', JSON.stringify(r.totals))
