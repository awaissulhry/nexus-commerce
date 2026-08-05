/** ACR.6 — did the bid_up fix + dry-run actually change what the rule produces? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const RULE_ID = 'cmpujofi00018rv016th0ykq9' // New-to-brand optimizer
const DEPLOY = new Date('2026-08-05T19:54:00Z') // handler fix live

const rule = await prisma.automationRule.findUnique({
  where: { id: RULE_ID },
  select: { name: true, enabled: true, dryRun: true },
})
console.log(`\n${rule?.name}  enabled=${rule?.enabled}  dryRun=${rule?.dryRun}`)

const after = await prisma.automationRuleExecution.findMany({
  where: { ruleId: RULE_ID, startedAt: { gte: DEPLOY } },
  orderBy: { startedAt: 'desc' },
  take: 10,
  select: { startedAt: true, status: true, dryRun: true, actionResults: true },
})
console.log(`\n${after.length} execution(s) since the fix went live:`)
for (const e of after) {
  const acts = (e.actionResults as Array<{ type?: string; ok?: boolean; error?: string; output?: Record<string, unknown> }> | null) ?? []
  const bid = acts.find((a) => a?.type === 'bid_up')
  const detail = bid
    ? bid.ok
      ? `ok · ${String(bid.output?.wouldChange ?? bid.output?.newBidCents ?? '')}`
      : `FAILED · ${bid.error}`
    : '(no bid_up action)'
  console.log(`  ${e.startedAt.toISOString()}  ${e.status.padEnd(8)} dryRun=${String(e.dryRun).padEnd(5)} bid_up: ${detail}`)
}

// Before/after comparison on the same error.
const stillFailing = await prisma.automationRuleExecution.count({
  where: { ruleId: RULE_ID, startedAt: { gte: DEPLOY } },
})
const before = await prisma.automationRuleExecution.count({
  where: { ruleId: RULE_ID, startedAt: { lt: DEPLOY, gte: new Date(DEPLOY.getTime() - 24 * 3600 * 1000) } },
})
console.log(`\nexecutions in the 24h BEFORE the fix: ${before}`)
console.log(`executions since the fix:            ${stillFailing}`)
if (after.length === 0) console.log('\n(none yet — the rule fires on its own cadence; re-run in a few minutes)')

await prisma.$disconnect()
