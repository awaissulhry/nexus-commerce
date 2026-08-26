import '../src/env.js'
const { computeBudgetBinding } = await import('../src/services/advertising/ads-budget-binding.service.js')
const r = await computeBudgetBinding({ weeks: 8 })
console.log('coverage      ', JSON.stringify(r.coverage))
console.log('reconstruction', JSON.stringify(r.reconstruction))
console.log('campaigns     ', r.campaigns.length)
const days = r.campaigns.reduce((a, c) => a + c.daysWithSpend, 0)
const bind = r.campaigns.reduce((a, c) => a + c.daysBinding, 0)
const near = r.campaigns.reduce((a, c) => a + c.daysNear, 0)
console.log(`\ncampaign-days with spend : ${days}`)
console.log(`at or over budget-in-force: ${bind}  (${((bind / days) * 100).toFixed(1)}%)   [study 32.7%, my plan 34.9%]`)
console.log(`>=90%                     : ${near}  (${((near / days) * 100).toFixed(1)}%)   [study 36.6%]`)
console.log(`campaigns bound >=90% once: ${r.campaigns.filter((c) => c.daysNear > 0).length} of ${r.campaigns.length}   [study 34 of 63]`)
console.log(`approximate (no log)      : ${r.campaigns.filter((c) => c.approximate).length}`)
console.log(`\ntop 5 by days binding:`)
for (const c of r.campaigns.slice(0, 5)) {
  console.log(`  ${c.name.slice(0, 34).padEnd(34)} ${c.marketplace} ${c.daysBinding}/${c.daysWithSpend} max=${Math.round(c.maxRatio * 100)}% lastHr=${c.lastDeliveringHour ?? '—'} ${c.approximate ? '≈' : ''}`)
}
process.exit(0)
