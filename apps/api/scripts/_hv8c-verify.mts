/** HV.8c — what the widened match-type filter now reaches. READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const int=(n:any)=>Number(n).toLocaleString('en-IE')
const OLD = ['BROAD','PHRASE']
const NEW = ['BROAD','PHRASE','TARGETING_EXPRESSION','TARGETING_EXPRESSION_PREDEFINED']
const since = new Date(Date.now() - 30*86400_000)
for (const [label, mt] of [['OLD', OLD], ['NEW', NEW]] as const) {
  const g = await prisma.amazonAdsSearchTerm.groupBy({
    by: ['query','campaignId','adGroupId','marketplace'],
    where: { date: { gte: since }, OR: [{ matchType: { in: mt as string[] } }, { matchType: null }] },
    _sum: { orders7d: true },
    having: { orders7d: { _sum: { gte: 2 } } },
  })
  console.log(`  ${label}: ${g.length} converting contexts (30d, orders>=2)`)
}
const extra = await prisma.amazonAdsSearchTerm.count({ where: { matchType: { in: ['TARGETING_EXPRESSION','TARGETING_EXPRESSION_PREDEFINED'] } } })
const nulls = await prisma.amazonAdsSearchTerm.count({ where: { matchType: null } })
console.log(`\n  auto-targeting rows all-time: ${int(extra)} · matchType NULL rows: ${int(nulls)} (the branch the comment was written for)`)
await prisma.$disconnect()
