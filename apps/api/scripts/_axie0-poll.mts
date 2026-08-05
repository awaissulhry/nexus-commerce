const { default: p } = await import('../src/db.js')
const r = await p.$queryRawUnsafe<Array<Record<string, unknown>>>(
  `SELECT migration_name::text AS m, finished_at::text AS f FROM _prisma_migrations
    WHERE migration_name IN ('20260728_axie0_correctness','20260728_ax25_blueprint_application','20260728_ax24_ad_blueprint')
    ORDER BY finished_at`)
console.log('APPLIED', JSON.stringify(r))
await p.$disconnect()
