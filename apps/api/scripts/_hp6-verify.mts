import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const r = await prisma.automationRule.findFirst({
  where: { name: { contains: 'GALE DE' } },
  select: { id: true, name: true, enabled: true, autonomyLevel: true, dryRun: true, scopeMarketplace: true, maxExecutionsPerDay: true, maxDailyAdSpendCentsEur: true, trigger: true, conditions: true, actions: true },
})
if (!r) { console.log('RULE NOT FOUND'); process.exit(1) }
const a0 = (r.actions as any[])[0] ?? {}
const groups = (a0.mappings ?? []).flatMap((m: any) => m.groups ?? [])
console.log(JSON.stringify({
  id: r.id, name: r.name, enabled: r.enabled, level: r.autonomyLevel, dryRun: r.dryRun,
  market: r.scopeMarketplace, trigger: r.trigger,
  caps: { execs: r.maxExecutionsPerDay, spendCents: r.maxDailyAdSpendCentsEur },
  conditionGroups: (r.conditions as any[]).length,
  action: a0.type, bid: a0.bid, dedupe: a0.dedupe,
  mappingGroups: groups.map((g: any) => ({ name: g.name, look: g.look, types: g.types })),
}, null, 1))
await prisma.$disconnect()
