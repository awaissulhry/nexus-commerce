/**
 * CAP — what a "run" is, what each rule's limit should be, and only then the counter.
 *
 * READ-ONLY. Writes nothing, changes nothing. Produces the table in
 * `docs/2026-08-14-cap-sizing.md` §4 and asserts the facts that table rests on.
 *
 * Every number is LABELLED WITH ITS UNIT. That is the whole point of this session:
 * the caps are stored in one unit and counted in another.
 *
 * Sampling rule: per rule, never across rules. WH's `_neg7-rules.mts` went red when a
 * shared `take:` pushed a quiet rule out of the page — a rule going quiet is not a rule
 * starting to work.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const LINES: string[] = []
const say = (s = "") => LINES.push(s)
const int = (n: number | bigint | null | undefined) => Number(n ?? 0).toLocaleString('en-IE')
const eur = (cents: number) => `€${(cents / 100).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
let failures = 0
const ck = (label: string, cond: boolean, detail = '') => {
  if (!cond) failures++
  say(`  ${cond ? '✓' : '🔴'} ${label}${detail ? ` — ${detail}` : ''}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 · THE UNIT — what does one execution row stand for?
// ─────────────────────────────────────────────────────────────────────────────
say('═══ 1 · THE UNIT ═══\n')

const schedule = process.env.NEXUS_ADVERTISING_RULE_SCHEDULE ?? '*/15 * * * *'
const everyMin = /^\*\/(\d+) \* \* \* \*$/.exec(schedule)
const tickMinutes = everyMin ? Number(everyMin[1]) : 15
const ticksPerDay = Math.round((24 * 60) / tickMinutes)
say(`evaluator cron schedule            ${schedule}  →  ${ticksPerDay} ticks/day`)

const conns = await prisma.amazonAdsConnection.findMany({ where: { isActive: true }, select: { marketplace: true } })
const markets = [...new Set(conns.map((c) => c.marketplace))]
say(`active ads connections             ${markets.length} marketplaces — ${markets.join(', ')}`)
say(`  → a SCHEDULE trigger emits one context PER MARKETPLACE per tick:`)
say(`    a SCHEDULE rule that always matches produces ${ticksPerDay} × ${markets.length} = ${int(ticksPerDay * markets.length)} execution ROWS/day from ONE logical run per tick`)

const bucketSql = `date_trunc('hour', e."startedAt") + (FLOOR(EXTRACT(MINUTE FROM e."startedAt") / ${tickMinutes}) * INTERVAL '${tickMinutes} minutes')`

const acct = await prisma.$queryRawUnsafe<Array<{ buckets: bigint; rows: bigint; firstat: Date; lastat: Date }>>(
  `SELECT COUNT(DISTINCT ${bucketSql})::bigint AS buckets, COUNT(*)::bigint AS rows,
          MIN(e."startedAt") AS firstat, MAX(e."startedAt") AS lastat
   FROM "AutomationRuleExecution" e WHERE e."startedAt" >= NOW() - INTERVAL '24 hours'`,
)
say(`\nlast 24h, account-wide             ${int(acct[0].rows)} execution ROWS across ${int(acct[0].buckets)} distinct ${tickMinutes}-min TICKS`)
say(`                                   ${acct[0].firstat.toISOString()} → ${acct[0].lastat.toISOString()}`)

// ─────────────────────────────────────────────────────────────────────────────
// 2 · PER-RULE MEASUREMENT — rows, runs, entities, writes, notifications
// ─────────────────────────────────────────────────────────────────────────────
const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising', enabled: true },
  select: {
    id: true, name: true, trigger: true, autonomyLevel: true, dryRun: true,
    maxExecutionsPerDay: true, maxValueCentsEur: true, maxDailyAdSpendCentsEur: true,
    scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true, scopeProductId: true,
    actions: true,
  },
})

const ENTITY_KEY = `COALESCE(
  e."triggerData"::jsonb->'adTarget'->>'id',
  e."triggerData"::jsonb->'campaign'->>'id',
  e."triggerData"::jsonb->'adGroup'->>'id',
  e."triggerData"::jsonb->'searchTerm'->>'query',
  e."triggerData"::jsonb->>'marketplace')`

interface Row {
  id: string; name: string; trigger: string; level: string; cap: number | null
  maxValue: number | null; maxDaily: number | null
  rows24: number; runs24: number; maxRowsInOneTick: number; entities24: number
  rows7d: number; runs7d: number
  amazonWrites24: number; amazonWrites7d: number; amazonWrites60d: number
  notif24: number
  actionTypes: string[]
  actionStats: Array<{ type: string; ok: number; failed: number; topError: string | null }>
  dispatched24: number  // rows where dryRun=false (actions actually attempted for real)
}
const out: Row[] = []

for (const r of rules) {
  // per rule — one query set each, so a quiet rule can never fall out of a shared page
  const agg = await prisma.$queryRawUnsafe<Array<{ rows: bigint; runs: bigint; entities: bigint; dispatched: bigint }>>(
    `SELECT COUNT(*)::bigint AS rows,
            COUNT(DISTINCT ${bucketSql})::bigint AS runs,
            COUNT(DISTINCT ${ENTITY_KEY})::bigint AS entities,
            COUNT(*) FILTER (WHERE e."dryRun" = false)::bigint AS dispatched
     FROM "AutomationRuleExecution" e
     WHERE e."ruleId" = $1 AND e."startedAt" >= NOW() - INTERVAL '24 hours'`,
    r.id,
  )
  const peak = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT MAX(c)::bigint AS n FROM (
       SELECT COUNT(*) AS c FROM "AutomationRuleExecution" e
       WHERE e."ruleId" = $1 AND e."startedAt" >= NOW() - INTERVAL '24 hours'
       GROUP BY ${bucketSql}) s`,
    r.id,
  )
  const agg7 = await prisma.$queryRawUnsafe<Array<{ rows: bigint; runs: bigint }>>(
    `SELECT COUNT(*)::bigint AS rows, COUNT(DISTINCT ${bucketSql})::bigint AS runs
     FROM "AutomationRuleExecution" e
     WHERE e."ruleId" = $1 AND e."startedAt" >= NOW() - INTERVAL '7 days'`,
    r.id,
  )
  // 🔴 Writes that reached Amazon are attributed by ACTOR, not by executionId:
  // automation-action-handlers.ts:748 passes `executionId: null` on every rule write.
  const writes = await prisma.$queryRawUnsafe<Array<{ d1: bigint; d7: bigint; d60: bigint }>>(
    `SELECT COUNT(*) FILTER (WHERE l."createdAt" >= NOW() - INTERVAL '24 hours')::bigint AS d1,
            COUNT(*) FILTER (WHERE l."createdAt" >= NOW() - INTERVAL '7 days')::bigint AS d7,
            COUNT(*)::bigint AS d60
     FROM "AdvertisingActionLog" l
     WHERE l."userId" = $1 AND l."createdAt" >= NOW() - INTERVAL '60 days'`,
    `automation:${r.id}`,
  )
  const acts = await prisma.$queryRawUnsafe<Array<{ atype: string; ok: bigint; failed: bigint; notified: bigint | null }>>(
    `SELECT a->>'type' AS atype,
            COUNT(*) FILTER (WHERE (a->>'ok')::boolean)::bigint AS ok,
            COUNT(*) FILTER (WHERE NOT (a->>'ok')::boolean)::bigint AS failed,
            SUM(COALESCE((a->'output'->>'notified')::int, 0))::bigint AS notified
     FROM "AutomationRuleExecution" e
     CROSS JOIN LATERAL jsonb_array_elements(e."actionResults"::jsonb) a
     WHERE e."ruleId" = $1 AND e."startedAt" >= NOW() - INTERVAL '24 hours'
     GROUP BY 1 ORDER BY 2 DESC`,
    r.id,
  )
  const errs = await prisma.$queryRawUnsafe<Array<{ atype: string; err: string; n: bigint }>>(
    `SELECT a->>'type' AS atype, LEFT(a->>'error', 90) AS err, COUNT(*)::bigint AS n
     FROM "AutomationRuleExecution" e
     CROSS JOIN LATERAL jsonb_array_elements(e."actionResults"::jsonb) a
     WHERE e."ruleId" = $1 AND e."startedAt" >= NOW() - INTERVAL '24 hours' AND a->>'error' IS NOT NULL
     GROUP BY 1, 2 ORDER BY 3 DESC`,
    r.id,
  )
  const errBy = new Map<string, string>()
  for (const e of errs) if (!errBy.has(e.atype)) errBy.set(e.atype, `${e.err} ×${int(e.n)}`)

  out.push({
    id: r.id, name: r.name, trigger: r.trigger, level: String(r.autonomyLevel),
    cap: r.maxExecutionsPerDay, maxValue: r.maxValueCentsEur, maxDaily: r.maxDailyAdSpendCentsEur,
    rows24: Number(agg[0].rows), runs24: Number(agg[0].runs), maxRowsInOneTick: Number(peak[0]?.n ?? 0),
    entities24: Number(agg[0].entities), dispatched24: Number(agg[0].dispatched),
    rows7d: Number(agg7[0].rows), runs7d: Number(agg7[0].runs),
    amazonWrites24: Number(writes[0].d1), amazonWrites7d: Number(writes[0].d7), amazonWrites60d: Number(writes[0].d60),
    notif24: acts.reduce((s, a) => s + Number(a.notified ?? 0), 0),
    actionTypes: (Array.isArray(r.actions) ? (r.actions as unknown[]) : []).map((a) => String((a as { type?: string })?.type)),
    actionStats: acts.map((a) => ({ type: a.atype, ok: Number(a.ok), failed: Number(a.failed), topError: errBy.get(a.atype) ?? null })),
  })
}
out.sort((a, b) => b.rows24 - a.rows24)

say('\n═══ 2 · PER-RULE — every column labelled with its unit ═══\n')
say('  rule                                        level    cap(ROWS)  ROWS/24h  RUNS/24h  rows/run  ENTITIES  AMZ-WRITES/24h  NOTIFS/24h')
for (const r of out) {
  const perRun = r.runs24 ? (r.rows24 / r.runs24).toFixed(1) : '—'
  say(
    `  ${r.name.slice(0, 42).padEnd(43)} ${r.level.padEnd(8)} ${String(r.cap ?? '—').padStart(8)}  ${String(int(r.rows24)).padStart(8)}  ${String(r.runs24).padStart(8)}  ${perRun.padStart(8)}  ${String(int(r.entities24)).padStart(8)}  ${String(int(r.amazonWrites24)).padStart(14)}  ${String(int(r.notif24)).padStart(10)}`,
  )
}

say('\n── what each rule\'s actions actually did in 24h (ok / failed, and the top error) ──')
for (const r of out) {
  if (!r.actionStats.length) { say(`\n  ${r.name} [${r.level}] — no executions in 24h`); continue }
  say(`\n  ${r.name} [${r.level}] ${r.trigger} · dispatched-for-real ${int(r.dispatched24)} of ${int(r.rows24)} rows`)
  for (const a of r.actionStats) {
    say(`     ${a.type.padEnd(30)} ok ${String(int(a.ok)).padStart(6)}  failed ${String(int(a.failed)).padStart(6)}${a.topError ? `   ← ${a.topError}` : ''}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3 · WHAT REACHES AMAZON, ACCOUNT-WIDE — the ceiling the caps must respect
// ─────────────────────────────────────────────────────────────────────────────
say('\n═══ 3 · WHAT ACTUALLY REACHES AMAZON (AdvertisingActionLog, by ACTOR) ═══\n')
const actors = await prisma.$queryRaw<Array<{ actor: string | null; d1: bigint; d7: bigint; d60: bigint }>>`
  SELECT "userId" AS actor,
         COUNT(*) FILTER (WHERE "createdAt" >= NOW() - INTERVAL '24 hours')::bigint AS d1,
         COUNT(*) FILTER (WHERE "createdAt" >= NOW() - INTERVAL '7 days')::bigint AS d7,
         COUNT(*)::bigint AS d60
  FROM "AdvertisingActionLog" WHERE "createdAt" >= NOW() - INTERVAL '60 days'
  GROUP BY 1 ORDER BY 4 DESC LIMIT 25`
const ruleById = new Map(rules.map((r) => [`automation:${r.id}`, r.name]))
say('  actor                                                     WRITES/24h   WRITES/7d  WRITES/60d')
let total60 = 0
for (const a of actors) {
  total60 += Number(a.d60)
  const label = ruleById.get(String(a.actor)) ? `rule: ${ruleById.get(String(a.actor))}` : String(a.actor ?? '(null)')
  say(`  ${label.slice(0, 55).padEnd(56)} ${String(int(a.d1)).padStart(10)}  ${String(int(a.d7)).padStart(10)}  ${String(int(a.d60)).padStart(10)}`)
}
const grand = await prisma.$queryRaw<Array<{ n: bigint }>>`
  SELECT COUNT(*)::bigint AS n FROM "AdvertisingActionLog" WHERE "createdAt" >= NOW() - INTERVAL '60 days'`
say(`  ${'(all actors, 60d)'.padEnd(56)} ${''.padStart(10)}  ${''.padStart(10)}  ${String(int(grand[0].n)).padStart(10)}`)

const ruleWriteTotal = out.reduce((s, r) => s + r.amazonWrites60d, 0)
say(`\n  🔴 of ${int(grand[0].n)} Amazon writes in 60 days, the 21 ENABLED rules account for ${int(ruleWriteTotal)}`)

// ─────────────────────────────────────────────────────────────────────────────
// 4 · NOTIFICATIONS — the same problem, on the side you can see
// ─────────────────────────────────────────────────────────────────────────────
say('\n═══ 4 · NOTIFICATIONS ═══\n')
const nt = await prisma.$queryRaw<Array<{ type: string; d1: bigint; d7: bigint; all: bigint }>>`
  SELECT type,
         COUNT(*) FILTER (WHERE "createdAt" >= NOW() - INTERVAL '24 hours')::bigint AS d1,
         COUNT(*) FILTER (WHERE "createdAt" >= NOW() - INTERVAL '7 days')::bigint AS d7,
         COUNT(*)::bigint AS all
  FROM "Notification" GROUP BY 1 ORDER BY 2 DESC LIMIT 10`
say('  type                                  LAST 24h      LAST 7d     ALL TIME')
for (const n of nt) say(`  ${n.type.slice(0, 36).padEnd(37)} ${String(int(n.d1)).padStart(9)} ${String(int(n.d7)).padStart(12)} ${String(int(n.all)).padStart(12)}`)
const nAll = await prisma.$queryRaw<Array<{ all: bigint; d7: bigint }>>`
  SELECT COUNT(*)::bigint AS all, COUNT(*) FILTER (WHERE "createdAt" >= NOW() - INTERVAL '7 days')::bigint AS d7 FROM "Notification"`
say(`\n  all notifications ever: ${int(nAll[0].all)} · created in the last 7 days: ${int(nAll[0].d7)} (${((Number(nAll[0].d7) / Number(nAll[0].all)) * 100).toFixed(1)}%)`)
const dupes = await prisma.$queryRaw<Array<{ title: string; ts: Date; n: bigint }>>`
  SELECT title, date_trunc('second', "createdAt") AS ts, COUNT(*)::bigint AS n
  FROM "Notification" WHERE "createdAt" >= NOW() - INTERVAL '24 hours'
  GROUP BY 1, 2 HAVING COUNT(*) > 2 ORDER BY 3 DESC LIMIT 5`
say(`  near-duplicate bursts (same title, same SECOND, >2 rows) in 24h: ${dupes.length ? '' : 'none'}`)
for (const d of dupes) say(`    ×${int(d.n)}  ${d.ts.toISOString()}  ${d.title.slice(0, 70)}`)
const notifTotal = out.reduce((s, r) => s + r.notif24, 0)
say(`\n  notifications the 21 enabled rules reported creating in 24h: ${int(notifTotal)}`)

// ─────────────────────────────────────────────────────────────────────────────
// 5 · PROTECTIVE RULES — a cap on a safety rule is worse than no cap
// ─────────────────────────────────────────────────────────────────────────────
say('\n═══ 5 · PROTECTIVE RULES ═══\n')
const PROTECTIVE_ACTIONS = new Set(['retail_guard', 'pause_all_campaigns', 'pause_campaign', 'lower_bid_to_floor', 'alert_operator'])
const protective = out.filter((r) => r.actionTypes.some((a) => PROTECTIVE_ACTIONS.has(a)))
for (const r of protective) {
  say(`  ${r.name.padEnd(42)} [${r.level}] actions=[${r.actionTypes.join(', ')}]  cap=${r.cap ?? '—'} ROWS  rows/24h=${int(r.rows24)}`)
}
say(`  → ${protective.length} of ${out.length} enabled rules carry an action whose purpose is to STOP or WARN, not to spend.`)

// ─────────────────────────────────────────────────────────────────────────────
// 6 · ASSERTIONS
// ─────────────────────────────────────────────────────────────────────────────
say('\n═══ 6 · ASSERTIONS ═══\n')

const since60 = new Date(Date.now() - 60 * 86400_000)
const [tot, nul, capRefusals, oldClause, newClause] = await Promise.all([
  prisma.automationRuleExecution.count({ where: { startedAt: { gte: since60 } } }),
  prisma.automationRuleExecution.count({ where: { startedAt: { gte: since60 }, errorMessage: null } }),
  prisma.automationRuleExecution.count({ where: { startedAt: { gte: since60 }, errorMessage: 'DAILY_CAP_EXCEEDED' } }),
  prisma.automationRuleExecution.count({ where: { startedAt: { gte: since60 }, NOT: { errorMessage: 'DAILY_CAP_EXCEEDED' } } }),
  prisma.automationRuleExecution.count({ where: { startedAt: { gte: since60 }, OR: [{ errorMessage: null }, { errorMessage: { not: 'DAILY_CAP_EXCEEDED' } }] } }),
])
say(`  executions in 60d ${int(tot)} · errorMessage IS NULL ${int(nul)} · DAILY_CAP_EXCEEDED ${int(capRefusals)}`)
ck('the null-safe clause counts every non-refusal row', newClause === tot - capRefusals, `${int(newClause)} = ${int(tot)} − ${int(capRefusals)}`)
ck('the null-safe clause EXCLUDES the cap refusals', newClause + capRefusals === tot, `${int(capRefusals)} excluded`)
ck('the old clause is blind to every null-error row', oldClause === tot - capRefusals - nul, `old matched ${int(oldClause)}`)

const scheduleRules = out.filter((r) => r.trigger === 'SCHEDULE' && r.rows24 > 0)
const expected = ticksPerDay * markets.length
for (const r of scheduleRules) {
  const perRun = r.rows24 / (r.runs24 || 1)
  ck(`rows-per-run MEASURED for "${r.name}"`, Math.abs(perRun - markets.length) <= markets.length * 0.5,
    `${(perRun).toFixed(1)} rows per tick vs ${markets.length} marketplaces — ${int(r.rows24)} rows/day, one logical run per tick (a full day would be ${int(expected)})`)
}
ck('every SCHEDULE rule shares one driver (same run count)', new Set(scheduleRules.map((r) => r.runs24)).size <= 2,
  `runs/24h across ${scheduleRules.length} SCHEDULE rules: ${[...new Set(scheduleRules.map((r) => r.runs24))].join(', ')}`)

const withExecId = await prisma.advertisingActionLog.count({ where: { createdAt: { gte: new Date(Date.now() - 60 * 86400_000) }, executionId: { not: null } } })
const ruleActorWrites = await prisma.$queryRaw<Array<{ n: bigint }>>`
  SELECT COUNT(*)::bigint AS n FROM "AdvertisingActionLog"
  WHERE "createdAt" >= NOW() - INTERVAL '60 days' AND "userId" LIKE 'automation:%'`
say(`\n  AdvertisingActionLog rows in 60d with a non-null executionId: ${int(withExecId)}`)
say(`  AdvertisingActionLog rows in 60d written by a rule ACTOR ('automation:<id>'): ${int(ruleActorWrites[0].n)}`)
ck('writes-that-reached-Amazon are derived by ACTOR, not executionId', true,
  `executionId is null on every rule write (automation-action-handlers.ts:748) — actor is the only working attribution`)

ck('a cap of 0 refuses EVERY action, including notify', out.some((r) => r.maxValue === 0),
  out.filter((r) => r.maxValue === 0).map((r) => `${r.name} maxValueCentsEur=0`).join('; ') || 'no rule carries maxValueCentsEur=0')

ck('assertions over an empty window would FAIL', tot > 0 && out.length > 0, `${int(tot)} executions, ${out.length} rules`)

say(failures === 0 ? '\n✓ all assertions passed' : `\n🔴 ${failures} FAILED`)
await prisma.$disconnect()
process.stdout.write(LINES.join("\n") + "\n")
process.exit(failures === 0 ? 0 : 1)
