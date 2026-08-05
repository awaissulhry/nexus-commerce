/** ACR.7b — prove a bound rule's SWEEP is bounded. Bind → measure → unbind; no change kept. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const PF = '255127157311072' // Xavia GALE IT

const rule = await prisma.automationRule.findFirst({
  where: { domain: 'advertising', name: 'Auto harvest & negate' },
  select: { id: true, name: true },
})
if (!rule) throw new Error('rule not found')

const { previewHarvest } = await import('../src/services/advertising/ads-harvest.service.js')

// Unscoped sweep — what the rule touched before binding meant anything.
const unscoped = await previewHarvest({ windowDays: 60, minSpendCents: 1000, minOrders: 2 })

// Bind, resolve exactly as the handler does, preview the bounded sweep, unbind.
await prisma.automationRule.update({ where: { id: rule.id }, data: { scopePortfolioId: PF } })
const campaigns = await prisma.campaign.findMany({
  where: { portfolioId: PF },
  select: { id: true, adGroups: { select: { externalAdGroupId: true } } },
})
const adGroupExternalIds = campaigns.flatMap((c) => c.adGroups.map((g) => g.externalAdGroupId)).filter((x): x is string => !!x)
const scoped = await previewHarvest({ windowDays: 60, minSpendCents: 1000, minOrders: 2, adGroupExternalIds })
await prisma.automationRule.update({ where: { id: rule.id }, data: { scopePortfolioId: null } })

console.log(`\n${rule.name} — sweep boundedness on prod data`)
console.log(`  unscoped (marketplace-wide): negate=${unscoped.negatives.length} graduate=${unscoped.graduations.length}`)
console.log(`  bound to Xavia GALE IT (${adGroupExternalIds.length} ad groups): negate=${scoped.negatives.length} graduate=${scoped.graduations.length}`)
const outside = scoped.negatives.filter((n) => !adGroupExternalIds.includes((n as { externalAdGroupId?: string }).externalAdGroupId ?? ''))
console.log(`  scoped candidates OUTSIDE the binding: ${outside.length}  ${outside.length === 0 ? '(none — the sweep respects the boundary)' : '!! LEAK'}`)
const final = await prisma.automationRule.findUnique({ where: { id: rule.id }, select: { scopePortfolioId: true } })
console.log(`  rule scope after: ${final?.scopePortfolioId ?? '— (restored)'}\n`)
await prisma.$disconnect()
