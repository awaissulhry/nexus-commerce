const { default: prisma } = await import('../src/db.js')
const rows = await prisma.$queryRaw<any[]>`
  SELECT migration_name::text AS name, started_at, finished_at, rolled_back_at, applied_steps_count
  FROM _prisma_migrations
  WHERE finished_at IS NULL AND rolled_back_at IS NULL
  ORDER BY started_at DESC`
console.log('FAILED / IN-FLIGHT migrations (finished_at IS NULL AND rolled_back_at IS NULL):', rows.length)
for (const r of rows) console.log(' ', r)
const last = await prisma.$queryRaw<any[]>`
  SELECT migration_name::text AS name, finished_at FROM _prisma_migrations ORDER BY started_at DESC LIMIT 4`
console.log('\nlast applied:'); for (const r of last) console.log(' ', r.name, r.finished_at)
const already = await prisma.$queryRaw<any[]>`
  SELECT 1 FROM _prisma_migrations WHERE migration_name = '20260819a_map2_account_dimension'`
console.log('\nMAP.2a already recorded:', already.length > 0)
await prisma.$disconnect()
