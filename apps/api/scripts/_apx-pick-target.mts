/** NAF.AQ.8 — READ-ONLY: pick one real, non-negative ad target to seed against. */
import '../src/env.js'
import prisma from '../src/db.js'
const t = await prisma.adTarget.findFirst({
  where: { isNegative: false, bidCents: { gt: 10 } },
  select: { id: true, expressionValue: true, expressionType: true, bidCents: true,
    adGroup: { select: { campaign: { select: { name: true, marketplace: true } } } } },
})
console.log(JSON.stringify(t, null, 1))
await prisma.$disconnect()
