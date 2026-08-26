/**
 * BUD.1 — does `liveBidWritesEnabled` actually stop a budget cut?
 *
 * `updateCampaignWithSync` writes the LOCAL Campaign row with no gate call; the gate runs later in
 * `ads-sync.worker.ts:356`, at DISPATCH, and marks the queue row SKIPPED. So a gate-closed campaign
 * still gets cut locally and still gets an AD_BUDGET_UPDATE row — it just never reaches Amazon.
 *
 * If that is true, "campaigns a trim rule can still move" is 28 (above €1), not 24 (above €1 AND
 * gate open), and the 4 gate-closed ones are a DIVERGENCE, not a protection.
 *
 * Prediction to test: the 4 campaigns whose newest log row disagrees with the live value are the
 * same 4 that are above €1 with the gate closed.
 *
 * READ-ONLY.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))

const enabled = await prisma.campaign.findMany({
  where: { status: 'ENABLED' },
  select: { id: true, name: true, marketplace: true, dailyBudget: true, liveBidWritesEnabled: true },
})
const above = enabled.filter((c) => Number(c.dailyBudget) > 1)
const gateClosed = above.filter((c) => !c.liveBidWritesEnabled)

console.log(`\n── the 4 above €1 with the gate CLOSED ──`)
for (const c of gateClosed) console.log(`  ${pad(c.name, 44)} ${c.marketplace} €${Number(c.dailyBudget).toFixed(2)}`)

// Their budget-write history, and where the outbound went.
console.log(`\n── their AD_BUDGET_UPDATE rows and the fate of each outbound ──`)
for (const c of gateClosed) {
  const logs = await prisma.advertisingActionLog.findMany({
    where: { actionType: 'AD_BUDGET_UPDATE', entityId: c.id },
    select: { createdAt: true, userId: true, payloadBefore: true, payloadAfter: true, amazonResponseStatus: true, outboundQueueId: true },
    orderBy: { createdAt: 'desc' }, take: 4,
  })
  const bud = (v: unknown) => { const o = v as Record<string, unknown> | null; const x = o?.dailyBudget; return typeof x === 'number' ? x : null }
  console.log(`\n  ${c.name}  (live value now €${Number(c.dailyBudget).toFixed(2)})  ${logs.length} rows shown`)
  for (const l of logs) {
    let q: { syncStatus: string; errorCode: string | null } | null = null
    if (l.outboundQueueId) {
      q = await prisma.outboundSyncQueue.findUnique({ where: { id: l.outboundQueueId }, select: { syncStatus: true, errorCode: true } })
    }
    console.log(`     ${l.createdAt.toISOString().slice(0, 16)} €${bud(l.payloadBefore)?.toFixed(2)} → €${bud(l.payloadAfter)?.toFixed(2)}  by ${pad(String(l.userId), 34)} amz=${pad(String(l.amazonResponseStatus), 8)} queue=${q ? `${q.syncStatus}${q.errorCode ? `/${q.errorCode}` : ''}` : '—'}`)
  }
}

// The direct question: how many AD_BUDGET_UPDATE outbound rows were denied by the gate, ever?
const denied = await prisma.outboundSyncQueue.count({ where: { errorCode: 'WRITE_GATE_DENIED', syncType: 'AD_BUDGET_UPDATE' } })
const allBudgetQueue = await prisma.outboundSyncQueue.groupBy({
  by: ['syncStatus'], where: { syncType: 'AD_BUDGET_UPDATE' }, _count: { _all: true },
})
console.log(`\n── every AD_BUDGET_UPDATE outbound row, by status ──`)
for (const r of allBudgetQueue.sort((a, b) => b._count._all - a._count._all)) console.log(`  ${pad(r.syncStatus, 14)} ${r._count._all}`)
console.log(`  of which WRITE_GATE_DENIED : ${denied}`)

// And: did a gate-closed campaign ever have its LOCAL value cut? (the whole question)
console.log(`\n── did the local value move on a gate-closed campaign? ──`)
for (const c of gateClosed) {
  const n = await prisma.advertisingActionLog.count({ where: { actionType: 'AD_BUDGET_UPDATE', entityId: c.id } })
  const cuts = await prisma.advertisingActionLog.findMany({
    where: { actionType: 'AD_BUDGET_UPDATE', entityId: c.id },
    select: { payloadBefore: true, payloadAfter: true },
  })
  const bud = (v: unknown) => { const o = v as Record<string, unknown> | null; const x = o?.dailyBudget; return typeof x === 'number' ? x : null }
  const down = cuts.filter((x) => { const b = bud(x.payloadBefore); const a = bud(x.payloadAfter); return b != null && a != null && a < b }).length
  console.log(`  ${pad(c.name, 44)} ${n} budget writes, ${down} of them cuts — with the gate CLOSED`)
}

await prisma.$disconnect()
