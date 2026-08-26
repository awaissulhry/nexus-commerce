/** READ-ONLY. ADM-H P1 round-trip: did the Ad Manager's Min/Max Budget pencil actually persist? */
const { default: prisma } = await import('../src/db.js')
const c = await prisma.campaign.findUnique({
  where: { id: 'cmpedj3qv04yaoj01cv0uwpdx' },
  select: { name: true, status: true, minBudgetCents: true, maxBudgetCents: true, budgetBaselineCents: true, minBidCents: true, maxBidCents: true, dynamicBidding: true },
})
console.log('DB now:', JSON.stringify({ name: c?.name, status: c?.status, minBudgetCents: c?.minBudgetCents, maxBudgetCents: c?.maxBudgetCents, baseline: c?.budgetBaselineCents, minBidCents: c?.minBidCents, maxBidCents: c?.maxBidCents }))
console.log('dynamicBidding keys still intact:', Object.keys((c?.dynamicBidding ?? {}) as object).join(',') || '(none)')
const log = await prisma.advertisingActionLog.findFirst({
  where: { entityId: 'cmpedj3qv04yaoj01cv0uwpdx', actionType: 'set_campaign_budget_bounds' },
  orderBy: { createdAt: 'desc' },
  select: { createdAt: true, userId: true, payloadBefore: true, payloadAfter: true },
})
console.log('audit row:', log ? JSON.stringify({ at: log.createdAt.toISOString(), by: log.userId, before: log.payloadBefore, after: log.payloadAfter }) : 'NONE')
await prisma.$disconnect()
