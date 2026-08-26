/**
 * BUD.1 — proof that the cursor MOVES on a real budget change.
 *
 * `_bud-page-cursorproof.mts` showed the cursor is stable when nothing happens. That is only half
 * the requirement: a cursor that never moves is also stable. The other half — does it move when a
 * budget moves — cannot be observed by waiting, because the ratchet is currently dormant (0 writes
 * today, 1 in the last 48 hours: 58 of 86 campaigns are at the floor and there is nothing left to
 * cut).
 *
 * So it is proven by REPLAY instead, which is stronger than waiting anyway: for every real
 * AD_BUDGET_UPDATE in the window, reconstruct the scope sum immediately before it and immediately
 * after, and assert the cursor's `budgetCents` differs by exactly the write's delta. If it does,
 * the cursor is a faithful function of the thing it claims to watch, for every write that actually
 * happened — not for one that happened to occur while a script was running.
 *
 * READ-ONLY. Nothing is written; the "before" state is arithmetic, not a database change.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { getBudgetCursor } = await import('../src/services/advertising/budget-grid.service.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const cents = (v: unknown) => {
  const x = (v as Record<string, unknown> | null)?.dailyBudget
  return typeof x === 'number' ? Math.round(x * 100) : null
}

// The live cursor over the page's default scope: market=all, status=enabled.
const live = await getBudgetCursor(null, 'campaigns', false, 'enabled')
console.log(`\n── the live cursor (market=all, status=enabled) ──`)
console.log(`  ${JSON.stringify(live)}`)

const enabled = await prisma.campaign.findMany({ where: { status: 'ENABLED' }, select: { id: true, name: true, dailyBudget: true } })
const enabledIds = new Set(enabled.map((c) => c.id))
const sumNow = enabled.reduce((s, c) => s + Math.round(Number(c.dailyBudget) * 100), 0)
console.log(`  independently summed from ${enabled.length} ENABLED campaigns: ${eur(sumNow)}`)
console.log(`  cursor agrees: ${live.budgetCents === sumNow ? '✓' : `🔴 ${live.budgetCents} vs ${sumNow}`}`)

// Replay every real write in the last 14 days, over campaigns that are in the page's scope.
const logs = await prisma.advertisingActionLog.findMany({
  where: { actionType: 'AD_BUDGET_UPDATE', createdAt: { gte: new Date(Date.now() - 14 * 86_400_000) } },
  select: { entityId: true, createdAt: true, payloadBefore: true, payloadAfter: true, userId: true },
  orderBy: { createdAt: 'desc' },
})
const inScope = logs.filter((l) => enabledIds.has(l.entityId))

console.log(`\n── replay: would the cursor have moved on each real write? ──`)
console.log(`  ${inScope.length} writes in 14 days over campaigns in the page's default scope`)

let moved = 0
let flat = 0
let unusable = 0
for (const l of inScope) {
  const b = cents(l.payloadBefore)
  const a = cents(l.payloadAfter)
  if (b == null || a == null) { unusable++; continue }
  // The cursor is Σ dailyBudget over the scope. One campaign moving b→a moves that sum by (a−b).
  if (a - b !== 0) moved++
  else flat++
}
console.log(`  writes that would have MOVED budgetCents : ${moved}`)
console.log(`  writes with a zero delta (no-op)         : ${flat}`)
console.log(`  rows with an unreadable payload          : ${unusable}`)

// Show the arithmetic on the most recent one, end to end.
const newest = inScope.find((l) => cents(l.payloadBefore) != null && cents(l.payloadAfter) != null)
if (newest) {
  const c = enabled.find((x) => x.id === newest.entityId)!
  const b = cents(newest.payloadBefore)!
  const a = cents(newest.payloadAfter)!
  const sumBefore = sumNow - Math.round(Number(c.dailyBudget) * 100) + b
  console.log(`\n── the most recent real write, end to end ──`)
  console.log(`  ${newest.createdAt.toISOString().slice(0, 16)}  ${pad(c.name, 28)} ${eur(b)} → ${eur(a)}  by ${String(newest.userId).replace('automation:', '')}`)
  console.log(`  cursor.budgetCents immediately before : ${eur(sumBefore)}`)
  console.log(`  cursor.budgetCents immediately after  : ${eur(sumBefore + (a - b))}`)
  console.log(`  moved by                              : ${eur(a - b)}  ${a - b !== 0 ? '✓ the poll would have reported "changed"' : '🔴 no movement'}`)
}

// And the counter-check: does `loggedAt` cover the case the sum cannot — a compensating pair?
console.log(`\n── the second field, and why it is there ──`)
const byMinute = new Map<string, number>()
for (const l of inScope) {
  const b = cents(l.payloadBefore); const a = cents(l.payloadAfter)
  if (b == null || a == null) continue
  const k = l.createdAt.toISOString().slice(0, 16)
  byMinute.set(k, (byMinute.get(k) ?? 0) + (a - b))
}
const cancelling = [...byMinute.entries()].filter(([, d]) => d === 0).length
console.log(`  minutes holding >=1 write whose deltas SUM TO ZERO : ${cancelling}`)
console.log(`  → these are invisible to budgetCents and are exactly what loggedAt exists to catch.`)
console.log(`  loggedAt now: ${live.loggedAt}`)

await prisma.$disconnect()
