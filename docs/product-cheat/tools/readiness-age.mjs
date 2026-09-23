// Step 2.7 (A-30 / R-28) — when were the ReadinessIndex rows computed, and did the nightly sweep (15.1) run?
// READ ONLY: one `BEGIN READ ONLY` transaction, rolled back. Nothing is written.
// Default target: production (root .env). `--local`: the local catalogue (apps/api/.env), as a dry run.
// Every timestamp is formatted as UTC TEXT inside SQL: `pg` reads a Prisma `timestamp without time zone` as LOCAL time.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire('/Users/awais/nexus-commerce/apps/api/package.json')
const { Client } = require('pg')
const dotenv = require('dotenv')

const local = process.argv.includes('--local')
const env = dotenv.parse(readFileSync(local ? '/Users/awais/nexus-commerce/apps/api/.env' : '/Users/awais/nexus-commerce/.env'))
const url = new URL(env.DATABASE_URL)
console.log('target host:', url.hostname, 'db:', url.pathname, local ? '(local dry run)' : '(production, read only)')
if (local ? url.hostname !== '127.0.0.1' : !/neon\.tech$/.test(url.hostname)) { console.error('REFUSE: unexpected host'); process.exit(1) }

// The deploy of main 0a563d6d5 (Railway SUCCESS 06:46 UTC). A row computed before it used the old rules.
const DEPLOYED = '2026-09-23 06:46:00'
// The nightly sweep's horizon (`readiness-reconcile.job.ts` DUE_AFTER_MS): a root is due when no row of it is newer.
const DUE_HOURS = 20
const utc = col => `to_char(${col}, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`

const c = new Client({ connectionString: env.DATABASE_URL, statement_timeout: 30000 })
await c.connect()
const out = {}
try {
  await c.query('BEGIN READ ONLY')
  out.role = (await c.query(`SELECT current_user AS user, rolbypassrls FROM pg_roles WHERE rolname = current_user`)).rows[0]
  out.readOnly = (await c.query(`SHOW transaction_read_only`)).rows[0].transaction_read_only
  out.dbNow = (await c.query(`SELECT ${utc(`(now() AT TIME ZONE 'UTC')`)} AS now`)).rows[0].now
  // Positive controls: row security can make "could not see" look like "nothing there".
  out.productRowsVisible = (await c.query(`SELECT count(*)::int AS n FROM "Product"`)).rows[0].n
  out.readinessRowsVisible = (await c.query(`SELECT count(*)::int AS n FROM "ReadinessIndex"`)).rows[0].n
  out.cronRowsVisible = (await c.query(`SELECT count(*)::int AS n FROM "CronRun"`)).rows[0].n
  out.workspaces = (await c.query(`SELECT id, name, status, "isLegacy" AS legacy FROM "Workspace" ORDER BY "createdAt"`)).rows

  // 1. Age of the stored rows, per business: before / after the deploy.
  out.age = (await c.query(`
    SELECT r."workspaceId" AS ws, count(*)::int AS rows, count(DISTINCT r."productId")::int AS products,
      ${utc('min(r."computedAt")')} AS oldest, ${utc('max(r."computedAt")')} AS newest,
      count(*) FILTER (WHERE r."computedAt" < $1::timestamp)::int AS rows_before_deploy,
      count(*) FILTER (WHERE r."computedAt" >= $1::timestamp)::int AS rows_after_deploy
    FROM "ReadinessIndex" r GROUP BY 1 ORDER BY 1`, [DEPLOYED])).rows

  // 2. When they were written: per business and UTC hour, with how many families (roots) each hour touched.
  out.hours = (await c.query(`
    SELECT r."workspaceId" AS ws, ${utc(`date_trunc('hour', r."computedAt")`)} AS hour, count(*)::int AS rows,
      count(DISTINCT coalesce(p."parentId", p.id))::int AS families
    FROM "ReadinessIndex" r JOIN "Product" p ON p.id = r."productId"
    GROUP BY 1, 2 ORDER BY 1, 2`)).rows

  // 3. What the nightly job itself recorded (recordCronRun → CronRun), newest first.
  out.cron = (await c.query(`
    SELECT "workspaceId" AS ws, ${utc('"startedAt"')} AS started, ${utc('"finishedAt"')} AS finished,
      round(extract(epoch FROM ("finishedAt" - "startedAt")))::int AS seconds, status, "triggeredBy" AS by,
      left("outputSummary", 240) AS summary, left("errorMessage", 400) AS error
    FROM "CronRun" WHERE "jobName" = 'readiness-reconcile' ORDER BY "startedAt" DESC LIMIT 30`)).rows

  // 4. What the NEXT tick would pick: the job's own predicate (`dueFamilies`) — a live root with no row of its own
  //    newer than the horizon. Plus roots whose newest row predates the deploy (old rules), and roots with no row.
  out.due = (await c.query(`
    WITH roots AS (
      SELECT p."workspaceId" AS ws, p.id,
        (SELECT max(r."computedAt") FROM "ReadinessIndex" r WHERE r."productId" = p.id) AS newest,
        (SELECT count(*) FROM "Product" k WHERE k."parentId" = p.id AND k."deletedAt" IS NULL)::int AS children
      FROM "Product" p WHERE p."parentId" IS NULL AND p."deletedAt" IS NULL)
    SELECT ws, count(*)::int AS live_roots, sum(children)::int AS live_children, max(children)::int AS biggest_family,
      count(*) FILTER (WHERE newest IS NULL)::int AS roots_without_rows,
      count(*) FILTER (WHERE newest IS NULL OR newest < (now() AT TIME ZONE 'UTC') - make_interval(hours => $2))::int AS due_now,
      count(*) FILTER (WHERE newest < $1::timestamp)::int AS newest_row_before_deploy
    FROM roots GROUP BY 1 ORDER BY 1`, [DEPLOYED, DUE_HOURS])).rows

  // 5. Coverage for 2.7's "Done when": live products (children too) with no row at all, or only rows older than the deploy.
  out.coverage = (await c.query(`
    SELECT p."workspaceId" AS ws, count(*)::int AS live_products,
      count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM "ReadinessIndex" r WHERE r."productId" = p.id))::int AS without_rows,
      count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM "ReadinessIndex" r WHERE r."productId" = p.id AND r."computedAt" >= $1::timestamp))::int AS no_row_since_deploy
    FROM "Product" p WHERE p."deletedAt" IS NULL GROUP BY 1 ORDER BY 1`, [DEPLOYED])).rows
  await c.query('ROLLBACK')
} finally {
  await c.end()
}
console.log('SUMMARY ' + JSON.stringify({ role: out.role, readOnly: out.readOnly, dbNow: out.dbNow, productRowsVisible: out.productRowsVisible, readinessRowsVisible: out.readinessRowsVisible, cronRowsVisible: out.cronRowsVisible, deployed: DEPLOYED + 'Z' }))
for (const w of out.workspaces) console.log('WORKSPACE ' + JSON.stringify(w))
for (const a of out.age) console.log('AGE ' + JSON.stringify(a))
for (const h of out.hours) console.log('HOUR ' + JSON.stringify(h))
for (const r of out.cron) console.log('CRON ' + JSON.stringify(r))
for (const d of out.due) console.log('DUE ' + JSON.stringify(d))
for (const v of out.coverage) console.log('COVERAGE ' + JSON.stringify(v))
