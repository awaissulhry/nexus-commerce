import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const total = await prisma.adWriteRefusal.count()
console.log('AdWriteRefusal rows total:', total)
if (total) {
  const by = await prisma.adWriteRefusal.groupBy({ by: ['deniedAt'], _count: { _all: true } })
  console.log('by deniedAt:', by.map(r => `${r.deniedAt}×${r._count._all}`).join(' · '))
  const oldest = await prisma.adWriteRefusal.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } })
  const newest = await prisma.adWriteRefusal.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } })
  console.log('range:', oldest?.createdAt.toISOString(), '→', newest?.createdAt.toISOString())
  const allow = await prisma.adWriteRefusal.groupBy({ by: ['campaignId'], where: { deniedAt: 'campaign_allowlist' }, _count: { _all: true } })
  console.log('campaign_allowlist refusals across', allow.length, 'campaigns; top:', allow.sort((a,b)=>b._count._all-a._count._all).slice(0,5).map(r=>`${r.campaignId?.slice(0,8)}×${r._count._all}`).join(' · '))
}
const gate = await prisma.campaign.count({ where: { liveBidWritesEnabled: true } })
console.log('liveBidWritesEnabled NOW:', gate, 'of', await prisma.campaign.count())
await prisma.$disconnect()
