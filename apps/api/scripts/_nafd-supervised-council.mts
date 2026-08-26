// NAF C4/D4 — the supervised council run on prod. Runs the REAL path
// (runFleetCouncilOnce → runFleet('council') → director → critic → queue),
// not a re-implementation. The two new charters are enabled at their caps
// for THIS run only and restored to OFF in a finally — the fleet's resting
// state stays dark. Analysts stay OFF throughout (their findings from the
// 08-04/05 supervised sweeps are open and unexpired).
//
// Run via: railway run npx tsx scripts/_nafd-supervised-council.mts
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { seedCharters, bustCharterCache } = await import(
  '../src/services/agent-fleet/charter-registry.js'
)
const { runFleetCouncilOnce } = await import(
  '../src/services/agent-fleet/fleet-council.service.js'
)

const t0 = new Date()

// 0 — seed (idempotent, version-matched): director + plan-critic born OFF.
const seeded = await seedCharters()
console.log('seed:', JSON.stringify(seeded))

// 1 — pre-run baseline for the zero-Amazon check: any NEW outbound ads
// queue row (dead or alive) in the window would mean something tried to
// write. Zero expected — the propose tools have no execute.
const outboundBefore = await prisma.outboundSyncQueue.count({
  where: { syncType: { startsWith: 'AD_' }, createdAt: { gte: t0 } },
})

// 2 — enable the two under test, at their caps.
const flips: Array<[string, string]> = [
  ['amazon-ads-director', 'PROPOSE'],
  ['plan-critic', 'OBSERVE'],
]
for (const [key, level] of flips) {
  const r = await prisma.agentCharter.updateMany({
    where: { key },
    data: { enabled: true, autonomyLevel: level },
  })
  if (r.count === 0) throw new Error(`charter ${key} not seeded — aborting`)
}
bustCharterCache()
console.log('enabled for this run:', flips.map(([k, l]) => `${k}@${l}`).join(', '))

try {
  // 3 — the real council.
  const result = await runFleetCouncilOnce()
  console.log('\nCOUNCIL RESULT:', JSON.stringify(result, null, 2))

  // 4 — verification digest.
  if (result.planId) {
    const plan = await prisma.agentPlan.findUnique({ where: { id: result.planId } })
    console.log('\nPLAN:', plan?.headline)
    console.log('narrative:', plan?.narrative)
    console.log('status:', plan?.status, '· criticVerdict:', plan?.criticVerdict)
    console.log('blastRadius:', JSON.stringify(plan?.blastRadius))
    const items = (plan?.items ?? []) as Array<Record<string, unknown>>
    console.log(`items (${items.length}):`)
    for (const it of items) {
      console.log(
        ` #${it.rank} ${it.tool} finding=${it.findingId} args=${JSON.stringify(it.args)}`,
      )
    }
    const dropped = (plan?.droppedItems ?? []) as Array<Record<string, unknown>>
    console.log(`dropped (${dropped.length}):`)
    for (const d of dropped) console.log(` ${d.findingId}: ${d.reason}`)
    console.log('criticNotes:', JSON.stringify(plan?.criticNotes, null, 2))
    console.log('approvalIds:', JSON.stringify(plan?.approvalIds))

    const approvalIds = (plan?.approvalIds ?? []) as string[]
    if (approvalIds.length) {
      const approvals = await prisma.agentApproval.findMany({
        where: { id: { in: approvalIds } },
      })
      console.log(`\nAPPROVALS (${approvals.length}):`)
      for (const a of approvals) {
        console.log(
          ` ${a.id} ${a.toolName} status=${a.status}\n   args=${JSON.stringify(a.args)}\n   preview=${JSON.stringify(a.preview)}`,
        )
      }
    }
  }

  // 5 — the runs and their step traces.
  const runs = await prisma.agentRun.findMany({
    where: { orchestrationId: result.orchestrationId },
    select: {
      id: true, agentKey: true, ok: true, status: true, findingCount: true,
      costUSD: true, latencyMs: true, errorMessage: true,
    },
  })
  console.log('\nRUNS:', JSON.stringify(runs, null, 2))
  const stepTypes = await prisma.agentStep.groupBy({
    by: ['type', 'ok'],
    where: { agentRunId: { in: runs.map((r) => r.id) } },
    _count: true,
  })
  console.log('step types:', JSON.stringify(stepTypes))
  const cost = runs.reduce((s, r) => s + Number(r.costUSD ?? 0), 0)
  console.log('council cost USD:', cost.toFixed(6))

  // 6 — zero-Amazon evidence: no execute exists on the propose tools
  // (structural); belt-and-braces, no new outbound AD_* queue rows.
  const outboundAfter = await prisma.outboundSyncQueue.count({
    where: { syncType: { startsWith: 'AD_' }, createdAt: { gte: t0 } },
  })
  console.log(
    `outbound AD_* rows in window: before=${outboundBefore} after=${outboundAfter} (delta ${outboundAfter - outboundBefore})`,
  )
} finally {
  // 7 — back to dark, whatever happened above.
  for (const [key] of flips) {
    await prisma.agentCharter.updateMany({
      where: { key },
      data: { enabled: false, autonomyLevel: 'OFF' },
    })
  }
  bustCharterCache()
  const resting = await prisma.agentCharter.findMany({
    select: { key: true, enabled: true, autonomyLevel: true },
    orderBy: { key: 'asc' },
  })
  console.log('\nresting state restored:', JSON.stringify(resting))
}
await prisma.$disconnect()
