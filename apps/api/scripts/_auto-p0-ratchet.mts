/**
 * AUTO.P0 step 2 — is the budget ratchet still running, right now? READ-ONLY.
 *
 * The §2.3 stop-gap question cannot be asked honestly without knowing whether the two AUTO
 * budget rules are still moving money TODAY, or whether they have already consumed their own
 * target space and gone quiet. BUD §4 measured 58 of 86 live campaigns at the €1 floor; a rule
 * that can no longer move anything needs no emergency stop.
 *
 * ⚠ THE UNIT TRAP (BUD §2.5): AdvertisingActionLog.payloadBefore/payloadAfter store
 *   `dailyBudget` in EUROS ({"dailyBudget": 4.42}), NOT cents — unlike every neighbouring
 *   field in the ads schema. Re-verified here rather than carried from the brief: the euro
 *   reading is checked against Campaign.dailyBudget for the most recent write per campaign.
 *
 * ⚠ Fields are userId / payloadBefore / payloadAfter — never actor / beforeValue / afterValue.
 *   A wrong field name behind a `.catch(() => [])` reads exactly like a measurement of zero and
 *   already produced "0 budget audit rows in 60 days" once in this programme. NOTHING here is
 *   wrapped in a swallowing catch.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const eur = (v: unknown) => (typeof v === 'number' ? `€${v.toFixed(2)}` : String(v))

// ── 1 · AD_BUDGET_UPDATE by day and writer, last 10 days ─────────────────────────
const byDay = await prisma.$queryRawUnsafe<Array<{ day: Date; writer: string; c: bigint; down: bigint; up: bigint }>>(`
  SELECT date_trunc('day', l."createdAt") AS day,
         COALESCE(l."userId", '(null actor)') AS writer,
         COUNT(*) AS c,
         COUNT(*) FILTER (WHERE (l."payloadAfter"->>'dailyBudget')::numeric
                              < (l."payloadBefore"->>'dailyBudget')::numeric) AS down,
         COUNT(*) FILTER (WHERE (l."payloadAfter"->>'dailyBudget')::numeric
                              > (l."payloadBefore"->>'dailyBudget')::numeric) AS up
  FROM "AdvertisingActionLog" l
  WHERE l."actionType" = 'AD_BUDGET_UPDATE'
    AND l."createdAt" >= date_trunc('day', now() AT TIME ZONE 'UTC') - interval '10 days'
  GROUP BY 1, 2 ORDER BY 1 DESC, 3 DESC
`)
console.log('\n═══ 1 · AD_BUDGET_UPDATE by UTC day and writer — last 10 days ═══')
console.log(`${'day'.padEnd(12)} ${pad('writer', 44)} ${'rows'.padStart(6)} ${'down'.padStart(6)} ${'up'.padStart(5)}`)
let curDay = ''
for (const r of byDay) {
  const d = r.day.toISOString().slice(0, 10)
  console.log(`${(d === curDay ? '' : d).padEnd(12)} ${pad(r.writer, 44)} ${String(r.c).padStart(6)} ${String(r.down).padStart(6)} ${String(r.up).padStart(5)}`)
  curDay = d
}
if (!byDay.length) console.log('   (no rows — verify before believing this)')

// ── 2 · resolve the writer ids to rule names ─────────────────────────────────────
const writerIds = [...new Set(byDay.map(r => r.writer).filter(w => w.startsWith('automation:')).map(w => w.slice('automation:'.length)))]
const named = await prisma.automationRule.findMany({
  where: { id: { in: writerIds } },
  select: { id: true, name: true, enabled: true, autonomyLevel: true, maxExecutionsPerDay: true, actions: true },
})
console.log('\n═══ 2 · who those writers are ═══')
for (const w of writerIds) {
  const r = named.find(x => x.id === w)
  console.log(`   automation:${w}  →  ${r ? `${r.name} [${r.enabled ? r.autonomyLevel : 'OFF'}, cap ${r.maxExecutionsPerDay}]` : '(not a rule — an engine/cron actor)'}`)
}

// ── 3 · the unit check, re-verified ──────────────────────────────────────────────
const latestPerCampaign = await prisma.$queryRawUnsafe<Array<{ campaignId: string; after: number; live: number }>>(`
  SELECT DISTINCT ON (l."entityId")
         l."entityId" AS "campaignId",
         (l."payloadAfter"->>'dailyBudget')::numeric::float8 AS "after",
         c."dailyBudget"::float8 AS "live"
  FROM "AdvertisingActionLog" l
  JOIN "Campaign" c ON c.id = l."entityId"
  WHERE l."actionType" = 'AD_BUDGET_UPDATE' AND l."payloadAfter" ? 'dailyBudget'
  ORDER BY l."entityId", l."createdAt" DESC
`)
const asEuros = latestPerCampaign.filter(r => Math.abs(r.after - r.live) < 0.005).length
const asCents = latestPerCampaign.filter(r => Math.abs(r.after / 100 - r.live) < 0.005).length
console.log('\n═══ 3 · the unit trap, re-measured ═══')
console.log(`   campaigns with a logged budget write : ${latestPerCampaign.length}`)
console.log(`   last payloadAfter == Campaign.dailyBudget as EUROS : ${asEuros}`)
console.log(`   … as CENTS (÷100)                                  : ${asCents}`)
console.log(`   → payloadBefore/payloadAfter.dailyBudget is ${asEuros > asCents ? 'EUROS' : 'CENTS'}`)
const mismatched = latestPerCampaign.filter(r => Math.abs(r.after - r.live) >= 0.005)
console.log(`\n   ${mismatched.length} campaigns where the log's last value ≠ the live budget (the log is not complete):`)
for (const m of mismatched.slice(0, 12)) {
  const c = await prisma.campaign.findUnique({ where: { id: m.campaignId }, select: { name: true, status: true } })
  console.log(`      ${pad(c?.name ?? m.campaignId, 44)} log ${eur(m.after)} → live ${eur(m.live)}  [${c?.status}]`)
}

// ── 4 · where the live budgets sit now ───────────────────────────────────────────
const live = await prisma.campaign.findMany({
  where: { status: 'ENABLED' },
  select: { id: true, name: true, dailyBudget: true, minBidCents: true, maxBidCents: true },
})
const budgets = live.map(c => Number(c.dailyBudget)).sort((a, b) => a - b)
const atFloor = budgets.filter(b => b <= 1.0000001).length
console.log('\n═══ 4 · live budget distribution (ENABLED campaigns) ═══')
console.log(`   campaigns          : ${live.length}`)
console.log(`   at the €1 floor    : ${atFloor}  (a −15%/−20% trim changes nothing for these)`)
console.log(`   a trim can move    : ${live.length - atFloor}`)
console.log(`   min / median / max : ${eur(budgets[0])} / ${eur(budgets[Math.floor(budgets.length / 2)])} / ${eur(budgets[budgets.length - 1])}`)
console.log(`   total daily budget : €${budgets.reduce((a, b) => a + b, 0).toFixed(2)}`)

// ── 5 · in-flight writes ─────────────────────────────────────────────────────────
const pending = await prisma.$queryRawUnsafe<Array<{ syncStatus: string; c: bigint }>>(`
  SELECT q."syncStatus"::text AS "syncStatus", COUNT(*) AS c
  FROM "OutboundSyncQueue" q
  WHERE q."createdAt" >= now() - interval '3 days'
  GROUP BY 1 ORDER BY 2 DESC
`)
console.log('\n═══ 5 · OutboundSyncQueue, last 3 days ═══')
for (const p of pending) console.log(`   ${pad(p.syncStatus, 14)} ${p.c}`)

const pendingBudget = await prisma.$queryRawUnsafe<Array<{ c: bigint }>>(`
  SELECT COUNT(*) AS c FROM "AdvertisingActionLog" l
  WHERE l."actionType" = 'AD_BUDGET_UPDATE' AND l."amazonResponseStatus" = 'PENDING'
    AND l."createdAt" >= now() - interval '60 days'
`)
console.log(`   AD_BUDGET_UPDATE rows still status='PENDING' (60d): ${pendingBudget[0]?.c}`)

// ── 6 · the most recent budget moves, verbatim ───────────────────────────────────
const recent = await prisma.$queryRawUnsafe<Array<{ t: Date; campaign: string; before: number; after: number; writer: string; status: string }>>(`
  SELECT l."createdAt" AS t, COALESCE(c.name, l."entityId") AS campaign,
         (l."payloadBefore"->>'dailyBudget')::numeric::float8 AS before,
         (l."payloadAfter"->>'dailyBudget')::numeric::float8 AS after,
         COALESCE(l."userId", '(null)') AS writer, COALESCE(l."amazonResponseStatus", '(null)') AS status
  FROM "AdvertisingActionLog" l LEFT JOIN "Campaign" c ON c.id = l."entityId"
  WHERE l."actionType" = 'AD_BUDGET_UPDATE'
  ORDER BY l."createdAt" DESC LIMIT 25
`)
console.log('\n═══ 6 · the 25 most recent budget writes ═══')
for (const r of recent) {
  console.log(`   ${r.t.toISOString().slice(0, 16)}  ${pad(r.campaign, 38)} ${eur(r.before)} → ${eur(r.after)}  ${pad(r.writer.slice(0, 30), 31)} ${r.status}`)
}

await prisma.$disconnect()
