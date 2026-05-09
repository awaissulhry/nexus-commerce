#!/usr/bin/env node
// Read-only check: are the DO.30 / DO.32 / DO.33 migrations already
// applied to the connected DB? Tells the operator whether the next
// `prisma migrate deploy` will be a no-op or will create tables.
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(here, '..', '.env') })

const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()

async function tableExists(table) {
  const r = await c.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema='public' AND table_name=$1
     ) AS e`,
    [table],
  )
  return r.rows[0].e
}

async function columnExists(table, column) {
  const r = await c.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 AND column_name=$2
     ) AS e`,
    [table, column],
  )
  return r.rows[0].e
}

async function migrationApplied(name) {
  try {
    const r = await c.query(
      `SELECT 1 FROM "_prisma_migrations" WHERE migration_name=$1 LIMIT 1`,
      [name],
    )
    return r.rowCount > 0
  } catch {
    return false
  }
}

console.log('=== DO.30 / W12: Goal model ===')
console.log('  Goal table exists:           ', await tableExists('Goal'))
console.log(
  '  20260509_w12_goal_model:     ',
  (await migrationApplied('20260509_w12_goal_model')) ? 'applied' : 'PENDING',
)

console.log('\n=== DO.32 / W14: DashboardLayout ===')
console.log(
  '  DashboardLayout table:       ',
  await tableExists('DashboardLayout'),
)
console.log(
  '  20260509_w14_dashboard_layout:',
  (await migrationApplied('20260509_w14_dashboard_layout')) ? 'applied' : 'PENDING',
)

console.log('\n=== DO.33 / W14: widgetOrder column ===')
console.log(
  '  DashboardLayout.widgetOrder: ',
  (await columnExists('DashboardLayout', 'widgetOrder')) ? 'present' : 'MISSING',
)
console.log(
  '  20260509_w14_widget_order:   ',
  (await migrationApplied('20260509_w14_widget_order')) ? 'applied' : 'PENDING',
)

console.log('\n=== DO.39 / W14: DashboardView ===')
console.log('  DashboardView table:         ', await tableExists('DashboardView'))
console.log(
  '  DashboardLayout.activeViewId:',
  (await columnExists('DashboardLayout', 'activeViewId')) ? 'present' : 'MISSING',
)
console.log(
  '  20260509_w14_dashboard_view: ',
  (await migrationApplied('20260509_w14_dashboard_view')) ? 'applied' : 'PENDING',
)

console.log('\n=== DO.40 / W15: ScheduledReport ===')
console.log(
  '  ScheduledReport table:       ',
  await tableExists('ScheduledReport'),
)
console.log(
  '  20260509_w15_scheduled_report:',
  (await migrationApplied('20260509_w15_scheduled_report')) ? 'applied' : 'PENDING',
)

console.log('\nNote: migrations apply via `prisma migrate deploy` on next')
console.log('Railway deploy. Per memory: strip -pooler from DATABASE_URL when')
console.log('running `prisma migrate deploy` directly.')

await c.end()
