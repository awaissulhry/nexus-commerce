/** READ-ONLY: what actually reached Amazon for the AIRMESH replication. */
const { default: prisma } = await import('../src/db.js')

const camps = await prisma.campaign.findMany({
  where: { marketplace: 'IT', name: { startsWith: 'IT-AIRMESH-' } },
  select: { id: true, name: true, externalCampaignId: true, status: true,
    adGroups: { select: { id: true, name: true, externalAdGroupId: true } } },
  orderBy: { name: 'asc' },
})
console.log(`campaigns: ${camps.length}`)
let paTotal = 0, paOn = 0, tgTotal = 0, tgOn = 0, negTotal = 0, negOn = 0, autoTotal = 0, autoOn = 0
for (const c of camps) {
  for (const g of c.adGroups) {
    const [pa, paLive, tg, tgLive, neg, negLive, au, auLive] = await Promise.all([
      prisma.adProductAd.count({ where: { adGroupId: g.id } }),
      prisma.adProductAd.count({ where: { adGroupId: g.id, externalAdId: { not: null } } }),
      prisma.adTarget.count({ where: { adGroupId: g.id, isNegative: false, kind: 'KEYWORD' } }),
      prisma.adTarget.count({ where: { adGroupId: g.id, isNegative: false, kind: 'KEYWORD', externalTargetId: { not: null } } }),
      prisma.adTarget.count({ where: { adGroupId: g.id, isNegative: true } }),
      prisma.adTarget.count({ where: { adGroupId: g.id, isNegative: true, externalTargetId: { not: null } } }),
      prisma.adTarget.count({ where: { adGroupId: g.id, kind: 'AUTO' } }),
      prisma.adTarget.count({ where: { adGroupId: g.id, kind: 'AUTO', externalTargetId: { not: null } } }),
    ])
    paTotal += pa; paOn += paLive; tgTotal += tg; tgOn += tgLive
    negTotal += neg; negOn += negLive; autoTotal += au; autoOn += auLive
    console.log(`  ${c.name.replace('IT-AIRMESH-SP-','').padEnd(18)} ext=${c.externalCampaignId ? 'Y' : 'N'} ag=${g.externalAdGroupId ? 'Y' : 'N'}  ads ${paLive}/${pa}  kw ${tgLive}/${tg}  neg ${negLive}/${neg}  auto ${auLive}/${au}`)
  }
}
console.log(`\nTOTAL product ads on Amazon: ${paOn}/${paTotal}`)
console.log(`TOTAL keywords on Amazon:    ${tgOn}/${tgTotal}`)
console.log(`TOTAL negatives on Amazon:   ${negOn}/${negTotal}`)
console.log(`TOTAL auto clauses on Amazon:${autoOn}/${autoTotal}`)

const sample = await prisma.adProductAd.findMany({
  where: { adGroup: { campaign: { marketplace: 'IT', name: { startsWith: 'IT-AIRMESH-' } } } },
  select: { asin: true, sku: true, externalAdId: true }, take: 6,
})
console.log('\nsample rows:', JSON.stringify(sample))
await prisma.$disconnect()
