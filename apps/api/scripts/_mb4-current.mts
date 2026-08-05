/** READ-ONLY: current live placement % vs the MB.4 cap, for the campaigns the ceiling would bind. */
const { default: prisma } = await import('../src/db.js')
const names = ['GALE EXACT DE','GALE | IT | Exact | Category','GALE | IT | Exact | Competitor','GALE | IT | PAT','GALE | IT | Exact | Brand','IT-AIRMESH-SP-Auto','GALE | IT | Auto']
const cs = await prisma.campaign.findMany({ where: { name: { in: names } }, select: { name: true, dynamicBidding: true, biddingStrategy: true } })
for (const c of cs) {
  const pb = ((c.dynamicBidding ?? {}) as { placementBidding?: Array<{ placement: string; percentage: number }> }).placementBidding ?? []
  console.log(`${c.name.padEnd(32)} ${pb.map(p => `${p.placement.replace('PLACEMENT_','')}=${p.percentage}%`).join(' ') || '(no placement bidding set)'}`)
}
await prisma.$disconnect()
