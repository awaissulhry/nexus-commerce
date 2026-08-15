/** SOV.2 — which not-null spelling does THIS Prisma engine accept on a nullable String? */
import prisma from '../src/db.js'

async function tryOne(label: string, where: object) {
  try {
    const n = await prisma.adTarget.count({ where: where as never })
    console.log(`OK   ${label} → ${n}`)
  } catch (e) {
    console.log(`FAIL ${label} → ${(e as Error).message.split('\n').slice(-2).join(' ').slice(0, 120)}`)
  }
}

await tryOne("not: null", { isNegative: false, status: 'ENABLED', expressionValue: { not: null } })
await tryOne("NOT:{field:null}", { isNegative: false, status: 'ENABLED', NOT: { expressionValue: null } })
await tryOne("NOT:{field:{equals:null}}", { isNegative: false, status: 'ENABLED', NOT: { expressionValue: { equals: null } } })
await tryOne("gt: ''", { isNegative: false, status: 'ENABLED', expressionValue: { gt: '' } })
await prisma.$disconnect()
