// PLAN (handoff 8) — node docs/product-cheat/tools/nightly-lines.cjs. READ ONLY (production): the latest CronRun lines of the two nightly jobs, and the readiness rows computed since the
// 2026-09-24 deploy (Railway 495a2006 SUCCESS 14:59 UTC). One BEGIN READ ONLY transaction, rolled back.
// Timestamps are formatted as UTC text inside SQL (pg reads Prisma `timestamp without time zone` as local time).
const { Client } = require('/Users/awais/nexus-commerce/node_modules/pg')
const dotenv = require('/Users/awais/nexus-commerce/node_modules/dotenv')
const env = dotenv.parse(require('fs').readFileSync('/Users/awais/nexus-commerce/.env'))
const url = new URL(env.DATABASE_URL)
if (!/neon\.tech$/.test(url.hostname)) { console.error('REFUSE: unexpected host ' + url.hostname); process.exit(1) }
const UTC = 'YYYY-MM-DD"T"HH24:MI:SS"Z"'
const DEPLOYED = '2026-09-24 14:59:00'
;(async () => {
  const c = new Client({ connectionString: env.DATABASE_URL, statement_timeout: 30000 })
  await c.connect()
  await c.query('BEGIN READ ONLY')
  const runs = (await c.query(
    `select "jobName", status, "workspaceId", to_char("startedAt", $1) as started, to_char("finishedAt", $1) as finished,
            left(coalesce("outputSummary", ''), 220) as summary, left(coalesce("errorMessage", ''), 160) as error
       from "CronRun" where "jobName" in ('content-drift', 'readiness-reconcile') order by "startedAt" desc limit 8`, [UTC])).rows
  console.log('--- CronRun, newest first')
  for (const r of runs) console.log(`${r.started} → ${r.finished ?? '(running)'} ${r.jobName} ${r.status} ws=${r.workspaceId ?? '-'} :: ${r.summary}${r.error ? ' !! ' + r.error : ''}`)
  const since = (await c.query(
    `select count(*)::int as n, to_char(max("computedAt"), $1) as newest from "ReadinessIndex" where "computedAt" >= $2::timestamp`, [UTC, DEPLOYED]
  ).catch((e) => ({ rows: [{ n: 'n/a: ' + e.message }] }))).rows[0]
  console.log('--- ReadinessIndex rows computed since the deploy:', since)
  const drift = (await c.query(
    `select channel, count(*)::int as rows, count(*) filter (where "driftCount" > 0)::int as drifted,
            count(*) filter (where "checkedBySource" ? 'amazon-content')::int as amazon_content_checked
       from "ChannelDrift" group by channel order by channel`
  ).catch((e) => ({ rows: [{ source: 'n/a: ' + e.message }] }))).rows
  console.log('--- ChannelDrift rows by source:', JSON.stringify(drift))
  const byLang = (await c.query(
    `select "workspaceId" as ws, coalesce(language, '-') as lang, count(*)::int as rows, round(avg(pct), 1)::float as avg_pct,
            sum("requiredFilled")::int as req_filled, sum("requiredTotal")::int as req_total, to_char(max("computedAt"), $1) as newest
       from "ReadinessIndex" group by 1, 2 order by 1, 2`, [UTC])).rows
  console.log('--- ReadinessIndex by business and language (A-50 lowers non-Italian % after the first nightly on the new code)')
  for (const r of byLang) console.log(`${r.ws} ${r.lang}: rows ${r.rows} · avg ${r.avg_pct}% · required ${r.req_filled}/${r.req_total} · newest ${r.newest}`)
  await c.query('ROLLBACK')
  await c.end()
})().catch((e) => { console.error('ERR', e.message); process.exit(1) })
