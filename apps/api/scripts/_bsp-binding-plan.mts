import '../src/env.js'
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const TZ = "AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Rome'"

// ── 1 · coverage: which Rome days are usable (hourly cost >= 80% of the daily report) ──────────
const cov = await p.$queryRawUnsafe<Array<{ d: string; hrs: number; camps: number; hourly: number; daily: number }>>(`
  WITH h AS (
    SELECT to_char(("date" + make_interval(hours => "hour")) ${TZ}, 'YYYY-MM-DD') AS d,
           COUNT(DISTINCT "hour") AS hrs, COUNT(DISTINCT "localEntityId") AS camps,
           SUM("costMicros")::numeric / 1e6 AS hourly
    FROM "AmazonAdsHourlyPerformance" WHERE "entityType"='CAMPAIGN' AND "date" >= now() - interval '70 days'
    GROUP BY 1),
  dd AS (
    SELECT to_char("date", 'YYYY-MM-DD') AS d, SUM("costMicros")::numeric/1e6 AS daily
    FROM "AmazonAdsDailyPerformance" WHERE "entityType"='CAMPAIGN' AND "date" >= now() - interval '70 days'
    GROUP BY 1)
  SELECT h.d, h.hrs::int, h.camps::int, ROUND(h.hourly,2)::float8 AS hourly, ROUND(COALESCE(dd.daily,0),2)::float8 AS daily
  FROM h LEFT JOIN dd USING (d) ORDER BY h.d DESC LIMIT 24`)
console.log('=== 1 · coverage, most recent 24 Rome days ===')
console.log('  date        hrs camps    hourly€     daily€   cover%  usable')
for (const r of cov) {
  const c = r.daily > 0 ? (r.hourly / r.daily) * 100 : (r.hourly > 0 ? 100 : 0)
  console.log(`  ${r.d}  ${String(r.hrs).padStart(3)} ${String(r.camps).padStart(5)} ${r.hourly.toFixed(2).padStart(10)} ${r.daily.toFixed(2).padStart(10)} ${c.toFixed(0).padStart(7)}%  ${c >= 80 && r.hrs >= 24 ? 'YES' : 'no'}`)
}

// ── 2 · the budget-in-force walk-back, ported from _bs-page-binding.mts ────────────────────────
const camps = await p.campaign.findMany({ where: { status: { not: 'ARCHIVED' } }, select: { id: true, name: true, marketplace: true, dailyBudget: true, status: true } })
const writes = await p.advertisingActionLog.findMany({ where: { actionType: 'AD_BUDGET_UPDATE' }, select: { entityId: true, createdAt: true, payloadBefore: true, payloadAfter: true }, orderBy: { createdAt: 'desc' } })
const cents = (x: unknown): number | null => { const v = (x as Record<string, unknown> | null)?.dailyBudget; return v == null ? null : Number(v) * 100 }
const per = new Map<string, Array<{ at: Date; before: number | null; after: number | null }>>()
for (const w of writes) { const a = per.get(w.entityId) ?? []; a.push({ at: w.createdAt, before: cents(w.payloadBefore), after: cents(w.payloadAfter) }); per.set(w.entityId, a) }
let chainBreaks = 0
for (const [, ws] of per) { const asc = [...ws].reverse(); for (let i = 1; i < asc.length; i++) if (asc[i].before != null && asc[i-1].after != null && Math.abs((asc[i].before as number) - (asc[i-1].after as number)) > 0.5) chainBreaks++ }
const steps = new Map<string, Array<{ from: Date; cents: number }>>()
for (const [cid, ws] of per) { const asc = [...ws].reverse(); const out: Array<{ from: Date; cents: number }> = []
  if (asc[0]?.before != null) out.push({ from: new Date(0), cents: asc[0].before as number })
  for (const w of asc) if (w.after != null) out.push({ from: w.at, cents: w.after as number }); steps.set(cid, out) }
let noLog = 0
for (const c of camps) if (!steps.has(c.id)) { steps.set(c.id, [{ from: new Date(0), cents: Math.round(Number(c.dailyBudget ?? 0) * 100) }]); noLog++ }
const budgetAt = (cid: string, when: Date): number | null => { const s = steps.get(cid); if (!s?.length) return null; let v: number | null = null; for (const st of s) if (st.from <= when) v = st.cents; return v ?? s[0].cents }

const usable = cov.filter((r) => r.hrs >= 24 && (r.daily > 0 ? r.hourly / r.daily >= 0.8 : r.hourly > 0)).map((r) => r.d).sort()
const from = usable[0], to = usable[usable.length - 1]
console.log(`\n=== 2 · usable window: ${from} -> ${to}  (${usable.length} complete days) ===`)
const spendRows = await p.$queryRawUnsafe<Array<{ cid: string; d: string; spend: number; lasthour: number }>>(`
  SELECT "localEntityId" AS cid,
         to_char(("date" + make_interval(hours => "hour")) ${TZ}, 'YYYY-MM-DD') AS d,
         SUM("costMicros")::numeric/1e6 AS spend,
         MAX(CASE WHEN "costMicros" > 0 THEN EXTRACT(hour FROM ("date" + make_interval(hours => "hour")) ${TZ}) END)::int AS lasthour
  FROM "AmazonAdsHourlyPerformance"
  WHERE "entityType"='CAMPAIGN' AND "localEntityId" IS NOT NULL
    AND to_char(("date" + make_interval(hours => "hour")) ${TZ},'YYYY-MM-DD') = ANY($1::text[])
  GROUP BY 1,2 HAVING SUM("costMicros") > 0`, usable)

let days = 0, b100 = 0, b90 = 0, b50 = 0
const byCamp = new Map<string, { days: number; bind: number; maxR: number }>()
for (const r of spendRows) {
  const end = new Date(`${r.d}T23:59:59Z`); const bud = budgetAt(r.cid, end)
  if (bud == null || bud <= 0) continue
  const ratio = (Number(r.spend) * 100) / bud
  days++; if (ratio >= 1) b100++; if (ratio >= 0.9) b90++; if (ratio >= 0.5) b50++
  const e = byCamp.get(r.cid) ?? { days: 0, bind: 0, maxR: 0 }
  e.days++; if (ratio >= 0.9) e.bind++; e.maxR = Math.max(e.maxR, ratio); byCamp.set(r.cid, e)
}
const pc = (n: number) => `${((n / days) * 100).toFixed(1)}%`
console.log(`  campaign-days with spend: ${days}`)
console.log(`  >=100% of budget in force: ${b100}  (${pc(b100)})   [study: 32.7%]`)
console.log(`  >= 90%:                    ${b90}  (${pc(b90)})   [study: 36.6%]`)
console.log(`  >= 50%:                    ${b50}  (${pc(b50)})   [study: 56.5%]`)
console.log(`  campaigns binding >=90% at least once: ${[...byCamp.values()].filter((v) => v.bind > 0).length} of ${byCamp.size}   [study: 34 of 63]`)
console.log(`  reconstruction: writesRead=${writes.length} chainBreaks=${chainBreaks} campaignsWithoutLog=${noLog}`)

// control: using TODAY's budget instead, which the brief says gives ~86%
let ctl = 0, ctlDays = 0
const nowBud = new Map(camps.map((c) => [c.id, Math.round(Number(c.dailyBudget ?? 0) * 100)]))
for (const r of spendRows) { const bud = nowBud.get(r.cid); if (!bud) continue; ctlDays++; if ((Number(r.spend) * 100) / bud >= 1) ctl++ }
console.log(`  CONTROL using today's budget: ${((ctl / ctlDays) * 100).toFixed(1)}%  [brief says 86.1% — proves the walk-back matters]`)

// ── 3 · cursor candidates: what moves when the subject moves ───────────────────────────────────
const [maxHourlyCreated, maxHourlyReported, maxBudgetLog, hourlyRows24, budgetWrites24] = await Promise.all([
  p.amazonAdsHourlyPerformance.aggregate({ _max: { createdAt: true } }),
  p.amazonAdsHourlyPerformance.aggregate({ _max: { reportedAt: true } }),
  p.advertisingActionLog.aggregate({ where: { actionType: 'AD_BUDGET_UPDATE' }, _max: { createdAt: true } }),
  p.amazonAdsHourlyPerformance.count({ where: { createdAt: { gte: new Date(Date.now() - 864e5) } } }),
  p.advertisingActionLog.count({ where: { actionType: 'AD_BUDGET_UPDATE', createdAt: { gte: new Date(Date.now() - 864e5) } } }),
])
console.log(`\n=== 3 · cursor candidates ===`)
console.log(`  max(hourly.createdAt)  = ${maxHourlyCreated._max.createdAt?.toISOString()}   rows inserted in 24h: ${hourlyRows24}`)
console.log(`  max(hourly.reportedAt) = ${maxHourlyReported._max.reportedAt?.toISOString()}`)
console.log(`  max(AD_BUDGET_UPDATE)  = ${maxBudgetLog._max.createdAt?.toISOString()}   budget writes in 24h: ${budgetWrites24}`)
await p.$disconnect()
