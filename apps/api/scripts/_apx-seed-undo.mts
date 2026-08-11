/**
 * NAF.AQ-S9R S9.6 — seed the undo-window states, then delete them.
 *
 * ⚠ SAFETY, established in code before this file was written (study §20.2):
 * every row here uses a FLEET tool, and all three are preview-only —
 * `getTool(name).execute` is undefined — so `decideApproval` takes the
 * `if (!tool?.execute)` branch, lands the row in `approved`, and there is no
 * code path to Amazon even if one commits.
 *
 * The stuck row is safer still: the sweep selects
 * `status:'scheduled', executeAfter:{ not: null, lte: now }`, so a null
 * `executeAfter` is never picked up at all. That is exactly why it was stuck.
 *
 * Nothing here enables a charter, writes AgentDefinition, moves a dial or
 * starts a cron.
 *
 * Usage:
 *   npx tsx scripts/_apx-seed-undo.mts seed
 *   npx tsx scripts/_apx-seed-undo.mts clean
 */
import '../src/env.js'
import prisma from '../src/db.js'

const MARKER = 'AQ-VERIFY-SEED'
const mode = process.argv[2] ?? 'seed'
const EXPIRES = () => new Date(Date.now() + 24 * 3600 * 1000)

if (mode === 'clean') {
  const runs = await prisma.agentRun.findMany({ where: { trigger: MARKER }, select: { id: true } })
  const ids = runs.map((r) => r.id)
  const seeded = await prisma.agentApproval.findMany({
    where: { agentRunId: { in: ids } },
    select: { id: true },
  })
  let audits = 0
  for (const a of seeded) {
    const r = await prisma.agentControlAudit.deleteMany({
      where: { toValue: { path: ['approvalId'], equals: a.id } },
    })
    audits += r.count
  }
  const ex = await prisma.agentExemplar.deleteMany({
    where: { situation: { path: ['marker'], equals: MARKER } },
  })
  const aps = await prisma.agentApproval.deleteMany({ where: { agentRunId: { in: ids } } })
  const rr = await prisma.agentRun.deleteMany({ where: { id: { in: ids } } })
  console.log(`deleted approvals=${aps.count} runs=${rr.count} exemplars=${ex.count} audits=${audits}`)

  const left = await prisma.agentApproval.count()
  const stray = await prisma.agentRun.count({ where: { trigger: MARKER } })
  const pending = await prisma.agentApproval.count({ where: { status: 'pending' } })
  const sched = await prisma.agentApproval.count({ where: { status: 'scheduled' } })
  const exLeft = await prisma.agentExemplar.count()
  const auditLeft = await prisma.agentControlAudit.count()
  console.log(
    `AgentApproval: ${left} (18) · pending: ${pending} (0) · scheduled: ${sched} (0) · ` +
      `seed runs: ${stray} (0) · AgentExemplar: ${exLeft} (0) · AgentControlAudit: ${auditLeft} (0)`,
  )
  if (left !== 18 || stray > 0 || pending > 0 || sched > 0 || exLeft > 0 || auditLeft > 0) {
    console.error('⚠ NOT CLEAN')
    process.exitCode = 1
  }
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

const preview = (label: string, to = 62) => ({
  target: { expression: `casco ${label}`, matchType: 'EXACT' },
  campaign: { name: 'AIREON-IT-Generic (SEED)' },
  currentBidCents: 40,
  proposedBidCents: to,
  effect: `Moves "casco ${label}" from €0.40 to €${(to / 100).toFixed(2)}.`,
})

console.log('seeding the undo-window states:')

// A live parked row. Ten minutes, not the real twenty seconds: a state being
// measured should not be racing the sweep. The COUNTDOWN VALUE is therefore a
// fixture artefact; what is being verified is the treatment, Hold and Undo.
await prisma.agentApproval.create({
  data: {
    agentRunId: run.id,
    toolName: 'set-target-bid',
    riskTier: 'high',
    args: { targetId: 'aq-seed-parked-live', proposedBidCents: 62 },
    preview: preview('parked live'),
    status: 'scheduled',
    executeAfter: new Date(Date.now() + 10 * 60 * 1000),
    decidedBy: 'awaissulhry',
    decidedAt: new Date(),
    operatorNote: 'checked the search term report first',
    expiresAt: EXPIRES(),
  },
})
console.log('  1 × parked · live countdown, Hold and Undo reachable')

// The defect-2 state: scheduled with NO run time. Cannot be produced by the
// product — only by a bug or by this line — and the sweep will never touch it.
await prisma.agentApproval.create({
  data: {
    agentRunId: run.id,
    toolName: 'set-target-bid',
    riskTier: 'high',
    args: { targetId: 'aq-seed-stuck', proposedBidCents: 55 },
    preview: preview('stuck', 55),
    status: 'scheduled',
    executeAfter: null,
    decidedBy: 'awaissulhry',
    decidedAt: new Date(),
    expiresAt: EXPIRES(),
  },
})
console.log('  1 × stuck  · scheduled with executeAfter = null')

// A decided row carrying the operator's own words AND a system reason, so the
// record can be checked for quoting exactly one of them.
await prisma.agentApproval.create({
  data: {
    agentRunId: run.id,
    toolName: 'set-target-bid',
    riskTier: 'medium',
    args: { targetId: 'aq-seed-bothvoices', proposedBidCents: 48 },
    preview: preview('both voices', 48),
    status: 'approved',
    decidedBy: 'awaissulhry',
    decidedAt: new Date(),
    operatorNote: 'fine on brand terms where we already rank',
    reason: 'approved; this tool is preview-only (no execute)',
    expiresAt: EXPIRES(),
  },
})
console.log('  1 × approved · operatorNote AND reason, to prove only one is quoted')

console.log('\nREMEMBER: npx tsx scripts/_apx-seed-undo.mts clean')
await prisma.$disconnect()
