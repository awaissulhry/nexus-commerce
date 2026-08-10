/**
 * NAF.AQ-S10R S10.5/S10.6 — seed the states the record and precedent can
 * render but production has never contained, then delete them.
 *
 * ⚠ SAFETY. Every approval here is one of `FLEET_TOOLS`, all three of which are
 * **preview-only** — no `execute()` in the registry, so no row here has a code
 * path to Amazon. Nothing enables a charter, writes `AgentDefinition`, moves a
 * dial or starts a cron. The one pending row exists to be LOOKED at, not
 * decided; Apply is never pressed.
 *
 * What this exists to prove, and could not be proven any other way:
 *
 * **AP.8 has never fired in production.** `trackRecords()` builds keys shaped
 * `agentKey::toolName`, and the card looks up `charterKey::toolName` — the same
 * shape, because `listInbox` sets `charterKey = run.agentKey`. The measured
 * reason it is dark is that `waiting` is fleet-tools-only while every one of
 * the 18 historical rows is a NON-fleet tool, so the two sets cannot intersect.
 * That is a claim about mechanism, and the honest way to settle it is to make
 * the sets intersect once: one DECIDED row and one PENDING row sharing a
 * worker and a fleet tool. If the signal renders, AP.8 is dark-but-correct. If
 * it does not, it is dark-and-broken and the study is wrong.
 *
 * `AgentExemplar` carries no foreign key to a run, so the marker lives in its
 * `situation` JSON and cleanup deletes by JSON path — the same technique the
 * audit-row cleanup uses. Cleanup keys on the marker ALONE, never on agentKey.
 *
 * Usage:
 *   npx tsx scripts/_apx-seed-record.mts seed
 *   npx tsx scripts/_apx-seed-record.mts clean
 */
import '../src/env.js'
import prisma from '../src/db.js'

const MARKER = 'AQ-VERIFY-SEED'
const mode = process.argv[2] ?? 'seed'
const EXPIRES = () => new Date(Date.now() + 24 * 3600 * 1000)
const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 3600 * 1000)

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
  console.log(`deleted approvals=${aps.count} runs=${rr.count} exemplars=${ex.count} auditRows=${audits}`)

  const left = await prisma.agentApproval.count()
  const stray = await prisma.agentRun.count({ where: { trigger: MARKER } })
  const pending = await prisma.agentApproval.count({ where: { status: { in: ['pending'] } } })
  const sched = await prisma.agentApproval.count({ where: { status: 'scheduled' } })
  const exLeft = await prisma.agentExemplar.count()
  const auditLeft = await prisma.agentControlAudit.count()
  console.log(
    `AgentApproval: ${left} (must be 18) · pending: ${pending} (0) · scheduled: ${sched} (0) · ` +
      `seed runs: ${stray} (0) · AgentExemplar: ${exLeft} (0) · AgentControlAudit: ${auditLeft} (0)`,
  )
  if (left !== 18 || stray > 0 || pending > 0 || sched > 0 || exLeft > 0 || auditLeft > 0) {
    console.error('⚠ NOT CLEAN')
    process.exitCode = 1
  }
  await prisma.$disconnect()
  process.exit(0)
}

async function runFor(agentKey: string): Promise<string> {
  const r = await prisma.agentRun.create({
    data: {
      agentKey,
      trigger: MARKER,
      mode: 'preview',
      status: 'done',
      ok: true,
      endedAt: new Date(),
    },
  })
  return r.id
}

const bidPreview = (label: string, from = 40, to = 62) => ({
  target: { expression: `casco ${label}`, matchType: 'EXACT' },
  campaign: { name: 'AIREON-IT-Generic (SEED)' },
  currentBidCents: from,
  proposedBidCents: to,
  effect: `Moves "casco ${label}" from €${(from / 100).toFixed(2)} to €${(to / 100).toFixed(2)}.`,
})

const tuner = await runFor('amazon-bid-tuner')
console.log('seeding the record + precedent states:')

// ── AP.8, the whole point of S10.5 ──────────────────────────────────────────
// A decided row and a waiting row sharing worker AND fleet tool, so the key
// `amazon-bid-tuner::set-target-bid` exists on both sides for the first time.
await prisma.agentApproval.create({
  data: {
    agentRunId: tuner,
    toolName: 'set-target-bid',
    riskTier: 'high',
    args: { targetId: 'aq-seed-ap8-history', proposedBidCents: 62 },
    preview: bidPreview('ap8 history'),
    status: 'rejected',
    /* A REAL decider and a REAL reason — this row also proves S10.3's rule from
       the other side: with an author, the reason renders quoted, as the
       operator's words. */
    decidedBy: 'awaissulhry',
    decidedAt: daysAgo(2),
    reason: 'too aggressive for a term this broad',
    requestedAt: daysAgo(2),
    expiresAt: EXPIRES(),
  },
})
console.log('  1 × rejected  · amazon-bid-tuner::set-target-bid · WITH decider and real reason')

await prisma.agentApproval.create({
  data: {
    agentRunId: tuner,
    toolName: 'set-target-bid',
    riskTier: 'high',
    args: { targetId: 'aq-seed-ap8-waiting', proposedBidCents: 66 },
    preview: bidPreview('ap8 waiting', 40, 66),
    status: 'pending',
    expiresAt: EXPIRES(),
  },
})
console.log('  1 × pending   · same worker, same tool → AP.8 can finally resolve a key')

// ── statuses the UI can render and production has never held ────────────────
for (const [status, note] of [
  ['superseded', 'AQ.8 — "You changed the number"'],
  ['approved', 'decided, not yet run'],
  ['executing', 'running now'],
] as const) {
  await prisma.agentApproval.create({
    data: {
      agentRunId: tuner,
      toolName: 'set-target-bid',
      riskTier: 'medium',
      args: { targetId: `aq-seed-${status}`, proposedBidCents: 58 },
      preview: bidPreview(status, 40, 58),
      status,
      decidedBy: 'awaissulhry',
      decidedAt: daysAgo(1),
      requestedAt: daysAgo(1),
      expiresAt: EXPIRES(),
    },
  })
  console.log(`  1 × ${status.padEnd(11)} · ${note}`)
}

// An expired row — the Expired tab has never had one, and the section brief
// asks it to read as "died waiting for you", with how long it waited.
await prisma.agentApproval.create({
  data: {
    agentRunId: tuner,
    toolName: 'set-target-bid',
    riskTier: 'high',
    args: { targetId: 'aq-seed-expired', proposedBidCents: 71 },
    preview: bidPreview('expired', 40, 71),
    status: 'expired',
    requestedAt: daysAgo(4),
    expiresAt: daysAgo(3),
  },
})
console.log('  1 × expired    · waited 24h and died')

// ── precedent populated ─────────────────────────────────────────────────────
for (const [label, note] of [
  ['rejected', 'too aggressive for a term this broad'],
  ['accepted', 'fine on brand terms where we already rank'],
] as const) {
  await prisma.agentExemplar.create({
    data: {
      charterKey: 'amazon-bid-tuner',
      label,
      situation: { marker: MARKER, toolName: 'set-target-bid' },
      proposal: { proposedBidCents: 62 },
      operatorNote: note,
      active: true,
    },
  })
}
console.log('  2 × AgentExemplar · precedent populated (marker in situation JSON)')

console.log('\nREMEMBER: npx tsx scripts/_apx-seed-record.mts clean')
await prisma.$disconnect()
