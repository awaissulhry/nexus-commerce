/** _kt6-domain.mts — what domain/trigger values do the ads rules actually carry? READ-ONLY. */
import '../src/env.js'
import prisma from '../src/db.js'
async function main() {
  const byDomain = await prisma.automationRule.groupBy({ by: ['domain'], _count: { _all: true } })
  console.log('AutomationRule by domain:', byDomain.map((d) => `${d.domain}=${d._count._all}`).join(' · '))
  const byTrigger = await prisma.automationRule.groupBy({ by: ['trigger'], _count: { _all: true } })
  console.log('by trigger:', byTrigger.map((d) => `${d.trigger}=${d._count._all}`).join(' · '))
  const all = await prisma.automationRule.count()
  console.log('total rules:', all)
}
main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(String(e).slice(0,200)); await prisma.$disconnect(); process.exit(1) })
