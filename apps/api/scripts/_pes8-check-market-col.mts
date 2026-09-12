import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const c = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
  `SELECT column_name::text AS column_name FROM information_schema.columns WHERE table_name='ProductAiDraft' AND column_name='market'`)
console.log('market column:', c.length ? 'PRESENT' : 'MISSING')
const m = await prisma.$queryRawUnsafe<{ n: string }[]>(
  `SELECT migration_name::text AS n FROM "_prisma_migrations" WHERE migration_name LIKE '20260901d%'`)
console.log('migration recorded:', m.length ? m[0].n : 'NO')
await prisma.$disconnect()
