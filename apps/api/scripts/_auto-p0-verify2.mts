/**
 * AUTO.P0 — the before/after for the two units this session shipped. READ-ONLY.
 *
 * Unit 1 · guard ④ — the daily budget MOVEMENT bound at the write gate
 * Unit 2 · P0.3    — AutomationRefusalDaily, the durable cap-refusal counter
 *
 * ⚠ Every zero here is reported with the reason it could be a real zero. Two of them ARE expected
 *   to be zero on the first run and would be alarming later, so each says which it is. This
 *   programme has produced a confident, wrong zero four times.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const today = new Date().toISOString().slice(0, 10)

// ── unit 2 · is the refusal counter filling? ─────────────────────────────────────
const rows = await prisma.automationRefusalDaily.findMany({ orderBy: [{ dayUtc: 'desc' }, { count: 'desc' }] })
console.log(`\n═══ AutomationRefusalDaily — ${rows.length} rows, today is ${today} ═══`)
if (!rows.length) {
  console.log('   EMPTY. Expected only if the API has not yet redeployed or no rule has hit a cap since.')
  console.log('   The table was created 2026-08-16; a rule must reach its cap for a row to appear.')
} else {
  const names = new Map((await prisma.automationRule.findMany({
    where: { id: { in: [...new Set(rows.map(r => r.actorId))] } },
    select: { id: true, name: true, maxExecutionsPerDay: true },
  })).map(r => [r.id, r]))
  console.log(`${pad('rule', 42)} ${'day'.padEnd(11)} ${pad('reason', 20)} ${'cap'.padStart(5)} ${'refused'.padStart(8)}`)
  for (const r of rows) {
    const n = names.get(r.actorId)
    console.log(`${pad(n?.name ?? r.actorId, 42)} ${r.dayUtc.padEnd(11)} ${pad(r.reason, 20)} ${String(n?.maxExecutionsPerDay ?? '—').padStart(5)} ${String(r.count).padStart(8)}`)
  }
  const newest = rows.reduce((a, r) => (r.lastAt > a ? r.lastAt : a), rows[0].lastAt)
  console.log(`\n   newest refusal : ${newest.toISOString()}`)
  console.log(`   one verbatim   : "${rows[0].lastReason}"`)
  console.log(`\n   ⚠ These are REFUSALS. None of them is a failure and none may be counted as one.`)
}

// ── the ceiling line SUB §5.2 needs, now sourceable ──────────────────────────────
const dayStart = new Date(`${today}T00:00:00.000Z`)
const enabled = await prisma.automationRule.findMany({
  where: { domain: 'advertising', enabled: true, maxExecutionsPerDay: { not: null } },
  select: { id: true, name: true, maxExecutionsPerDay: true },
})
console.log(`\n═══ The ceiling line, per SUB §5.2 — "limit · position · what happens at the limit" ═══`)
for (const r of enabled) {
  const [used, refused] = await Promise.all([
    prisma.automationRuleExecution.count({
      where: {
        ruleId: r.id, startedAt: { gte: dayStart },
        OR: [{ errorMessage: null }, { errorMessage: { not: 'DAILY_CAP_EXCEEDED' } }],
      },
    }),
    prisma.automationRefusalDaily.findFirst({
      where: { actorId: r.id, dayUtc: today, reason: 'DAILY_CAP_EXCEEDED' }, select: { count: true },
    }),
  ])
  if (used === 0 && !refused) continue
  console.log(`   ${pad(r.name, 42)} Daily cap ${r.maxExecutionsPerDay} — ${used} used, ${refused?.count ?? 0} refused today.`)
}

// ── unit 1 · guard ④ — has it refused anything, and is the ratchet still still? ──
const moveRefusals = await prisma.adWriteRefusal.groupBy({
  by: ['deniedAt'], where: { createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } }, _count: { _all: true },
})
console.log('\n═══ Guard ④ at the gate — AdWriteRefusal by kind, 7 days ═══')
for (const g of moveRefusals) console.log(`   ${pad(g.deniedAt, 22)} ${g._count._all}`)
const dayMove = moveRefusals.find(g => g.deniedAt === 'budget_day_move')
if (!dayMove) {
  console.log('   budget_day_move        0 — expected: no budget rule has written since 2026-08-11,')
  console.log('                              so nothing has yet asked the gate for a budget move.')
}

const budgets = await prisma.campaign.findMany({ where: { status: 'ENABLED' }, select: { dailyBudget: true } })
const b = budgets.map(x => Number(x.dailyBudget)).sort((x, y) => x - y)
console.log('\n═══ The account the guards now protect ═══')
console.log(`   ENABLED campaigns  : ${b.length}`)
console.log(`   at the €1 floor    : ${b.filter(x => x <= 1.0001).length}`)
console.log(`   total daily budget : €${b.reduce((s, x) => s + x, 0).toFixed(2)}`)
const lastBudget = await prisma.advertisingActionLog.findFirst({
  where: { actionType: 'AD_BUDGET_UPDATE' }, orderBy: { createdAt: 'desc' },
  select: { createdAt: true, userId: true },
})
console.log(`   last budget write  : ${lastBudget?.createdAt.toISOString() ?? 'never'} by ${lastBudget?.userId ?? '—'}`)

await prisma.$disconnect()
