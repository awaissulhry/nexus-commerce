/**
 * AUTO.P0 — shape probe. READ-ONLY. Nothing here writes.
 *
 * Answers three things I must not guess before sizing caps:
 *   1. what grain each rule's triggerData actually carries (campaign / adTarget / searchTerm / …)
 *   2. whether `startedAt` is a UTC-naive timestamp (so date_trunc is already a UTC day)
 *   3. the live rule inventory with its declared caps
 *
 * Every execution-row filter spells out the null branch. `NOT: { errorMessage: 'X' }` is
 * SQL NOT (errorMessage = 'X') → NULL, not TRUE, for the null errorMessage every SUCCESS and
 * DRY_RUN row carries; Postgres drops NULL from a WHERE. That is the subject of P0.1 and it is
 * waiting in every query written here.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const NOT_CAP = { OR: [{ errorMessage: null }, { errorMessage: { not: 'DAILY_CAP_EXCEEDED' } }] }

// ── 1 · column type, so the UTC claim is measured rather than assumed ─────────────
const colType = await prisma.$queryRawUnsafe<Array<{ column_name: string; data_type: string }>>(`
  SELECT column_name::text AS column_name, data_type::text AS data_type FROM information_schema.columns
  WHERE table_name = 'AutomationRuleExecution' AND column_name IN ('startedAt','triggerData','errorMessage')
`)
console.log('\n═══ 1 · column types ═══')
for (const c of colType) console.log(`   ${c.column_name.padEnd(14)} ${c.data_type}`)
console.log(`   now() UTC = ${new Date().toISOString()}`)

// ── 2 · rule inventory ────────────────────────────────────────────────────────────
const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: {
    id: true, name: true, trigger: true, enabled: true, dryRun: true, autonomyLevel: true,
    maxExecutionsPerDay: true, maxValueCentsEur: true, maxDailyAdSpendCentsEur: true,
    scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true, actions: true,
  },
  orderBy: { name: 'asc' },
})
console.log(`\n═══ 2 · advertising rules: ${rules.length} total, ${rules.filter(r => r.enabled).length} enabled ═══`)

// ── 3 · triggerData grain, sampled from real rows ────────────────────────────────
console.log('\n═══ 3 · triggerData grain, per rule, from the newest real row ═══')
console.log(`${'rule'.padEnd(42)} ${'trigger'.padEnd(32)} ${'on'.padEnd(4)} ${'cap'.padEnd(6)} grain keys`)
for (const r of rules) {
  const row = await prisma.automationRuleExecution.findFirst({
    where: { ruleId: r.id, ...NOT_CAP },
    orderBy: { startedAt: 'desc' },
    select: { triggerData: true, startedAt: true },
  })
  const td = (row?.triggerData ?? null) as Record<string, unknown> | null
  const keys = td && typeof td === 'object' ? Object.keys(td) : []
  // Name the id-bearing sub-objects — that is the grain.
  const grain = keys
    .filter(k => td && typeof td[k] === 'object' && td[k] !== null && 'id' in (td[k] as object))
    .join('+') || (keys.length ? keys.join(',') : '—')
  console.log(
    `${r.name.slice(0, 41).padEnd(42)} ${r.trigger.slice(0, 31).padEnd(32)} ${(r.enabled ? 'ON' : 'off').padEnd(4)}`
    + ` ${String(r.maxExecutionsPerDay ?? 'null').padEnd(6)} ${grain}`
    + (row ? ` (last ${row.startedAt.toISOString().slice(0, 16)})` : ' (no rows)'),
  )
}

// ── 4 · one full triggerData, to see the actual shape ────────────────────────────
const sample = await prisma.automationRuleExecution.findFirst({
  where: { ...NOT_CAP },
  orderBy: { startedAt: 'desc' },
  select: { triggerData: true, actionResults: true, status: true, dryRun: true },
})
console.log('\n═══ 4 · one full row ═══')
console.log(JSON.stringify(sample, null, 2).slice(0, 2400))

await prisma.$disconnect()
