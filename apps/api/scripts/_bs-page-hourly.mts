/**
 * BS page study — part 2. The hourly substrate a budget schedule would sit on:
 * coverage, the 23:00 hole, whether any campaign ever exhausts its daily budget,
 * the pacing header, and the audit-log horizon. READ-ONLY.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

// ── 0 · what columns does the hourly table actually have? ─────────────────────
const cols = await prisma.$queryRaw<Array<{ column_name: string }>>`
  SELECT column_name::text AS column_name FROM information_schema.columns
  WHERE table_name = 'AmazonAdsHourlyPerformance' ORDER BY ordinal_position`
console.log(`\n=== 0 · AmazonAdsHourlyPerformance columns ===\n  ${cols.map((c) => c.column_name).join(', ')}`)

// ── 1 · Coverage, on WHOLE WEEKS ending at the last complete Rome day ─────────
// (same window discipline as GET /advertising/dayparting/heatmap, which is the
//  better of the two hourly endpoints; hourly-performance uses raw 60 days.)
const cov = await prisma.$queryRaw<Array<{ days: bigint; first: Date; last: Date; rows: bigint; spend: bigint; ents: bigint }>>`
  SELECT COUNT(DISTINCT "date")::bigint AS days, MIN("date") AS first, MAX("date") AS last,
         COUNT(*)::bigint AS rows, SUM("costMicros") AS spend,
         COUNT(DISTINCT "localEntityId")::bigint AS ents
  FROM "AmazonAdsHourlyPerformance"
  WHERE "date" >= (NOW() AT TIME ZONE 'Europe/Rome')::date - INTERVAL '56 days'
    AND "date" <  (NOW() AT TIME ZONE 'Europe/Rome')::date`
const c0 = cov[0]
console.log(`\n=== 1 · Hourly coverage, last 8 complete weeks (Rome) ===`)
console.log(`  ${Number(c0.rows)} rows · ${Number(c0.days)} distinct days · ${Number(c0.ents)} distinct localEntityId`)
console.log(`  window present: ${c0.first?.toISOString().slice(0, 10)} → ${c0.last?.toISOString().slice(0, 10)}  (56 days requested)`)
console.log(`  spend in hourly: €${(Number(c0.spend ?? 0n) / 1e6).toFixed(2)}`)

const daily = await prisma.$queryRaw<Array<{ spend: bigint; days: bigint; ents: bigint }>>`
  SELECT SUM("costMicros") AS spend, COUNT(DISTINCT "date")::bigint AS days,
         COUNT(DISTINCT "localEntityId")::bigint AS ents
  FROM "AmazonAdsDailyPerformance"
  WHERE "entityType" = 'CAMPAIGN'
    AND "date" >= (NOW() AT TIME ZONE 'Europe/Rome')::date - INTERVAL '56 days'
    AND "date" <  (NOW() AT TIME ZONE 'Europe/Rome')::date`
const d0 = daily[0]
console.log(`  spend in DAILY (CAMPAIGN): €${(Number(d0.spend ?? 0n) / 1e6).toFixed(2)} · ${Number(d0.days)} days · ${Number(d0.ents)} campaigns`)
console.log(`  → hourly covers ${((Number(c0.spend ?? 0n) / Math.max(1, Number(d0.spend ?? 0n))) * 100).toFixed(1)}% of daily-reported spend`)

// per-day coverage: which days are missing hours?
const perDay = await prisma.$queryRaw<Array<{ d: Date; hrs: bigint; sp: bigint }>>`
  SELECT "date" AS d, COUNT(DISTINCT "hour")::bigint AS hrs, SUM("costMicros") AS sp
  FROM "AmazonAdsHourlyPerformance"
  WHERE "date" >= (NOW() AT TIME ZONE 'Europe/Rome')::date - INTERVAL '14 days'
  GROUP BY "date" ORDER BY "date" DESC`
console.log(`  last 14 days, distinct UTC hours present per day (24 = complete):`)
for (const r of perDay) console.log(`    ${r.d.toISOString().slice(0, 10)}  hours=${String(Number(r.hrs)).padStart(2)}  €${(Number(r.sp ?? 0n) / 1e6).toFixed(2)}`)

// ── 2 · Hour-of-day in ROME, and the 23:00 hole the builder cannot cover ──────
const byHour = await prisma.$queryRaw<Array<{ hour: number; sp: bigint; sales: bigint; clicks: bigint; orders: bigint }>>`
  SELECT EXTRACT(HOUR FROM ts)::int AS hour, SUM("costMicros") AS sp,
         SUM(COALESCE("sales7dCents",0))::bigint AS sales, SUM("clicks")::bigint AS clicks,
         SUM(COALESCE("orders7d",0))::bigint AS orders
  FROM (
    SELECT (("date" + (("hour")::text || ' hours')::interval) AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Rome') AS ts,
           "costMicros", "sales7dCents", "clicks", "orders7d"
    FROM "AmazonAdsHourlyPerformance"
    WHERE "date" >= (NOW() AT TIME ZONE 'Europe/Rome')::date - INTERVAL '56 days'
      AND "date" <  (NOW() AT TIME ZONE 'Europe/Rome')::date
  ) t GROUP BY hour ORDER BY hour`
const totSp = byHour.reduce((s, r) => s + Number(r.sp ?? 0n), 0)
console.log(`\n=== 2 · Hour of day (Rome), 8 complete weeks ===`)
console.log(`  hh    spend   %spend    sales   ROAS  clicks  orders`)
for (const r of byHour) {
  const sp = Number(r.sp ?? 0n) / 1e6, sa = Number(r.sales ?? 0n) / 100
  console.log(`  ${String(r.hour).padStart(2, '0')}  €${sp.toFixed(2).padStart(7)}  ${((sp / (totSp / 1e6)) * 100).toFixed(1).padStart(5)}%  €${sa.toFixed(2).padStart(8)}  ${(sp > 0 ? (sa / sp).toFixed(2) : '—').padStart(6)}  ${String(Number(r.clicks)).padStart(6)}  ${String(Number(r.orders)).padStart(6)}`)
}
const h23 = byHour.find((r) => r.hour === 23)
console.log(`  → hour 23:00 (unreachable by the builder's window grammar): €${(Number(h23?.sp ?? 0n) / 1e6).toFixed(2)} = ${(((Number(h23?.sp ?? 0n)) / Math.max(1, totSp)) * 100).toFixed(1)}% of spend`)

// ── 3 · Does ANY campaign ever exhaust its daily budget? ──────────────────────
// A budget schedule only matters for a campaign that runs dry. Proxy: per
// (campaign, day) hourly spend vs that campaign's CURRENT daily budget.
console.log(`\n=== 3 · Do campaigns run out of budget? (hourly spend vs current daily budget) ===`)
const cd = await prisma.$queryRaw<Array<{ eid: string; d: Date; sp: bigint; lasthr: number; hrs: bigint }>>`
  SELECT "localEntityId" AS eid, "date" AS d, SUM("costMicros") AS sp,
         MAX("hour")::int AS lasthr, COUNT(DISTINCT "hour")::bigint AS hrs
  FROM "AmazonAdsHourlyPerformance"
  WHERE "localEntityId" IS NOT NULL AND "costMicros" > 0
    AND "date" >= (NOW() AT TIME ZONE 'Europe/Rome')::date - INTERVAL '28 days'
    AND "date" <  (NOW() AT TIME ZONE 'Europe/Rome')::date
  GROUP BY 1, 2`
const camps = await prisma.campaign.findMany({ select: { id: true, name: true, marketplace: true, dailyBudget: true, status: true } })
const cby = new Map(camps.map((c) => [c.id, c]))
let hit100 = 0, hit90 = 0, hit50 = 0, total = 0, noBudget = 0
const perCampHits = new Map<string, { hits: number; days: number; maxRatio: number }>()
for (const r of cd) {
  const c = cby.get(r.eid); if (!c) continue
  const b = Number(c.dailyBudget ?? 0); if (b <= 0) { noBudget++; continue }
  const sp = Number(r.sp ?? 0n) / 1e6
  const ratio = sp / b
  total++
  if (ratio >= 1) hit100++
  if (ratio >= 0.9) hit90++
  if (ratio >= 0.5) hit50++
  const p = perCampHits.get(r.eid) ?? { hits: 0, days: 0, maxRatio: 0 }
  p.days++; if (ratio >= 0.9) p.hits++; p.maxRatio = Math.max(p.maxRatio, ratio)
  perCampHits.set(r.eid, p)
}
console.log(`  campaign-days with spend, last 28 complete days: ${total} (skipped ${noBudget} with no/zero budget)`)
console.log(`  reached >= 100% of daily budget: ${hit100} (${((hit100 / Math.max(1, total)) * 100).toFixed(1)}%)`)
console.log(`  reached >=  90%:                 ${hit90} (${((hit90 / Math.max(1, total)) * 100).toFixed(1)}%)`)
console.log(`  reached >=  50%:                 ${hit50} (${((hit50 / Math.max(1, total)) * 100).toFixed(1)}%)`)
console.log(`  campaigns that hit >=90% on at least one day: ${[...perCampHits.values()].filter((p) => p.hits > 0).length} of ${perCampHits.size} with spend`)
console.log(`  top 12 by max(day spend / daily budget):`)
for (const [id, p] of [...perCampHits].sort((a, b) => b[1].maxRatio - a[1].maxRatio).slice(0, 12)) {
  const c = cby.get(id)!
  console.log(`    ${String(c.name).slice(0, 34).padEnd(34)} ${String(c.marketplace).padEnd(3)} ${c.status.padEnd(8)} budget=€${Number(c.dailyBudget ?? 0).toFixed(2).padStart(6)}  maxDay=${(p.maxRatio * 100).toFixed(0).padStart(4)}%  days>=90%: ${p.hits}/${p.days}`)
}

// ── 4 · The pacing header, exactly as GET /advertising/budget-manager returns ──
console.log(`\n=== 4 · Pacing (analyzeBudgetManager, the live service) ===`)
const { analyzeBudgetManager } = await import('../src/services/advertising/ads-budget-manager.service.js')
const bm = await analyzeBudgetManager()
console.log(`  month=${bm.month} day ${bm.dayOfMonth}/${bm.daysInMonth}`)
console.log(`  mkt  tag  budget      spent      pct    expected  status      forecast   projOver  autoPace  stopOver`)
for (const r of bm.rows) {
  console.log(`  ${r.marketplace.padEnd(4)} ${String(r.tag ?? '—').padEnd(4)} €${(r.monthlyBudgetCents / 100).toFixed(2).padStart(9)} €${((r.spendCents ?? 0) / 100).toFixed(2).padStart(9)} ${r.pct == null ? '   —' : (r.pct * 100).toFixed(1).padStart(5) + '%'} ${(r.expectedPct * 100).toFixed(1).padStart(8)}% ${r.status.padEnd(11)} €${((r.forecastSpendCents ?? 0) / 100).toFixed(2).padStart(9)} ${String(r.projectedOverspend).padEnd(9)} ${String(r.autoPacing).padEnd(9)} ${r.stopOverSpend}`)
}
console.log(`  TOTALS: budget €${(bm.totals.budgetCents / 100).toFixed(2)} · spent €${(bm.totals.spendCents / 100).toFixed(2)} · ${bm.totals.pct == null ? '—' : (bm.totals.pct * 100).toFixed(1) + '%'}`)

// ── 5 · Audit-log horizon — how far back can a "change log on the page" see? ──
console.log(`\n=== 5 · AdvertisingActionLog horizon ===`)
const oldest = await prisma.advertisingActionLog.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true, actionType: true } })
const oldestBudget = await prisma.advertisingActionLog.findFirst({ where: { actionType: 'AD_BUDGET_UPDATE' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } })
const totalLog = await prisma.advertisingActionLog.count()
const totalBudget = await prisma.advertisingActionLog.count({ where: { actionType: 'AD_BUDGET_UPDATE' } })
console.log(`  total rows: ${totalLog} · AD_BUDGET_UPDATE: ${totalBudget}`)
console.log(`  oldest row overall:  ${oldest?.createdAt.toISOString()} (${oldest?.actionType})`)
console.log(`  oldest AD_BUDGET_UPDATE: ${oldestBudget?.createdAt.toISOString()}`)
const byDay = await prisma.$queryRaw<Array<{ d: string; n: bigint; writers: bigint }>>`
  SELECT to_char("createdAt" AT TIME ZONE 'Europe/Rome', 'YYYY-MM-DD') AS d, COUNT(*)::bigint AS n,
         COUNT(DISTINCT "userId")::bigint AS writers
  FROM "AdvertisingActionLog" WHERE "actionType" = 'AD_BUDGET_UPDATE'
  GROUP BY 1 ORDER BY 1 DESC LIMIT 20`
console.log(`  AD_BUDGET_UPDATE per day (Rome):`)
for (const r of byDay) console.log(`    ${r.d}  ${String(Number(r.n)).padStart(5)} rows · ${Number(r.writers)} writers`)

await prisma.$disconnect()
