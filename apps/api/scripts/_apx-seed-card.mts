/**
 * NAF.AQ — seed ONE inert approval so the decision card can be verified on
 * prod, then delete it. Same method and same discipline the AP.4/AP.6/AP.8
 * execution records used.
 *
 * Why this is safe, and it is safe on three independent counts:
 *
 * 1. `set-target-bid` is **preview-only** — it has no `execute()`, so
 *    `decideApproval` cannot run anything for it under any circumstances.
 *    This is the same wall that makes the whole queue unfillable.
 * 2. The `targetId` deliberately does not exist, so even a hypothetical
 *    executor would find nothing to change.
 * 3. `checkStaleness` re-runs the tool's dry-run at commit and would refuse
 *    on a missing target before anything else happened.
 *
 * The preview is hand-written rather than produced from a real campaign so
 * that nothing in this touches a real entity at all.
 *
 * Usage:
 *   npx tsx scripts/_apx-seed-card.mts seed
 *   npx tsx scripts/_apx-seed-card.mts clean
 */
import '../src/env.js'
import prisma from '../src/db.js'

const MARKER = 'AQ-VERIFY-SEED'
const mode = process.argv[2] ?? 'seed'

if (mode === 'clean') {
  const runs = await prisma.agentRun.findMany({
    where: { agentKey: 'amazon-bid-tuner', trigger: MARKER },
    select: { id: true },
  })
  const ids = runs.map((r) => r.id)
  const aps = await prisma.agentApproval.deleteMany({ where: { agentRunId: { in: ids } } })
  const rr = await prisma.agentRun.deleteMany({ where: { id: { in: ids } } })
  const audit = await prisma.agentControlAudit.deleteMany({
    where: { note: { contains: MARKER } },
  })
  console.log(`deleted approvals=${aps.count} runs=${rr.count} audit=${audit.count}`)
  const left = await prisma.agentApproval.count()
  console.log(`AgentApproval rows now: ${left}  (must be 18)`)
  await prisma.$disconnect()
  process.exit(0)
}

const run = await prisma.agentRun.create({
  data: {
    agentKey: 'amazon-bid-tuner',
    trigger: MARKER,
    mode: 'preview',
    status: 'done',
    ok: true,
    endedAt: new Date(),
  },
})

const ap = await prisma.agentApproval.create({
  data: {
    agentRunId: run.id,
    toolName: 'set-target-bid',
    riskTier: 'high',
    args: { targetId: 'seed-target-does-not-exist', bidCents: 84 },
    preview: {
      action: 'set-target-bid',
      target: {
        id: 'seed-target-does-not-exist',
        expression: 'casco integrale modulare',
        matchType: 'EXACT',
      },
      campaign: { id: 'seed', name: 'AIREON-IT-Generic (SEED)' },
      currentBidCents: 31,
      proposedBidCents: 84,
      deltaCents: 53,
      effect:
        'Moves "casco integrale modulare" from €0.31 to €0.84 in AIREON-IT-Generic (SEED).',
    },
    status: 'pending',
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
  },
})

console.log(`seeded approval ${ap.id} on run ${run.id}`)
console.log('REMEMBER: npx tsx scripts/_apx-seed-card.mts clean')
await prisma.$disconnect()
