import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const names = ['GALE BROAD DE', 'GALE EXACT DE', 'DE_Auto_Substitute', 'DE_Auto_Close', 'DE_Auto_Complements', 'DE_Auto_Loose']
const camps = await prisma.campaign.findMany({
  where: { name: { in: names } },
  select: { id: true, name: true, marketplace: true, status: true, adGroups: { select: { id: true, name: true, status: true, productAds: { select: { productId: true }, where: { productId: { not: null } } } } } },
})
for (const c of camps) {
  for (const g of c.adGroups) {
    const prods = [...new Set(g.productAds.map((a) => a.productId))]
    console.log(`${c.marketplace} ${c.status} | ${c.name} › ${g.name} (${g.status}) agId=${g.id} products=[${prods.join(',')}]`)
  }
}
await prisma.$disconnect()
