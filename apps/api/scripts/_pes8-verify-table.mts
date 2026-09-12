import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const cols = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
  `SELECT column_name::text AS column_name FROM information_schema.columns WHERE table_name = 'ProductAiDraft' ORDER BY ordinal_position`)
console.log('cols:', cols.length, cols.map(c=>c.column_name).join(','))
const idx = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
  `SELECT indexname::text AS indexname FROM pg_indexes WHERE tablename = 'ProductAiDraft'`)
console.log('indexes:', idx.map(i=>i.indexname).join(', '))
const migs = await prisma.$queryRawUnsafe<{ migration_name: string; finished_at: Date|null }[]>(
  `SELECT migration_name::text AS migration_name, finished_at FROM "_prisma_migrations" ORDER BY started_at DESC LIMIT 8`)
console.log('recent migrations:'); for (const m of migs) console.log('  ', m.migration_name, m.finished_at ? 'ok' : 'UNFINISHED')
const n = await prisma.$queryRawUnsafe<{ c: bigint }[]>(`SELECT count(*)::bigint AS c FROM "ProductAiDraft"`)
console.log('rows:', Number(n[0].c))
await prisma.$disconnect()
