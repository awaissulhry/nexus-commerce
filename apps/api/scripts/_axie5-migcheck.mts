const { default: p } = await import('../src/db.js')
const r = await p.$queryRawUnsafe<Array<Record<string,unknown>>>(
  `SELECT migration_name::text m, finished_at::text f FROM _prisma_migrations WHERE migration_name='20260728_axie5_import_plan'`)
console.log('MIGRATION', JSON.stringify(r))
await p.$disconnect()
