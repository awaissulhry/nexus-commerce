/** ACR.5 — are 150 pending proposals 150 findings, or the same ones re-queued? READ-ONLY. */
import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = <T = Record<string, unknown>>(s: string) => p.$queryRawUnsafe<T[]>(s)
const n = (v: unknown) => (typeof v === 'bigint' ? Number(v) : v)
const show = (rows: Record<string, unknown>[], max = 20) => rows.length
  ? rows.slice(0, max).forEach((r) => console.log('  ' + Object.entries(r).map(([k, v]) => `${k}=${String(n(v)).slice(0,70)}`).join('  ')))
  : console.log('  (none)')
const h = (s: string) => console.log(`\n── ${s} ──`)

h('1. pending proposals over time — is this accumulating or churning?')
show(await q(`SELECT DATE("createdAt")::text AS day, COUNT(*)::int AS created,
    COUNT(*) FILTER (WHERE status='pending')::int AS still_pending
  FROM "AdsRuleSuggestion" WHERE "createdAt" > now() - interval '10 days'
  GROUP BY 1 ORDER BY 1 DESC`), 12)

h('2. DUPLICATES — same rule, same entity, same proposed action, queued more than once')
show(await q(`SELECT "ruleName", "proposedKey", "entityId", COUNT(*)::int AS times,
    MIN("createdAt")::text AS first_seen, MAX("createdAt")::text AS last_seen
  FROM "AdsRuleSuggestion" WHERE status='pending'
  GROUP BY 1,2,3 HAVING COUNT(*) > 1 ORDER BY 4 DESC`), 15)

h('3. the headline: distinct findings vs rows')
show(await q(`SELECT COUNT(*)::int AS pending_rows,
    COUNT(DISTINCT ("ruleId" || '|' || "entityId" || '|' || "proposedKey"))::int AS distinct_findings
  FROM "AdsRuleSuggestion" WHERE status='pending'`))

h('4. by rule')
show(await q(`SELECT COALESCE("ruleName",'(unnamed)') AS rule, COUNT(*)::int AS pending,
    COUNT(DISTINCT ("entityId" || '|' || "proposedKey"))::int AS distinct_findings
  FROM "AdsRuleSuggestion" WHERE status='pending' GROUP BY 1 ORDER BY 2 DESC`), 15)

await p.$disconnect()
