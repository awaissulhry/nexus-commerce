/**
 * BUD page — §1 LIVE CHECK. Is the budget ratchet still running, right now?
 * READ-ONLY: no writes, no mutations.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { resolveAutonomy, levelActs } = await import('../src/services/advertising/ads-autonomy.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const now = Date.now()

console.log(`\n═══ BUD live check — ${new Date(now).toISOString()} ═══\n`)

// ── 1. the budget rules, and whether they still ACT ──────────────────────────
const all = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: {
    id: true, name: true, enabled: true, autonomyLevel: true, dryRun: true, trigger: true,
    actions: true, maxExecutionsPerDay: true, executionCount: true,
    lastEvaluatedAt: true, lastMatchedAt: true, lastExecutedAt: true, updatedAt: true,
  },
})
const types = (a: unknown) => (Array.isArray(a) ? a : []).map((x) => String((x as { type?: unknown })?.type ?? ''))
const rules = all.filter((r) => types(r.actions).some((t) => t === 'adjust_ad_budget'))
console.log(`Budget rules: ${rules.length}`)
for (const r of rules) {
  const lvl = resolveAutonomy(r as never)
  const acts = (Array.isArray(r.actions) ? r.actions : []) as Array<Record<string, unknown>>
  const pct = acts.find((a) => a.type === 'adjust_ad_budget')?.percent
  console.log(
    `  ${levelActs(lvl) ? '🔴 ACTS' : '   prop'} ${pad(r.name, 42)} lvl=${pad(lvl, 8)} enabled=${r.enabled ? 'Y' : 'n'} ` +
    `pct=${pct ?? '?'} trig=${pad(String(r.trigger), 30)} lastExec=${r.lastExecutedAt?.toISOString().slice(0, 16) ?? 'never'} ` +
    `updated=${r.updatedAt?.toISOString().slice(0, 16) ?? '—'}`,
  )
}
const acting = rules.filter((r) => levelActs(resolveAutonomy(r as never)))
console.log(`\n  → rules that WRITE: ${acting.length}`)

// ── 2. budget writes in the last 24h / 6h / 1h ────────────────────────────────
const win = [1, 6, 24, 72] as const
for (const h of win) {
  const rows = await prisma.advertisingActionLog.findMany({
    where: { createdAt: { gte: new Date(now - h * 3_600_000) }, actionType: 'AD_BUDGET_UPDATE' },
    select: { entityId: true, payloadBefore: true, payloadAfter: true, createdAt: true, amazonResponseStatus: true, userId: true },
  })
  const num = (v: unknown) => { const o = v as Record<string, unknown> | null; const x = o?.dailyBudget ?? o?.budget; return typeof x === 'number' ? x : null }
  const m = rows.map((r) => ({ b: num(r.payloadBefore), a: num(r.payloadAfter) })).filter((x) => x.b != null && x.a != null) as Array<{ b: number; a: number }>
  console.log(`  last ${String(h).padStart(2)}h: ${String(rows.length).padStart(4)} AD_BUDGET_UPDATE  ` +
    `↓${m.filter((x) => x.a < x.b).length} ↑${m.filter((x) => x.a > x.b).length} =${m.filter((x) => x.a === x.b).length}  ` +
    `campaigns=${new Set(rows.map((r) => r.entityId)).size}  pending=${rows.filter((r) => r.amazonResponseStatus === 'PENDING').length}`)
}

// ── 3. the most recent 25 writes, in order, with the actor ────────────────────
const recent = await prisma.advertisingActionLog.findMany({
  where: { actionType: 'AD_BUDGET_UPDATE' },
  select: { entityId: true, userId: true, payloadBefore: true, payloadAfter: true, createdAt: true, amazonResponseStatus: true, executionId: true },
  orderBy: { createdAt: 'desc' },
  take: 25,
})
const num = (v: unknown) => { const o = v as Record<string, unknown> | null; const x = o?.dailyBudget ?? o?.budget; return typeof x === 'number' ? x : null }
console.log(`\n── most recent 25 AD_BUDGET_UPDATE rows ──`)
for (const r of recent) {
  console.log(`  ${r.createdAt.toISOString().slice(0, 16)}  €${String(num(r.payloadBefore) ?? '?').padStart(6)} → €${String(num(r.payloadAfter) ?? '?').padStart(6)}  ` +
    `${pad(String(r.amazonResponseStatus ?? '—'), 9)} ${pad(String(r.userId ?? '—'), 40)} camp=${String(r.entityId).slice(0, 12)}`)
}

// ── 4. rule executions in the last 24h ────────────────────────────────────────
const execs = await prisma.automationRuleExecution.groupBy({
  by: ['ruleId', 'status'],
  where: { ruleId: { in: rules.map((r) => r.id) }, startedAt: { gte: new Date(now - 86_400_000) } },
  _count: { _all: true },
})
console.log(`\n── executions, last 24h ──`)
for (const r of rules) {
  const mine = execs.filter((e) => e.ruleId === r.id)
  if (!mine.length) continue
  console.log(`  ${pad(r.name, 42)} ${mine.map((m) => `${m.status}=${m._count._all}`).join(' · ')}`)
}

// ── 5. the floor, now ─────────────────────────────────────────────────────────
const camps = await prisma.campaign.findMany({
  where: { status: 'ENABLED' },
  select: { id: true, name: true, dailyBudget: true, marketplace: true, liveBidWritesEnabled: true, updatedAt: true },
})
const b = (c: (typeof camps)[number]) => Number(c.dailyBudget ?? 0)
console.log(`\n── the floor, now ──`)
console.log(`  ENABLED campaigns          : ${camps.length}`)
console.log(`  at or below €1             : ${camps.filter((c) => b(c) <= 1).length}`)
console.log(`  write gate OPEN            : ${camps.filter((c) => c.liveBidWritesEnabled).length}`)
console.log(`  gate OPEN and above €1     : ${camps.filter((c) => c.liveBidWritesEnabled && b(c) > 1).length}  ← what a trim can still eat`)
const movable = camps.filter((c) => c.liveBidWritesEnabled && b(c) > 1).sort((x, y) => b(y) - b(x))
for (const c of movable.slice(0, 15)) console.log(`     ${pad(c.name, 44)} [${c.marketplace}] €${b(c).toFixed(2)}`)
console.log(`  total daily budget, all ENABLED: €${camps.reduce((a, c) => a + b(c), 0).toFixed(2)}`)

await prisma.$disconnect()
