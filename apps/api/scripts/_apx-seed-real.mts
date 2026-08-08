/**
 * NAF.AQ.8 — seed ONE approval against a REAL ad target so the SUCCESSFUL
 * edit-then-approve path can be exercised, then delete it.
 *
 * The inert fixture (`_apx-seed-card.mts`) cannot test this: it points at a
 * target that does not exist, so the tool's handler correctly refuses and only
 * the REFUSAL path is reachable. Verifying that an edit succeeds needs the
 * handler to succeed, which needs a real target.
 *
 * Still inert, and the reason is structural rather than careful:
 * `set-target-bid` is **preview-only** — it has no `execute()`, so
 * `decideApproval` cannot run anything for it under any circumstances, for
 * this row or any other. Approving it would record a decision and change
 * nothing on Amazon. Nothing here writes to the ad target; the handler only
 * reads it.
 *
 *   npx tsx scripts/_apx-seed-real.mts seed <targetId>
 *   npx tsx scripts/_apx-seed-real.mts clean
 */
import '../src/env.js'
import prisma from '../src/db.js'

const MARKER = 'AQ8-EDIT-SEED'
const mode = process.argv[2] ?? 'seed'

if (mode === 'clean') {
  const runs = await prisma.agentRun.findMany({
    where: { trigger: MARKER },
    select: { id: true },
  })
  const ids = runs.map((r) => r.id)
  const aps = await prisma.agentApproval.deleteMany({ where: { agentRunId: { in: ids } } })
  const rr = await prisma.agentRun.deleteMany({ where: { id: { in: ids } } })
  const audit = await prisma.agentControlAudit.deleteMany({ where: { charterKey: 'operator-edit' } })
  console.log(`deleted approvals=${aps.count} runs=${rr.count} audit=${audit.count}`)
  console.log(`AgentApproval rows now: ${await prisma.agentApproval.count()}  (must be 18)`)
  await prisma.$disconnect()
  process.exit(0)
}

const targetId = process.argv[3]
if (!targetId) throw new Error('usage: seed <targetId>')
const t = await prisma.adTarget.findUnique({
  where: { id: targetId },
  select: {
    id: true, expressionValue: true, expressionType: true, bidCents: true,
    adGroup: { select: { campaign: { select: { id: true, name: true } } } },
  },
})
if (!t) throw new Error('target not found')

const run = await prisma.agentRun.create({
  data: { agentKey: 'amazon-bid-tuner', trigger: MARKER, mode: 'preview', status: 'done', ok: true, endedAt: new Date() },
})
const current = t.bidCents ?? 0
// A deliberately SMALL proposed change: even in a world where this could
// execute (it cannot), it would be a few cents on one keyword.
const proposed = current + 3
const ap = await prisma.agentApproval.create({
  data: {
    agentRunId: run.id,
    toolName: 'set-target-bid',
    riskTier: 'high',
    args: { targetId: t.id, proposedBidCents: proposed },
    preview: {
      action: 'set-target-bid',
      target: { id: t.id, expression: t.expressionValue, matchType: t.expressionType },
      campaign: { id: t.adGroup.campaign.id, name: t.adGroup.campaign.name },
      currentBidCents: current,
      proposedBidCents: proposed,
      deltaCents: proposed - current,
      effect: `Moves "${t.expressionValue}" from €${(current / 100).toFixed(2)} to €${(proposed / 100).toFixed(2)} in ${t.adGroup.campaign.name}.`,
    },
    status: 'pending',
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
  },
})
console.log(`seeded ${ap.id} target=${t.id} ${current}c -> ${proposed}c`)
await prisma.$disconnect()
