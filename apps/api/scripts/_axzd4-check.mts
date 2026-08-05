const { default: p } = await import('../src/db.js')
const mig = await p.$queryRawUnsafe<Array<Record<string,unknown>>>(
  `SELECT migration_name::text m, finished_at::text f FROM _prisma_migrations WHERE migration_name='20260728_axzd4_ad_drift'`)
console.log('MIGRATION', JSON.stringify(mig))
const n = await p.adDrift.count()
const open = await p.adDrift.count({ where: { resolvedAt: null } })
const byClass = await p.adDrift.groupBy({ by: ['classification'], _count: true })
console.log('DRIFT rows=', n, 'open=', open, 'byClass=', JSON.stringify(byClass.map(b=>({c:b.classification,n:b._count}))))
const rows = await p.adDrift.findMany({ where: { resolvedAt: null }, orderBy: { lastDetectedAt: 'desc' }, take: 6,
  select: { entityName: true, marketplace: true, field: true, ourValue: true, amazonValue: true, classification: true, occurrences: true, firstDetectedAt: true } })
for (const r of rows) console.log(` ${(r.entityName ?? '').slice(0,26).padEnd(28)} [${r.marketplace}] ${r.field.padEnd(16)} ours=${String(r.ourValue).padEnd(10)} amazon=${String(r.amazonValue).padEnd(10)} ${r.classification} x${r.occurrences}`)
await p.$disconnect()
