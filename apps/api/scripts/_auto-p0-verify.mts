/**
 * AUTO.P0 — what is ACTUALLY fixed on prod, four days after this session's brief was written.
 * READ-ONLY.
 *
 * Three parallel sessions landed fixes for the three P0 defects while this session was measuring
 * (6ce492420 cap counter · d5fff1a6d gate refusal record · 10ab26208 budget baseline+bounds).
 * Commit messages are not evidence. This measures the live behaviour, per defect.
 *
 * ⚠ The window artefact another session already hit (6416ff821): an 8-day window spans the fix,
 *   so a rule that is capped TODAY still looks uncapped when averaged across pre-fix days. Every
 *   cap question below is asked about ONE COMPLETE UTC DAY, named in the output.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const NOT_CAP = { OR: [{ errorMessage: null }, { errorMessage: { not: 'DAILY_CAP_EXCEEDED' } }] }

// ── P0.1 · does the cap bind, on the most recent COMPLETE UTC day? ───────────────
// 🔴 The window trap, and I walked into it once here already. The cap fix (6ce492420) landed
// 2026-08-14 18:28 UTC, so 08-14 is MOSTLY A PRE-FIX DAY and reads as "nothing is capped".
// The first COMPLETE post-fix UTC day is 08-15. Pass a day as argv[2] to override.
const argDay = process.argv[2]
const dayStart = argDay ? new Date(`${argDay}T00:00:00.000Z`) : new Date(Date.now() - 86_400_000)
if (!argDay) dayStart.setUTCHours(0, 0, 0, 0)
const dayEnd = new Date(dayStart.getTime() + 86_400_000)
const FIX_LANDED = new Date('2026-08-14T18:28:54.000Z')
if (dayStart < FIX_LANDED) {
  console.log(`\n⚠ ${dayStart.toISOString().slice(0, 10)} is before or spans the cap fix (${FIX_LANDED.toISOString()}).`)
  console.log('  Numbers below are a window artefact, not a measurement of the current engine.')
}
const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising', enabled: true },
  select: { id: true, name: true, maxExecutionsPerDay: true },
})
console.log(`\n═══ P0.1 · the cap, on ${dayStart.toISOString().slice(0, 10)} (one complete UTC day) ═══`)
console.log(`${pad('rule', 42)} ${'cap'.padStart(5)} ${'counter sees'.padStart(12)} ${'refusals'.padStart(9)}  binding?`)
let bound = 0, unbound = 0
for (const r of rules) {
  const [sees, refused] = await Promise.all([
    prisma.automationRuleExecution.count({ where: { ruleId: r.id, startedAt: { gte: dayStart, lt: dayEnd }, ...NOT_CAP } }),
    prisma.automationRuleExecution.count({ where: { ruleId: r.id, startedAt: { gte: dayStart, lt: dayEnd }, errorMessage: 'DAILY_CAP_EXCEEDED' } }),
  ])
  if (sees === 0 && refused === 0) continue
  const cap = r.maxExecutionsPerDay
  const ok = cap == null ? 'no cap set' : sees <= cap ? '✅ held at cap' : `🔴 OVER by ${sees - cap}`
  if (cap != null) { if (sees <= cap) bound++; else unbound++ }
  console.log(`${pad(r.name, 42)} ${String(cap ?? '—').padStart(5)} ${String(sees).padStart(12)} ${String(refused).padStart(9)}  ${ok}`)
}
console.log(`\n   ${bound} rules held at or under their cap · ${unbound} over it`)

// ── P0.1b · are refusals being RECORDED as execution rows again? ─────────────────
const capRowsByDay = await prisma.$queryRawUnsafe<Array<{ day: Date; c: bigint }>>(`
  SELECT date_trunc('day', "startedAt") AS day, COUNT(*) AS c
  FROM "AutomationRuleExecution" WHERE "errorMessage" = 'DAILY_CAP_EXCEEDED'
    AND "startedAt" >= now() - interval '12 days' GROUP BY 1 ORDER BY 1 DESC
`)
console.log('\n═══ P0.1b · DAILY_CAP_EXCEEDED execution rows, last 12 days ═══')
if (!capRowsByDay.length) console.log('   none — refusals write NO execution row (by design, ADX.1)')
for (const d of capRowsByDay) console.log(`   ${d.day.toISOString().slice(0, 10)}  ${d.c}`)

// ── P0.3 · the gate refusal record — is it filling? ──────────────────────────────
const refusalTable = await prisma.$queryRawUnsafe<Array<{ deniedAt: string; c: bigint; first: Date; last: Date }>>(`
  SELECT "deniedAt", COUNT(*) AS c, MIN("createdAt") AS first, MAX("createdAt") AS last
  FROM "AdWriteRefusal" GROUP BY 1 ORDER BY 2 DESC
`)
console.log('\n═══ P0.3 · AdWriteRefusal (the gate family) ═══')
if (!refusalTable.length) console.log('   TABLE IS EMPTY — the record exists but nothing has written to it yet')
for (const r of refusalTable) {
  console.log(`   ${pad(r.deniedAt, 22)} ${String(r.c).padStart(6)}  ${r.first.toISOString().slice(0, 16)} → ${r.last.toISOString().slice(0, 16)}`)
}

// ── P0.3b · the two families that still have NO durable record ───────────────────
const capRefusalsToday = await prisma.automationRuleExecution.count({
  where: { errorMessage: 'DAILY_CAP_EXCEEDED', startedAt: { gte: dayStart, lt: dayEnd } },
})
const valueCapFails = await prisma.$queryRawUnsafe<Array<{ name: string; c: bigint }>>(`
  SELECT r.name, COUNT(*) AS c FROM "AutomationRuleExecution" e JOIN "AutomationRule" r ON r.id = e."ruleId"
  WHERE e."status" = 'FAILED' AND (e."errorMessage" IS NULL OR e."errorMessage" <> 'DAILY_CAP_EXCEEDED')
    AND e."startedAt" >= $1 AND e."startedAt" < $2
  GROUP BY 1 ORDER BY 2 DESC
`, dayStart, dayEnd)
console.log('\n═══ P0.3b · refusal families with no durable home ═══')
console.log(`   cap refusals on ${dayStart.toISOString().slice(0, 10)}, durably recorded : ${capRefusalsToday}`)
console.log(`   …the engine still publishes them only to a 50-event, 5-minute ring buffer`)
console.log(`   executions still recorded as FAILED that are refusals (value_cap):`)
for (const v of valueCapFails) console.log(`      ${String(v.c).padStart(5)}  ${v.name}`)

// ── P0.2 · are the budget guards armed, or inert? ────────────────────────────────
const guards = await prisma.$queryRawUnsafe<Array<{ total: bigint; baseline: bigint; minb: bigint; maxb: bigint; enabled_at_floor: bigint }>>(`
  SELECT COUNT(*) AS total,
         COUNT(*) FILTER (WHERE "budgetBaselineCents" IS NOT NULL) AS baseline,
         COUNT(*) FILTER (WHERE "minBudgetCents" IS NOT NULL) AS minb,
         COUNT(*) FILTER (WHERE "maxBudgetCents" IS NOT NULL) AS maxb,
         COUNT(*) FILTER (WHERE status = 'ENABLED' AND "dailyBudget" <= 1.0001) AS enabled_at_floor
  FROM "Campaign"
`)
const g = guards[0]
console.log('\n═══ P0.2 · the budget guards BUD.2 shipped — armed or inert? ═══')
console.log(`   campaigns                                  : ${g?.total}`)
console.log(`   with budgetBaselineCents captured (anchor)  : ${g?.baseline}`)
console.log(`   with minBudgetCents set (floor above €1)    : ${g?.minb}`)
console.log(`   with maxBudgetCents set (ceiling)           : ${g?.maxb}`)
console.log(`   ENABLED and still AT the €1 floor           : ${g?.enabled_at_floor}`)

const recentBudget = await prisma.$queryRawUnsafe<Array<{ day: Date; c: bigint; down: bigint }>>(`
  SELECT date_trunc('day', "createdAt") AS day, COUNT(*) AS c,
         COUNT(*) FILTER (WHERE ("payloadAfter"->>'dailyBudget')::numeric < ("payloadBefore"->>'dailyBudget')::numeric) AS down
  FROM "AdvertisingActionLog" WHERE "actionType" = 'AD_BUDGET_UPDATE'
    AND "createdAt" >= now() - interval '8 days' GROUP BY 1 ORDER BY 1 DESC
`)
console.log('\n   AD_BUDGET_UPDATE writes, last 8 days:')
if (!recentBudget.length) console.log('      none')
for (const b of recentBudget) console.log(`      ${b.day.toISOString().slice(0, 10)}  ${String(b.c).padStart(4)} writes, ${b.down} down`)

await prisma.$disconnect()
