import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const out = (s: string) => console.log(`§ ${s}`)

const camps = await prisma.campaign.findMany({ where: { status: 'ENABLED' }, select: { id:true, name:true, marketplace:true, dailyBudget:true, liveBidWritesEnabled:true, budgetBaselineCents:true } })
const allow = camps.filter(c => (c as any).liveBidWritesEnabled === true)
out(`ENABLED campaigns ${camps.length} · on the live-write allowlist ${allow.length} · OFF the allowlist ${camps.length-allow.length}`)
out('The allowlisted ones (the only campaigns a budget schedule could actually move):')
for (const c of allow) console.log(`  · ${c.marketplace} ${c.name} — €${Number(c.dailyBudget??0).toFixed(2)}/day, baseline ${c.budgetBaselineCents!=null?'€'+(c.budgetBaselineCents/100).toFixed(2):'NONE'}`)

// gate reasons, 7d
const reasons = await prisma.$queryRaw<Array<{ r: string; n: bigint }>>`
  SELECT split_part(split_part("errorMessage", ']', 2), ':', 1) AS r, COUNT(*) n
  FROM "OutboundSyncQueue" WHERE "syncType"='AD_BUDGET_UPDATE' AND "syncStatus"='SKIPPED' AND "createdAt" >= NOW() - INTERVAL '7 days'
  GROUP BY 1 ORDER BY n DESC`
out('Why budget writes were skipped, 7d')
for (const r of reasons) console.log(`  · ${r.r.trim()}: ${Number(r.n)}`)

// day-move gate config
const g = await prisma.$queryRaw<Array<{ c: string }>>`SELECT column_name::text c FROM information_schema.columns WHERE table_name='Campaign' AND column_name ILIKE '%live%'`
out(`Campaign live* columns: ${g.map(x=>x.c).join(', ')}`)
await prisma.$disconnect()
