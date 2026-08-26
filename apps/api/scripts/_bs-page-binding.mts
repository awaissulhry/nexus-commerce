/**
 * BS page study — part 3. The decisive question: does a daily budget actually BIND?
 *
 * Part 2 compared historical spend to TODAY's budget, which is confounded by the
 * ratchet (docs/2026-08-11-bud-budget-study.md §3): 58 of 86 campaigns were cut to
 * €1 in the first week of August, so a day in July looks "1305% over budget" purely
 * because the budget moved afterwards. Here the budget in force on each day is
 * RECONSTRUCTED by walking AdvertisingActionLog backwards from the current value.
 *
 * Also: the true shape of the hourly feed, and who wrote budgets on which day.
 * READ-ONLY.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

// ── 1 · The hourly feed's real shape, day by day ─────────────────────────────
console.log(`\n=== 1 · Hourly feed, every day of the last 8 weeks ===`)
const perDay = await prisma.$queryRaw<Array<{ d: Date; hrs: bigint; rows: bigint; sp: bigint; ents: bigint }>>`
  SELECT "date" AS d, COUNT(DISTINCT "hour")::bigint AS hrs, COUNT(*)::bigint AS rows,
         SUM("costMicros") AS sp, COUNT(DISTINCT "localEntityId")::bigint AS ents
  FROM "AmazonAdsHourlyPerformance"
  WHERE "date" >= (NOW() AT TIME ZONE 'Europe/Rome')::date - INTERVAL '56 days'
  GROUP BY "date" ORDER BY "date"`
const dailyByDay = await prisma.$queryRaw<Array<{ d: Date; sp: bigint }>>`
  SELECT "date" AS d, SUM("costMicros") AS sp FROM "AmazonAdsDailyPerformance"
  WHERE "entityType" = 'CAMPAIGN' AND "date" >= (NOW() AT TIME ZONE 'Europe/Rome')::date - INTERVAL '56 days'
  GROUP BY "date" ORDER BY "date"`
const dmap = new Map(dailyByDay.map((r) => [r.d.toISOString().slice(0, 10), Number(r.sp ?? 0n) / 1e6]))
let liveFrom: string | null = null
console.log(`  date        hrs  rows  campaigns   hourly€   daily€   cover%`)
for (const r of perDay) {
  const k = r.d.toISOString().slice(0, 10)
  const h = Number(r.sp ?? 0n) / 1e6, d = dmap.get(k) ?? 0
  const cover = d > 0 ? (h / d) * 100 : null
  if (cover != null && cover >= 80 && liveFrom == null) liveFrom = k
  if (cover != null && cover < 80) liveFrom = null
  console.log(`  ${k}  ${String(Number(r.hrs)).padStart(3)} ${String(Number(r.rows)).padStart(5)} ${String(Number(r.ents)).padStart(10)}   €${h.toFixed(2).padStart(7)}  €${d.toFixed(2).padStart(7)}  ${cover == null ? '   —' : cover.toFixed(0).padStart(4)}%`)
}
console.log(`  → longest unbroken run of >=80% coverage starts: ${liveFrom ?? 'none'}`)

// ── 2 · Reconstruct the budget in force, per campaign per day ────────────────
console.log(`\n=== 2 · Budget in force, reconstructed from the audit log ===`)
const camps = await prisma.campaign.findMany({ select: { id: true, name: true, marketplace: true, dailyBudget: true, status: true } })
const cby = new Map(camps.map((c) => [c.id, c]))
const writes = await prisma.advertisingActionLog.findMany({
  where: { actionType: 'AD_BUDGET_UPDATE' },
  select: { entityId: true, createdAt: true, payloadBefore: true, payloadAfter: true },
  orderBy: { createdAt: 'desc' },
})
// UNIT: EUROS. Verified by _bs-page-units.mts — for 77 of 83 campaigns the newest
// payloadAfter.dailyBudget equals Campaign.dailyBudget exactly, and for 0 does it
// equal it after dividing by 100.
const cents = (p: unknown): number | null => {
  const v = (p as Record<string, unknown> | null)?.dailyBudget
  return v == null ? null : Number(v) * 100 // euros → cents, so the rest of the script is one unit
}
// per campaign, walk back from the current value: budget BEFORE write W = W.payloadBefore
const timeline = new Map<string, Array<{ at: Date; budgetCents: number }>>() // value in force FROM `at`
for (const c of camps) timeline.set(c.id, [{ at: new Date(0), budgetCents: Math.round(Number(c.dailyBudget ?? 0) * 100) }])
const perCampWrites = new Map<string, Array<{ at: Date; before: number | null; after: number | null }>>()
for (const w of writes) {
  const a = perCampWrites.get(w.entityId) ?? []
  a.push({ at: w.createdAt, before: cents(w.payloadBefore), after: cents(w.payloadAfter) })
  perCampWrites.set(w.entityId, a)
}
// build a forward step function: [{from, cents}]
const steps = new Map<string, Array<{ from: Date; cents: number }>>()
for (const [cid, ws] of perCampWrites) {
  const c = cby.get(cid); if (!c) continue
  const asc = [...ws].reverse() // oldest first
  const out: Array<{ from: Date; cents: number }> = []
  const first = asc[0]
  if (first?.before != null) out.push({ from: new Date(0), cents: first.before })
  for (const w of asc) if (w.after != null) out.push({ from: w.at, cents: w.after })
  steps.set(cid, out)
}
for (const c of camps) if (!steps.has(c.id)) steps.set(c.id, [{ from: new Date(0), cents: Math.round(Number(c.dailyBudget ?? 0) * 100) }])
const budgetAt = (cid: string, when: Date): number | null => {
  const s = steps.get(cid); if (!s || !s.length) return null
  let v: number | null = null
  for (const st of s) { if (st.from <= when) v = st.cents; else break }
  return v
}

// ── 3 · Campaign-day spend vs the budget in force that day ───────────────────
const cd = await prisma.$queryRaw<Array<{ eid: string; d: Date; sp: bigint; lasthr: number; firsthr: number }>>`
  SELECT "localEntityId" AS eid, "date" AS d, SUM("costMicros") AS sp,
         MAX("hour")::int AS lasthr, MIN("hour")::int AS firsthr
  FROM "AmazonAdsHourlyPerformance"
  WHERE "localEntityId" IS NOT NULL AND "costMicros" > 0
    AND "date" >= DATE '2026-08-03' AND "date" < (NOW() AT TIME ZONE 'Europe/Rome')::date
  GROUP BY 1, 2 ORDER BY 2, 1`
console.log(`\n=== 3 · Campaign-days on the COMPLETE hourly window (2026-08-03 →) ===`)
let n = 0, over100 = 0, over90 = 0, over50 = 0, noB = 0
const per = new Map<string, { days: number; binding: number; maxR: number; spend: number }>()
for (const r of cd) {
  const c = cby.get(r.eid); if (!c) continue
  const when = new Date(r.d); when.setUTCHours(23, 0, 0, 0)
  const b = budgetAt(r.eid, when)
  if (b == null || b <= 0) { noB++; continue }
  const sp = Number(r.sp ?? 0n) / 1e6
  const ratio = sp / (b / 100)
  n++
  if (ratio >= 1) over100++
  if (ratio >= 0.9) over90++
  if (ratio >= 0.5) over50++
  const p = per.get(r.eid) ?? { days: 0, binding: 0, maxR: 0, spend: 0 }
  p.days++; p.spend += sp; if (ratio >= 0.9) p.binding++; p.maxR = Math.max(p.maxR, ratio)
  per.set(r.eid, p)
}
console.log(`  campaign-days with spend: ${n} (skipped ${noB} with no reconstructable budget)`)
console.log(`  spend >= 100% of the budget IN FORCE: ${over100} (${((over100 / Math.max(1, n)) * 100).toFixed(1)}%)`)
console.log(`  spend >=  90%:                        ${over90} (${((over90 / Math.max(1, n)) * 100).toFixed(1)}%)`)
console.log(`  spend >=  50%:                        ${over50} (${((over50 / Math.max(1, n)) * 100).toFixed(1)}%)`)
console.log(`  campaigns hitting >=90% at least once: ${[...per.values()].filter((p) => p.binding > 0).length} of ${per.size}`)
console.log(`  top 15 by binding days:`)
for (const [id, p] of [...per].sort((a, b) => b[1].binding - a[1].binding || b[1].spend - a[1].spend).slice(0, 15)) {
  const c = cby.get(id)!
  console.log(`    ${String(c.name).slice(0, 32).padEnd(32)} ${String(c.marketplace).padEnd(3)} nowBudget=€${Number(c.dailyBudget ?? 0).toFixed(2).padStart(6)} spend8d=€${p.spend.toFixed(2).padStart(7)} binding ${p.binding}/${p.days} maxRatio=${(p.maxR * 100).toFixed(0)}%`)
}

// ── 4 · The exhaustion hour: when does a binding campaign go quiet? ──────────
console.log(`\n=== 4 · Last hour with spend (Rome), binding vs non-binding campaign-days ===`)
const lastHr = await prisma.$queryRaw<Array<{ eid: string; d: Date; lasthr: number; sp: bigint }>>`
  SELECT "localEntityId" AS eid, "date" AS d,
         MAX(EXTRACT(HOUR FROM ts)::int) AS lasthr, SUM("costMicros") AS sp
  FROM (
    SELECT "localEntityId", "date", "costMicros",
           (("date" + (("hour")::text || ' hours')::interval) AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Rome') AS ts
    FROM "AmazonAdsHourlyPerformance"
    WHERE "localEntityId" IS NOT NULL AND "costMicros" > 0
      AND "date" >= DATE '2026-08-03' AND "date" < (NOW() AT TIME ZONE 'Europe/Rome')::date
  ) t GROUP BY 1, 2`
const bucket = new Map<number, { binding: number; other: number }>()
for (const r of lastHr) {
  const c = cby.get(r.eid); if (!c) continue
  const when = new Date(r.d); when.setUTCHours(23, 0, 0, 0)
  const b = budgetAt(r.eid, when); if (b == null || b <= 0) continue
  const ratio = (Number(r.sp ?? 0n) / 1e6) / (b / 100)
  const k = Number(r.lasthr)
  const e = bucket.get(k) ?? { binding: 0, other: 0 }
  if (ratio >= 0.9) e.binding++; else e.other++
  bucket.set(k, e)
}
console.log(`  lastHour  budget-binding days  other days`)
for (let h = 0; h < 24; h++) { const e = bucket.get(h); if (!e) continue; console.log(`    ${String(h).padStart(2, '0')}:00     ${String(e.binding).padStart(8)}          ${e.other}`) }

// ── 5 · Who wrote budgets, per day ───────────────────────────────────────────
console.log(`\n=== 5 · AD_BUDGET_UPDATE by day × writer (Rome) ===`)
const bw = await prisma.$queryRaw<Array<{ d: string; u: string | null; n: bigint }>>`
  SELECT to_char("createdAt" AT TIME ZONE 'Europe/Rome', 'YYYY-MM-DD') AS d, "userId" AS u, COUNT(*)::bigint AS n
  FROM "AdvertisingActionLog" WHERE "actionType" = 'AD_BUDGET_UPDATE'
  GROUP BY 1, 2 ORDER BY 1 DESC, 3 DESC`
for (const r of bw) console.log(`  ${r.d}  ${String(r.u ?? 'null').slice(0, 42).padEnd(42)} ${Number(r.n)}`)

await prisma.$disconnect()
