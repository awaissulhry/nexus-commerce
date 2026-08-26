/**
 * BUD — can the 58 at-floor campaigns be recovered? BUD.3 shipped restore-to-baseline, and BUD.2
 * deliberately refuses to capture a baseline for an at-floor campaign (a €1 anchor would enshrine
 * the damage). So the recovery act cannot reach the campaigns it was built for — unless the
 * pre-ratchet value can be read out of the audit log. Measure whether it can. READ-ONLY.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const num = (v: unknown) => { const o = v as Record<string, unknown> | null; const x = o?.dailyBudget ?? o?.budget; return typeof x === 'number' ? x : null }

const camps = await prisma.campaign.findMany({
  where: { status: 'ENABLED' },
  select: { id: true, name: true, marketplace: true, dailyBudget: true, liveBidWritesEnabled: true, budgetBaselineCents: true },
})
const atFloor = camps.filter((c) => Number(c.dailyBudget ?? 0) <= 1)
console.log(`\n══ the ${atFloor.length} at-floor campaigns — is a pre-ratchet value recoverable? ══`)
console.log(`  of these, with a baseline already: ${atFloor.filter((c) => c.budgetBaselineCents != null).length}`)

const logs = await prisma.advertisingActionLog.findMany({
  where: { actionType: 'AD_BUDGET_UPDATE', entityId: { in: atFloor.map((c) => c.id) } },
  select: { entityId: true, payloadBefore: true, payloadAfter: true, createdAt: true, userId: true },
  orderBy: { createdAt: 'asc' },
})
console.log(`  audit rows covering them: ${logs.length}`)

let recoverable = 0, noHistory = 0
let totalNow = 0, totalPeak = 0
const rows: Array<{ name: string; mkt: string; now: number; peak: number; peakAt: Date; cuts: number }> = []
for (const c of atFloor) {
  const mine = logs.filter((l) => l.entityId === c.id)
  const vals = mine.flatMap((l) => [num(l.payloadBefore), num(l.payloadAfter)]).filter((v): v is number => v != null)
  const now = Number(c.dailyBudget ?? 0)
  totalNow += now
  if (!vals.length) { noHistory++; totalPeak += now; continue }
  const peak = Math.max(...vals)
  const peakRow = mine.find((l) => num(l.payloadBefore) === peak || num(l.payloadAfter) === peak)!
  if (peak > 1) {
    recoverable++
    totalPeak += peak
    rows.push({ name: c.name, mkt: c.marketplace, now, peak, peakAt: peakRow.createdAt, cuts: mine.filter((l) => (num(l.payloadAfter) ?? 0) < (num(l.payloadBefore) ?? 0)).length })
  } else { totalPeak += now }
}
rows.sort((a, b) => b.peak - a.peak)
console.log(`\n  🟢 recoverable (a pre-ratchet value > €1 exists in the log): ${recoverable}`)
console.log(`  ⚪ no budget history at all                                : ${noHistory}`)
console.log(`\n  ${pad('campaign', 40)} ${pad('mkt', 4)} ${pad('now', 7)} ${pad('peak', 8)} ${pad('cuts', 5)} peak seen`)
for (const r of rows.slice(0, 25)) {
  console.log(`  ${pad(r.name, 40)} ${pad(r.mkt, 4)} €${r.now.toFixed(2).padStart(5)} €${r.peak.toFixed(2).padStart(6)} ${String(r.cuts).padStart(5)} ${r.peakAt.toISOString().slice(0, 16)}`)
}
console.log(`\n  daily budget of the ${atFloor.length} at-floor campaigns, now : €${totalNow.toFixed(2)}`)
console.log(`  the same campaigns at their pre-ratchet peak       : €${totalPeak.toFixed(2)}`)
console.log(`  → restoring every one of them would add            : €${(totalPeak - totalNow).toFixed(2)}/day`)

// what does the account actually have room for? the monthly plans
const plans = await prisma.adBudgetPlan.findMany({
  where: { month: { gte: '2026-08' } },
  select: { marketplace: true, month: true, monthlyBudgetCents: true, autoPacing: true, stopOverSpend: true },
})
console.log(`\n══ the ceiling this would run into (tab 4 owns these) ══`)
let capTotal = 0
for (const p of plans) { capTotal += p.monthlyBudgetCents; console.log(`     ${pad(p.marketplace, 5)} ${p.month}  €${(p.monthlyBudgetCents / 100).toFixed(2).padStart(9)}  pacing=${p.autoPacing} stopOver=${p.stopOverSpend}`) }
console.log(`     TOTAL €${(capTotal / 100).toFixed(2)}/month ≈ €${(capTotal / 100 / 31).toFixed(2)}/day`)
console.log(`     current total daily budget, all ENABLED: €${camps.reduce((a, c) => a + Number(c.dailyBudget ?? 0), 0).toFixed(2)}`)

// A7's ceilings and refusals — what is actually recorded?
const refusals = await (prisma as unknown as { adWriteRefusal: { groupBy: (a: unknown) => Promise<Array<{ reason: string; _count: { _all: number } }>> } }).adWriteRefusal
  .groupBy({ by: ['reason'], _count: { _all: true } }).catch(() => [])
console.log(`\n══ A7 refusal records, by reason ══`)
for (const r of refusals) console.log(`     ${pad(String(r.reason), 40)} ${r._count._all}`)

await prisma.$disconnect()
