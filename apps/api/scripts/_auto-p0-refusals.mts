/**
 * AUTO.P0 step 3 — sizing the durable refusal record. READ-ONLY.
 *
 * A refusal has no durable home (P0.3). Before proposing a shape I need the row volume it would
 * carry, because the pre-2026-08-04 answer was 693,704 rows in eight weeks and volume is the
 * deciding factor between "a row per refusal" and "a counter per (actor, day, reason)".
 *
 * Two refusal families, measured separately:
 *   1. the rule daily cap   — projected from today's executions vs the cap that WILL bind
 *   2. the write gate       — checkAdsWriteGate denials, which the worker records by tagging
 *                             OutboundSyncQueue.errorMessage with [ADS-WRITE-GATE-DENY]
 *
 * ⚠ Null branch spelled out everywhere. ⚠ No `.catch(() => [])` anywhere: a swallowed error
 *   reads exactly like a measurement of zero and has already done so twice in this programme.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))

// ── 1 · gate denials, as the worker records them ─────────────────────────────────
const skipped = await prisma.$queryRawUnsafe<Array<{ day: Date; c: bigint; sample: string }>>(`
  SELECT date_trunc('day', q."updatedAt") AS day, COUNT(*) AS c,
         (array_agg(q."errorMessage" ORDER BY q."updatedAt" DESC))[1] AS sample
  FROM "OutboundSyncQueue" q
  WHERE q."syncStatus" = 'SKIPPED' AND q."updatedAt" >= now() - interval '14 days'
  GROUP BY 1 ORDER BY 1 DESC
`)
console.log('\n═══ 1 · OutboundSyncQueue SKIPPED per day (the gate\'s only durable trace) ═══')
for (const s of skipped) console.log(`   ${s.day.toISOString().slice(0, 10)}  ${String(s.c).padStart(5)}  e.g. ${String(s.sample ?? '').slice(0, 90)}`)
if (!skipped.length) console.log('   (none in 14 days — verified, not assumed)')

const gateTagged = await prisma.$queryRawUnsafe<Array<{ msg: string; c: bigint }>>(`
  SELECT COALESCE(q."errorMessage", '(null errorMessage)') AS msg, COUNT(*) AS c
  FROM "OutboundSyncQueue" q
  WHERE q."syncStatus" = 'SKIPPED' AND q."updatedAt" >= now() - interval '60 days'
  GROUP BY 1 ORDER BY 2 DESC LIMIT 25
`)
console.log('\n═══ 2 · what those SKIPPED rows say, 60 days ═══')
for (const g of gateTagged) console.log(`   ${String(g.c).padStart(6)}  ${g.msg.slice(0, 118)}`)

// ── 3 · projected cap-refusal volume, per rule, at the CURRENT caps ──────────────
// A refusal happens on every match past the cap. So refusals/day = execs/day − cap.
const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising', enabled: true },
  select: { id: true, name: true, maxExecutionsPerDay: true, trigger: true },
})
const dayStart = new Date(Date.now() - 86_400_000); dayStart.setUTCHours(0, 0, 0, 0)
const dayEnd = new Date(dayStart.getTime() + 86_400_000)

console.log(`\n═══ 3 · refusal rows the repaired cap would generate, for ${dayStart.toISOString().slice(0, 10)} ═══`)
console.log(`${pad('rule', 42)} ${'cap'.padStart(5)} ${'ran'.padStart(6)} ${'refusals/day'.padStart(12)}`)
let totalRefusals = 0
for (const r of rules) {
  if (r.maxExecutionsPerDay == null) continue
  const ran = await prisma.automationRuleExecution.count({
    where: {
      ruleId: r.id, startedAt: { gte: dayStart, lt: dayEnd },
      OR: [{ errorMessage: null }, { errorMessage: { not: 'DAILY_CAP_EXCEEDED' } }],
    },
  })
  const refusals = Math.max(0, ran - r.maxExecutionsPerDay)
  totalRefusals += refusals
  if (ran === 0) continue
  console.log(`${pad(r.name, 42)} ${String(r.maxExecutionsPerDay).padStart(5)} ${String(ran).padStart(6)} ${String(refusals).padStart(12)}`)
}
console.log(`\n   TOTAL refusal rows per day at today's caps : ${totalRefusals}`)
console.log(`   → per 60-day window                        : ${(totalRefusals * 60).toLocaleString()}`)
console.log(`   → per year                                 : ${(totalRefusals * 365).toLocaleString()}`)
console.log(`   (the pre-2026-08-04 regime produced 693,704 rows in 8 weeks — same order)`)

// ── 4 · distinct (rule, day, reason) tuples — the counter-shaped alternative ─────
console.log(`\n   A per-(actor, day, reason) COUNTER instead would be:`)
console.log(`      ${rules.length} enabled rules × 1 reason (DAILY_CAP_EXCEEDED) × 365 days = ${(rules.length * 365).toLocaleString()} rows/year`)
console.log(`      + the write gate's 8 deniedAt values × actors × days`)

// ── 5 · what the page reads today ────────────────────────────────────────────────
for (const days of [7, 14, 30, 60]) {
  const since = new Date(Date.now() - days * 86_400_000)
  const c = await prisma.automationRuleExecution.count({
    where: { errorMessage: 'DAILY_CAP_EXCEEDED', startedAt: { gte: since } },
  })
  console.log(`   capped chip @ ${String(days).padStart(2)}d : ${c.toLocaleString()}`)
}

// ── 6 · the allowlist footgun, measured ──────────────────────────────────────────
const allowlist = await prisma.$queryRawUnsafe<Array<{ total: bigint; allowed: bigint; enabled_not_allowed: bigint }>>(`
  SELECT COUNT(*) AS total,
         COUNT(*) FILTER (WHERE c."liveBidWritesEnabled" = true) AS allowed,
         COUNT(*) FILTER (WHERE c."status" = 'ENABLED' AND c."liveBidWritesEnabled" = false) AS enabled_not_allowed
  FROM "Campaign" c
`)
console.log('\n═══ 6 · the campaign_allowlist footgun ═══')
console.log(`   campaigns total                       : ${allowlist[0]?.total}`)
console.log(`   live-writes allowlisted               : ${allowlist[0]?.allowed}`)
console.log(`   ENABLED but NOT allowlisted (denied)  : ${allowlist[0]?.enabled_not_allowed}`)

await prisma.$disconnect()
