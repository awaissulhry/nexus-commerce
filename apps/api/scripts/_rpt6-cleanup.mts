import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
// Cascade removes the schedule and its deliveries with the saved report.
const del = await p.savedReport.deleteMany({ where: { name: { in: ['Weekly search terms', 'RPT6 harness'] } } })
console.log('removed test saved reports:', del.count)
console.log('remaining -> savedReports:', await p.savedReport.count(),
  '· schedules:', await p.reportSchedule.count(), '· deliveries:', await p.reportDelivery.count())
await p.$disconnect(); process.exit(0)
