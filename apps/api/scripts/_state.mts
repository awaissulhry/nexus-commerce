import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const r = await p.$queryRawUnsafe<Array<{t:string;n:bigint}>>(`
  SELECT table_name t, (SELECT COUNT(*) FROM "AdsConsoleRow")::bigint n
  FROM information_schema.tables
  WHERE table_name IN ('SavedReport','SavedReportVersion','ReportSchedule','ReportDelivery','AdsConsoleImport','AdsConsoleRow')
  ORDER BY 1`)
console.log('live tables:', r.map(x=>x.t).join(', '))
console.log('AdsConsoleRow rows on prod:', Number(r[0]?.n ?? 0).toLocaleString('en-GB'))
await p.$disconnect(); process.exit(0)
