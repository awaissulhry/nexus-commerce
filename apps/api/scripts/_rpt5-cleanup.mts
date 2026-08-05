import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
// Remove only the archived rows my lifecycle harness created — nothing else.
const del = await p.savedReport.deleteMany({ where: { isArchived: true } })
console.log('removed archived test rows:', del.count, '· remaining saved reports:', await p.savedReport.count())
await p.$disconnect(); process.exit(0)
