import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient({ log: [] })
const j = (x: unknown) => JSON.stringify(x, (_k,v)=> typeof v==='bigint'?Number(v):v)
console.log('last 6 applied on prod:')
console.log(j(await prisma.$queryRawUnsafe(`
  SELECT migration_name, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back
  FROM _prisma_migrations ORDER BY started_at DESC LIMIT 6`)))
console.log('\nfailed/unfinished (the P3009 test — needs BOTH conditions):')
console.log(j(await prisma.$queryRawUnsafe(`
  SELECT migration_name FROM _prisma_migrations
  WHERE finished_at IS NULL AND rolled_back_at IS NULL`)))
await prisma.$disconnect()
