import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const rules = await prisma.automationRule.findMany({ where: { domain: 'advertising' }, select: { name: true, trigger: true, enabled: true, actions: true, conditions: true } })
for (const r of rules) {
  const acts = (Array.isArray(r.actions)?r.actions as any[]:[]).map(a=>`${a?.type}${a?.scope?`(scope:${a.scope})`:''}`)
  if (!acts.some(a=>/negative/.test(a))) continue
  console.log(`${r.enabled?'ON ':'off'} ${r.name}`)
  console.log(`     trigger ${r.trigger} · ${acts.join(', ')}`)
  console.log(`     conditions ${JSON.stringify(r.conditions).slice(0,160)}`)
}
await prisma.$disconnect()
