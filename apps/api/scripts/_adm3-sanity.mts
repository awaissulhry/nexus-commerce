/** ADM.3 — pre-deploy sanity on the new sums: units, sameSKU, halo, ASP. */
import prisma from '../src/db.js'
const since = new Date('2026-08-20'), until = new Date('2026-08-26')
const ids = (await prisma.campaign.findMany({ where: { adProduct: 'SPONSORED_PRODUCTS' }, select: { id: true, name: true }, take: 400 }))
const byId = new Map(ids.map((c) => [c.id, c.name]))
const g = await prisma.amazonAdsDailyPerformance.groupBy({
  by: ['localEntityId'],
  where: { entityType: 'CAMPAIGN', localEntityId: { in: ids.map((c) => c.id) }, date: { gte: since, lte: until } },
  _sum: { sales7dCents: true, units7d: true, salesSameSku7dCents: true, ordersSameSku7d: true, unitsSameSku7d: true },
  _count: { units7d: true, salesSameSku7dCents: true, ordersSameSku7d: true, unitsSameSku7d: true },
})
const n = (v: any) => Number(v ?? 0)
let neg = 0, nullUnits = 0, nullSame = 0, withData = 0
console.log('campaign                       sales€  units  sameSKU€  halo€  halo%   ASP€')
for (const r of g) {
  const salesC = n(r._sum.sales7dCents)
  const units = r._count.units7d > 0 ? n(r._sum.units7d) : null
  const sameC = r._count.salesSameSku7dCents > 0 ? n(r._sum.salesSameSku7dCents) : null
  const otherC = sameC == null ? null : Math.max(0, salesC - sameC)
  const asp = units == null || units <= 0 ? null : salesC / 100 / units
  if (units == null) nullUnits++
  if (sameC == null) nullSame++
  if (sameC != null && salesC - sameC < 0) neg++
  if (salesC > 0) { withData++
    if (withData <= 8) console.log(`  ${String(byId.get(r.localEntityId!)).slice(0,28).padEnd(28)} ${(salesC/100).toFixed(2).padStart(7)} ${String(units ?? 'null').padStart(6)} ${sameC==null?'  null':(sameC/100).toFixed(2).padStart(8)} ${otherC==null?' null':(otherC/100).toFixed(2).padStart(6)} ${otherC==null||salesC<=0?'  null':((otherC/salesC)*100).toFixed(0).padStart(5)+'%'} ${asp==null?' null':asp.toFixed(2).padStart(6)}`)
  }
}
console.log(`\ngroups=${g.length}  withSales=${withData}  units=null on ${nullUnits}  sameSKU=null on ${nullSame}`)
console.log(`raw sameSKU > sales (would go negative, now clamped to 0): ${neg}`)
await prisma.$disconnect()
