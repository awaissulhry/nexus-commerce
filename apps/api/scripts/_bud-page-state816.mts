/**
 * BUD — state of the page's guardrails on 2026-08-16. Is the machinery ARMED, or only built?
 * BUD.2 shipped budgetBaselineCents / minBudgetCents / maxBudgetCents as NULL-by-default
 * ("NULL = today's behaviour exactly"), so existence proves nothing. READ-ONLY.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const now = Date.now()

// ── 1. are the guardrails armed on any campaign? ──────────────────────────────
const camps = await prisma.campaign.findMany({
  where: { status: 'ENABLED' },
  select: {
    id: true, name: true, marketplace: true, dailyBudget: true, liveBidWritesEnabled: true,
    budgetBaselineCents: true, minBudgetCents: true, maxBudgetCents: true,
  },
})
const b = (c: (typeof camps)[number]) => Number(c.dailyBudget ?? 0)
const withBaseline = camps.filter((c) => c.budgetBaselineCents != null)
const withMin = camps.filter((c) => c.minBudgetCents != null)
const withMax = camps.filter((c) => c.maxBudgetCents != null)
console.log(`\n══ GUARDRAILS — built vs armed ══`)
console.log(`  ENABLED campaigns             : ${camps.length}`)
console.log(`  with a budgetBaselineCents    : ${withBaseline.length}   ${withBaseline.length ? '' : '🔴 the anchor exists on ZERO campaigns — every relative op still compounds off current'}`)
console.log(`  with a minBudgetCents (floor) : ${withMin.length}   ${withMin.length ? '' : '🔴 nothing above €1 exists to refuse a cut'}`)
console.log(`  with a maxBudgetCents         : ${withMax.length}`)
console.log(`  at or below €1                : ${camps.filter((c) => b(c) <= 1).length}`)
console.log(`  above €1 with gate open       : ${camps.filter((c) => c.liveBidWritesEnabled && b(c) > 1).length}`)
console.log(`  total daily budget            : €${camps.reduce((a, c) => a + b(c), 0).toFixed(2)}`)
for (const c of withBaseline.slice(0, 12)) {
  console.log(`     ${pad(c.name, 40)} now €${b(c).toFixed(2).padStart(7)}  baseline €${((c.budgetBaselineCents ?? 0) / 100).toFixed(2).padStart(7)}  min ${c.minBudgetCents ?? '—'}  max ${c.maxBudgetCents ?? '—'}`)
}

// ── 2. the two AUTO rules: still acting? ──────────────────────────────────────
const { resolveAutonomy, levelActs } = await import('../src/services/advertising/ads-autonomy.js')
const all = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: {
    id: true, name: true, enabled: true, autonomyLevel: true, dryRun: true, trigger: true, actions: true,
    maxExecutionsPerDay: true, lastExecutedAt: true, lastMatchedAt: true, updatedAt: true,
  },
})
const types = (a: unknown) => (Array.isArray(a) ? a : []).map((x) => String((x as { type?: unknown })?.type ?? ''))
const rules = all.filter((r) => types(r.actions).some((t) => t === 'adjust_ad_budget'))
console.log(`\n══ THE BUDGET RULES ══`)
for (const r of rules) {
  const lvl = resolveAutonomy(r as never)
  const acts = (Array.isArray(r.actions) ? r.actions : []) as Array<Record<string, unknown>>
  const pct = acts.find((a) => a.type === 'adjust_ad_budget')?.percent
  console.log(`  ${levelActs(lvl) ? '🔴 ACTS' : '   prop'} ${pad(r.name, 40)} lvl=${pad(lvl, 8)} pct=${String(pct ?? '?').padStart(4)} cap=${String(r.maxExecutionsPerDay ?? '—').padStart(5)} lastExec=${r.lastExecutedAt?.toISOString().slice(0, 16) ?? 'never'}`)
}

// ── 3. budget writes since BUD.2 landed (2026-08-15 03:16 UTC) ────────────────
const bud2 = new Date('2026-08-15T03:16:00Z')
const num = (v: unknown) => { const o = v as Record<string, unknown> | null; const x = o?.dailyBudget ?? o?.budget; return typeof x === 'number' ? x : null }
for (const [label, since] of [['since BUD.2 landed', bud2], ['last 24h', new Date(now - 86_400_000)], ['last 72h', new Date(now - 3 * 86_400_000)]] as const) {
  const rows = await prisma.advertisingActionLog.findMany({
    where: { createdAt: { gte: since }, actionType: 'AD_BUDGET_UPDATE' },
    select: { entityId: true, userId: true, payloadBefore: true, payloadAfter: true, createdAt: true },
  })
  const m = rows.map((r) => ({ b: num(r.payloadBefore), a: num(r.payloadAfter), u: r.userId })).filter((x) => x.b != null && x.a != null) as Array<{ b: number; a: number; u: string | null }>
  const byUser = new Map<string, number>()
  for (const r of rows) byUser.set(String(r.userId ?? '—'), (byUser.get(String(r.userId ?? '—')) ?? 0) + 1)
  console.log(`\n══ AD_BUDGET_UPDATE — ${label} (${since.toISOString().slice(0, 16)}) ══`)
  console.log(`  rows ${rows.length}  ↓${m.filter((x) => x.a < x.b).length} ↑${m.filter((x) => x.a > x.b).length} =${m.filter((x) => x.a === x.b).length}  campaigns=${new Set(rows.map((r) => r.entityId)).size}`)
  for (const [u, n] of [...byUser].sort((x, y) => y[1] - x[1]).slice(0, 6)) console.log(`     ${pad(u, 46)} ${n}`)
}

// ── 4. any campaign still ratcheting? consecutive same-direction cuts per campaign ──
const recent = await prisma.advertisingActionLog.findMany({
  where: { createdAt: { gte: new Date(now - 3 * 86_400_000) }, actionType: 'AD_BUDGET_UPDATE' },
  select: { entityId: true, payloadBefore: true, payloadAfter: true, createdAt: true, userId: true },
  orderBy: { createdAt: 'asc' },
})
const perCamp = new Map<string, Array<{ b: number; a: number; at: Date; u: string | null }>>()
for (const r of recent) {
  const bb = num(r.payloadBefore), aa = num(r.payloadAfter)
  if (bb == null || aa == null) continue
  if (!perCamp.has(r.entityId)) perCamp.set(r.entityId, [])
  perCamp.get(r.entityId)!.push({ b: bb, a: aa, at: r.createdAt, u: r.userId })
}
console.log(`\n══ RATCHET CHECK — 72h, campaigns with ≥3 cuts ══`)
let ratcheting = 0
for (const [id, moves] of perCamp) {
  const cuts = moves.filter((m) => m.a < m.b)
  if (cuts.length < 3) continue
  ratcheting++
  const name = camps.find((c) => c.id === id)?.name ?? id.slice(0, 14)
  console.log(`  🔴 ${pad(name, 38)} ${cuts.length} cuts  €${cuts[0].b.toFixed(2)} → €${cuts[cuts.length - 1].a.toFixed(2)}  (${cuts[0].at.toISOString().slice(5, 16)} → ${cuts[cuts.length - 1].at.toISOString().slice(5, 16)})`)
}
if (!ratcheting) console.log(`  none — no campaign took 3+ cuts in 72h`)

// ── 5. is the cap counter armed and biting? ──────────────────────────────────
const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0)
const capToday = await prisma.automationRuleExecution.count({ where: { errorMessage: 'DAILY_CAP_EXCEEDED', startedAt: { gte: dayStart } } })
const cap7 = await prisma.automationRuleExecution.count({ where: { errorMessage: 'DAILY_CAP_EXCEEDED', startedAt: { gte: new Date(now - 7 * 86_400_000) } } })
const lastCap = await prisma.automationRuleExecution.findFirst({ where: { errorMessage: 'DAILY_CAP_EXCEEDED' }, orderBy: { startedAt: 'desc' }, select: { startedAt: true, ruleId: true } })
console.log(`\n══ THE CAP ══`)
console.log(`  DAILY_CAP_EXCEEDED today=${capToday}  last7d=${cap7}  newest=${lastCap?.startedAt.toISOString().slice(0, 16) ?? 'never'}`)
console.log(`  → ${cap7 > 0 ? 'the counter IS biting' : '🔴 no refusal in 7 days'}`)

await prisma.$disconnect()
