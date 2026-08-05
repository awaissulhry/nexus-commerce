import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const del = await p.savedReport.deleteMany({ where: { name: { in: ['Top spend campaigns'] } } })
console.log('removed test saved reports:', del.count, '· remaining:', await p.savedReport.count(), '· versions:', await p.savedReportVersion.count())
await p.$disconnect(); process.exit(0)
