/** ACR.6 — what is "New-to-brand optimizer" configured to do, and what would fixing it unleash? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: { id: true, name: true, enabled: true, dryRun: true, trigger: true, conditions: true, actions: true, scopeMarketplace: true, maxExecutionsPerDay: true, maxDailyAdSpendCentsEur: true, evaluationCount: true, matchCount: true, executionCount: true, lastExecutedAt: true },
})

const ntb = rules.find((r) => r.name.toLowerCase().includes('new-to-brand'))
if (!ntb) { console.log('rule not found'); process.exit(1) }

console.log('\n═ New-to-brand optimizer')
console.log(`  enabled=${ntb.enabled}  dryRun=${ntb.dryRun}  market=${ntb.scopeMarketplace ?? 'ALL'}`)
console.log(`  caps: maxExec/day=${ntb.maxExecutionsPerDay ?? 'none'}  maxDailySpend=${ntb.maxDailyAdSpendCentsEur ?? 'none'}`)
console.log(`  counters: evaluations=${ntb.evaluationCount} matches=${ntb.matchCount} executions=${ntb.executionCount}`)
console.log(`  lastExecutedAt=${ntb.lastExecutedAt?.toISOString() ?? 'never'}`)
console.log(`  trigger=${ntb.trigger}`)
console.log(`  conditions=${JSON.stringify(ntb.conditions)}`)
console.log(`  actions=${JSON.stringify(ntb.actions)}`)

// Which OTHER rules use bid_up / bid_down, and against which target?
console.log('\n═ every rule using bid_up or bid_down')
for (const r of rules) {
  const acts = (Array.isArray(r.actions) ? r.actions : []) as Array<Record<string, unknown>>
  for (const a of acts) {
    if (a?.type === 'bid_up' || a?.type === 'bid_down') {
      console.log(`  ${r.name.slice(0, 40).padEnd(42)} ${String(a.type).padEnd(9)} target=${String(a.target ?? 'ad_target (default)').padEnd(22)} percent=${a.percent ?? '?'}  enabled=${r.enabled} dryRun=${r.dryRun}`)
    }
  }
}

// Does AdGroup carry the spend field bid_up's cap estimate needs?
const ag = await prisma.adGroup.findFirst({ select: { id: true, defaultBidCents: true } })
console.log(`\n═ AdGroup sample: ${ag ? `defaultBidCents=${ag.defaultBidCents}` : 'none'}`)

// How many ad groups would a fixed rule actually touch?
const agCount = await prisma.adGroup.count()
const agEnabled = await prisma.adGroup.count({ where: { status: 'ENABLED' } })
console.log(`  ad groups: ${agCount} total, ${agEnabled} ENABLED`)

await prisma.$disconnect()
