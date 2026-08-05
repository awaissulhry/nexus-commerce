import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const rows = await p.$queryRawUnsafe<Array<{ migration_name: string; finished_at: Date | null }>>(
  `SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY started_at DESC LIMIT 6`)
console.log('most recent APPLIED migrations on prod:')
for (const r of rows) console.log(' ', r.migration_name, r.finished_at ? '✓' : '⚠ unfinished')
await p.$disconnect(); process.exit(0)
