import { config } from 'dotenv'
config({ path: '/Users/awais/nexus-commerce/.env' })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const weekAgo = new Date(Date.now() - 7 * 86_400_000)

const run = async (label: string, where: Record<string, unknown>) => {
  const g = await p.automationRuleExecution.groupBy({
    by: ['status'], where: { startedAt: { gte: weekAgo }, ...where }, _count: { _all: true },
  })
  const m: Record<string, number> = {}
  for (const r of g) m[r.status] = r._count._all
  console.log(`${label.padEnd(26)} ${JSON.stringify(m)}`)
}

await run('no filter (truth)', {})
await run('SHIPPED (NOT:)', { NOT: { errorMessage: 'DAILY_CAP_EXCEEDED' } })
await run('FIXED (OR + null)', { OR: [{ errorMessage: null }, { errorMessage: { not: 'DAILY_CAP_EXCEEDED' } }] })
await p.$disconnect()
