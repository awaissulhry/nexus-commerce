import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { maybeTranslateAdsRule } = await import('../src/services/advertising/ads-rule-adapter.service.js')

/** Fields a context builder can emit as NULL — where Number(null)===0 makes lt/lte match. */
const NULLABLE = ['acos','roas','ctr','cvr','cpcCents','budgetUtilization','sovPct','topSharePct',
  'organicRank','sponsoredRank','rankDelta','searchVolume']
const RISKY = new Set(['lt','lte'])

const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: { id:true, name:true, enabled:true, autonomyLevel:true, trigger:true, conditions:true, actions:true },
})
const out = rules.map(r => {
  const t = maybeTranslateAdsRule({ id: r.id, actions: r.actions, conditions: r.conditions })
  const blocks = t?.blocks?.length ? t.blocks : (t ? [{ conditions: t.conditions, actions: t.actions }] : [])
  const leaves = blocks.flatMap((b:any) => (b.conditions ?? []) as any[])
  const risky = leaves.filter((l:any) => RISKY.has(String(l.op)) && NULLABLE.some(f => String(l.field).endsWith('.'+f)))
  return {
    name: r.name, enabled: r.enabled, level: r.autonomyLevel, trigger: r.trigger,
    leaves: leaves.map((l:any)=>`${l.field} ${l.op} ${l.value}`),
    RISKY: risky.map((l:any)=>`${l.field} ${l.op} ${l.value}`),
  }
})
console.log('===JSON===' + JSON.stringify(out, null, 1))
await prisma.$disconnect()
