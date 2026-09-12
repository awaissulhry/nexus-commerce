import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const cols = await prisma.$queryRawUnsafe<Record<string,unknown>[]>(`
  SELECT column_name::text AS col FROM information_schema.columns
  WHERE table_name='AmazonAdsDailyPerformance' ORDER BY ordinal_position`)
console.log(cols.map(c=>c.col).join(', '))
await prisma.$disconnect()
