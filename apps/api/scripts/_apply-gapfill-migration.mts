import { readFileSync } from 'node:fs'
import { PrismaClient } from '@prisma/client'
const url = (process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL || '').replace('-pooler', '')
const prisma = new PrismaClient({ datasources: { db: { url } } })
const raw = readFileSync('../../packages/database/prisma/migrations/20260805b_rpt15_share_links/migration.sql', 'utf8')
// Strip comment LINES first, then split — a statement preceded by a comment
// block must not be discarded just because its chunk begins with "--".
const stripped = raw.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
const stmts = stripped.split(';').map((s) => s.trim()).filter(Boolean)
console.log(`statements: ${stmts.length}`)
for (const stmt of stmts) {
  console.log('→', stmt.replace(/\s+/g, ' ').slice(0, 95))
  const n = await prisma.$executeRawUnsafe(stmt)
  console.log('   rows affected:', n)
}
const chk = await prisma.$queryRawUnsafe<any[]>(`
  SELECT COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE "ingestedAt" IS NULL)::int AS unmarked
  FROM "AmazonAdsReportJob"`)
console.log('AmazonAdsReportJob:', JSON.stringify(chk[0]))
await prisma.$disconnect()
