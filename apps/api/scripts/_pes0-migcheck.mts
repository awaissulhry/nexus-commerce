// PES.0 hub — READ-ONLY: which migrations landed today, and does the alias schema match PES.5 §2?
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const q = (sql: string) => prisma.$queryRawUnsafe<Record<string, unknown>[]>(sql)
console.log('recent migrations:', JSON.stringify(await q(
  `SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY finished_at DESC NULLS LAST LIMIT 6`), null, 1))
console.log('alias table cols:', JSON.stringify(await q(
  `SELECT column_name FROM information_schema.columns WHERE table_name='ProductListingAlias' ORDER BY ordinal_position`)))
console.log('ChannelListing.aliasId:', JSON.stringify(await q(
  `SELECT column_name FROM information_schema.columns WHERE table_name='ChannelListing' AND column_name='aliasId'`)))
console.log('CL unique indexes:', JSON.stringify(await q(
  `SELECT indexname FROM pg_indexes WHERE tablename='ChannelListing' AND indexdef ILIKE '%UNIQUE%' ORDER BY indexname`)))
await prisma.$disconnect()
