/**
 * BUD.1 — is the ratchet firing TODAY, or is it dormant?
 *
 * The page must not put "live" on a loop that stopped, nor "stopped" on one that is running. The
 * cursor's usefulness depends on the same answer: a spine that last moved 23 hours ago needs a
 * different sentence from one moving every 15 minutes.
 *
 * READ-ONLY.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))

const D14 = new Date(Date.now() - 14 * 86_400_000)
const rows = await prisma.advertisingActionLog.findMany({
  where: { actionType: 'AD_BUDGET_UPDATE', createdAt: { gte: D14 } },
  select: { createdAt: true, userId: true, payloadBefore: true, payloadAfter: true, amazonResponseStatus: true, entityId: true },
  orderBy: { createdAt: 'asc' },
})
const bud = (v: unknown) => { const o = v as Record<string, unknown> | null; const x = o?.dailyBudget; return typeof x === 'number' ? x : null }

console.log(`\n── AD_BUDGET_UPDATE per day, last 14 days (${rows.length} rows) ──`)
console.log(`  ${pad('day', 12)} ${pad('rows', 6)} ${pad('cuts', 6)} ${pad('raises', 7)} ${pad('skipped', 8)} writers`)
const byDay = new Map<string, { n: number; down: number; up: number; skip: number; who: Map<string, number> }>()
for (const r of rows) {
  const d = r.createdAt.toISOString().slice(0, 10)
  const e = byDay.get(d) ?? { n: 0, down: 0, up: 0, skip: 0, who: new Map<string, number>() }
  e.n++
  const b = bud(r.payloadBefore); const a = bud(r.payloadAfter)
  if (b != null && a != null) { if (a < b) e.down++; else if (a > b) e.up++ }
  if (r.amazonResponseStatus === 'PENDING') e.skip++
  const w = String(r.userId ?? 'null').replace('automation:', '')
  e.who.set(w, (e.who.get(w) ?? 0) + 1)
  byDay.set(d, e)
}
for (const [d, e] of [...byDay].sort()) {
  const who = [...e.who].sort((x, y) => y[1] - x[1]).map(([k, n]) => `${k.slice(0, 22)}=${n}`).join(' ')
  console.log(`  ${pad(d, 12)} ${pad(String(e.n), 6)} ${pad(String(e.down), 6)} ${pad(String(e.up), 7)} ${pad(String(e.skip), 8)} ${who}`)
}

// Executions per day for the budget rules — these move the RULES view even when nothing is written.
const all = await prisma.automationRule.findMany({ where: { domain: 'advertising' }, select: { id: true, name: true, actions: true } })
const ruleIds = all.filter((r) => (Array.isArray(r.actions) ? r.actions : []).some((a) => String((a as { type?: unknown })?.type ?? '') === 'adjust_ad_budget')).map((r) => r.id)
const ex = await prisma.automationRuleExecution.findMany({
  where: { ruleId: { in: ruleIds }, startedAt: { gte: D14 } },
  select: { startedAt: true, status: true },
})
console.log(`\n── budget-rule EXECUTIONS per day (these move the rules view with no budget write) ──`)
const exDay = new Map<string, Map<string, number>>()
for (const e of ex) {
  const d = e.startedAt.toISOString().slice(0, 10)
  if (!exDay.has(d)) exDay.set(d, new Map())
  exDay.get(d)!.set(e.status, (exDay.get(d)!.get(e.status) ?? 0) + 1)
}
for (const [d, m] of [...exDay].sort()) {
  console.log(`  ${pad(d, 12)} ${[...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(' · ')}`)
}

// The last 12 budget writes, whatever they were.
console.log(`\n── the last 12 budget writes ──`)
const last = rows.slice(-12).reverse()
for (const r of last) {
  const c = await prisma.campaign.findUnique({ where: { id: r.entityId }, select: { name: true, dailyBudget: true, liveBidWritesEnabled: true } })
  console.log(`  ${r.createdAt.toISOString().slice(0, 16)} ${pad(c?.name?.slice(0, 34) ?? r.entityId, 34)} €${bud(r.payloadBefore)?.toFixed(2)}→€${bud(r.payloadAfter)?.toFixed(2)} live=€${Number(c?.dailyBudget ?? 0).toFixed(2)} gate=${c?.liveBidWritesEnabled ? 'open' : 'CLOSED'} amz=${r.amazonResponseStatus} by ${String(r.userId).replace('automation:', '')}`)
}

await prisma.$disconnect()
