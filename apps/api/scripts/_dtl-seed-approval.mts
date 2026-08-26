// NAF.AP.4 verification — seed ONE pending approval so the undo round trip
// can be exercised against real code, then remove it.
//
// Safety: the args reference a target id that does not exist, so even an
// accidental execution cannot change anything on Amazon — it would fail at
// the API call. Run with `clean` to delete it again.
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const MARKER = '__ap4-local-verification__'

if (process.argv[2] === 'clean') {
  const seeded = await prisma.agentApproval.findMany({
    where: { args: { path: ['_marker'], equals: MARKER } },
    select: { id: true },
  })
  const ids = seeded.map((s) => s.id)
  // The verification also wrote audit rows and possibly an exemplar; leaving
  // those behind would pollute a real audit trail with a local test.
  let audits = 0
  for (const id of ids) {
    const del = await prisma.agentControlAudit.deleteMany({
      where: { toValue: { path: ['approvalId'], equals: id } },
    })
    audits += del.count
  }
  const exemplars = await prisma.agentExemplar
    .deleteMany({ where: { sourceApprovalId: { in: ids } } })
    .catch(() => ({ count: 0 }))
  const del = await prisma.agentApproval.deleteMany({ where: { id: { in: ids } } })
  console.log('deleted approvals:', del.count, 'audit rows:', audits, 'exemplars:', exemplars.count)
  await prisma.$disconnect()
  process.exit(0)
}

const run = await prisma.agentRun.findFirst({
  where: { agentKey: 'amazon-bid-tuner', mode: { not: null } },
  select: { id: true },
  orderBy: { createdAt: 'desc' },
})
if (!run) throw new Error('no bid-tuner run to attach to')

const ap = await prisma.agentApproval.create({
  data: {
    agentRunId: run.id,
    toolName: 'set-target-bid',
    riskTier: 'low',
    args: {
      _marker: MARKER,
      targetId: 'DOES-NOT-EXIST-ap4-verification',
      proposedBidCents: 25,
    },
    preview: { effect: 'LOCAL CHECK ONLY — moves a non-existent target to €0.25.' },
    status: 'pending',
    expiresAt: new Date(Date.now() + 3600_000),
  },
  select: { id: true, status: true },
})
console.log('seeded approval:', ap.id, ap.status)
await prisma.$disconnect()
