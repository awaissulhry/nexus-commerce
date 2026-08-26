/** READ-ONLY. ADM-H part 3 — rule reach (the Rules column) + the guardrail-grid authority. */
const { default: prisma } = await import('../src/db.js')
const rules = await prisma.automationRule.findMany({
  select: { id: true, name: true, enabled: true, scopeCampaignId: true, scopePortfolioId: true, scopeMarketplace: true, ruleType: true },
}).catch(async () => {
  const r = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT id,name,enabled FROM "AutomationRule" LIMIT 100`)
  return r as never
})
console.log(`== AutomationRule: ${rules.length} total, enabled ${rules.filter((r: { enabled: boolean }) => r.enabled).length}`)
for (const r of rules.slice(0, 20)) console.log(`   ${r.enabled ? 'ON ' : 'off'} ${String(r.name).slice(0, 46).padEnd(48)} camp=${r.scopeCampaignId ?? '-'} port=${r.scopePortfolioId ?? '-'} mkt=${r.scopeMarketplace ?? '-'}`)
const assign = await prisma.campaignRuleAssignment.count().catch(() => -1)
console.log(`== CampaignRuleAssignment rows: ${assign}`)
await prisma.$disconnect()
