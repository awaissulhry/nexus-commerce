import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'
const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })
let url = process.env.DATABASE_URL
if (!url) { console.error('DATABASE_URL missing'); process.exit(1) }
url = url.replace('-pooler', '')
const c = new pg.Client({ connectionString: url })
await c.connect()
const r1 = await c.query(`SELECT "abcClass", count(*) FROM "Product" WHERE "isParent"=false GROUP BY "abcClass" ORDER BY count(*) DESC LIMIT 10`)
console.log('abcClass distribution:'); console.table(r1.rows)
const r2 = await c.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND (table_name ILIKE '%automat%' OR table_name ILIKE '%scenario%' OR table_name ILIKE '%vmi%' OR table_name ILIKE '%mrp%' OR table_name ILIKE '%demand%') ORDER BY table_name`).catch(()=>({rows:[]}))
console.log('automation/scenario/demand tables:'); console.table(r2.rows)
const r3 = await c.query(`SELECT "jobName", "startedAt", status FROM "CronRun" WHERE "jobName" IN ('forecast','forecast-accuracy','abc-classification','fba-restock-ingestion','sales-report-ingest') ORDER BY "startedAt" DESC LIMIT 15`)
console.log('forecast/abc/fba/sales cron history:'); console.table(r3.rows)
const r4 = await c.query(`SELECT count(*) AS rows, MIN(day) AS oldest, MAX(day) AS newest FROM "DailySalesAggregate"`).catch(()=>({rows:[{note:'no table'}]}))
console.log('DailySalesAggregate:'); console.table(r4.rows)
await c.end()
