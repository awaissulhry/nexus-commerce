/**
 * NAF.AQ-S8R S8.5 — seed the FLEET queue so the bulk states can be rendered
 * and measured, then delete them.
 *
 * ⚠ Different safety argument from `_apx-seed-outside.mts`, and a simpler one.
 *
 * Every tool here is one of `FLEET_TOOLS` — `set-target-bid`,
 * `create-negative-keyword`, `graduate-keyword` — and all three are
 * **preview-only**: they have no `execute()` in the tool registry, so there is
 * no code path from these rows to Amazon even if one were approved. That is
 * the same fact the page states on every card: "Approving records your
 * decision and teaches the fleet, and changes nothing on Amazon."
 *
 * These rows are also, by construction, the ones S8.4 ALLOWS into a bulk
 * approve — which is the point: the bulk states cannot be rendered with rows
 * the guard rejects.
 *
 * Nothing here enables a charter, moves a dial, writes AgentDefinition or
 * starts a cron. Bulk decisions are NOT executed during verification: the
 * result banner is client state and is checked by stubbing the response, so no
 * approval is ever decided by this engagement.
 *
 * 26 rows in one group is deliberate — S8.3's typed confirmation only appears
 * above 24, and a threshold you cannot see is a threshold you cannot verify.
 *
 * Shares `_apx-seed-card.mts`'s MARKER so every cleanup path removes these too.
 *
 * Usage:
 *   npx tsx scripts/_apx-seed-bulk.mts seed
 *   npx tsx scripts/_apx-seed-bulk.mts clean
 */
import '../src/env.js'
import prisma from '../src/db.js'

const MARKER = 'AQ-VERIFY-SEED'
const mode = process.argv[2] ?? 'seed'
const EXPIRES = () => new Date(Date.now() + 24 * 3600 * 1000)

if (mode === 'clean') {
  const runs = await prisma.agentRun.findMany({
    where: { trigger: MARKER },
    select: { id: true },
  })
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
  const aps = await prisma.agentApproval.deleteMany({ where: { agentRunId: { in: ids } } })
  const rr = await prisma.agentRun.deleteMany({ where: { id: { in: ids } } })
  console.log(`deleted approvals=${aps.count} runs=${rr.count} auditRows=${audits}`)

  const left = await prisma.agentApproval.count()
  const stray = await prisma.agentRun.count({ where: { trigger: MARKER } })
  const pending = await prisma.agentApproval.count({
    where: { status: { in: ['pending', 'scheduled'] } },
  })
  const auditLeft = await prisma.agentControlAudit.count()
  const exemplars = await prisma.agentExemplar.count()
  console.log(
    `AgentApproval: ${left} (must be 18) · pending: ${pending} (0) · seed runs: ${stray} (0) · ` +
      `AgentControlAudit: ${auditLeft} (0) · AgentExemplar: ${exemplars} (0)`,
  )
  if (left !== 18 || stray > 0 || pending > 0 || auditLeft > 0 || exemplars > 0) {
    console.error('⚠ NOT CLEAN')
    process.exitCode = 1
  }
  await prisma.$disconnect()
  process.exit(0)
}

/** One run per worker, so grouping and the same-worker rule are real. */
async function runFor(agentKey: string): Promise<string> {
  const run = await prisma.agentRun.create({
    data: {
      agentKey,
      trigger: MARKER,
      mode: 'preview',
      status: 'done',
      ok: true,
      endedAt: new Date(),
    },
  })
  return run.id
}

const tunerRun = await runFor('amazon-bid-tuner')
const minerRun = await runFor('amazon-negative-miner')

console.log('seeding the fleet queue for the bulk states:')

// 26 homogeneous rows, one worker, one kind — above S8.3's threshold of 24 so
// the typed confirmation is reachable, and below it after de-selecting two.
for (let i = 1; i <= 26; i++) {
  await prisma.agentApproval.create({
    data: {
      agentRunId: tunerRun,
      toolName: 'set-target-bid',
      riskTier: 'high',
      args: { targetId: `aq-seed-target-${i}`, proposedBidCents: 60 + i },
      preview: {
        target: { expression: `casco seed ${i}`, matchType: 'EXACT' },
        campaign: { name: 'AIREON-IT-Generic (SEED)' },
        currentBidCents: 40,
        proposedBidCents: 60 + i,
        effect: `Moves "casco seed ${i}" from €0.40 to €${((60 + i) / 100).toFixed(2)}.`,
      },
      status: 'pending',
      expiresAt: EXPIRES(),
    },
  })
}
console.log('  26 × set-target-bid   · amazon-bid-tuner   (above the typed-confirmation threshold)')

// A different worker AND a different kind, so both homogeneity refusals can be
// produced by selecting across the two groups.
for (let i = 1; i <= 2; i++) {
  await prisma.agentApproval.create({
    data: {
      agentRunId: minerRun,
      toolName: 'create-negative-keyword',
      riskTier: 'medium',
      args: { campaignId: `aq-seed-campaign-${i}`, keyword: `seed negative ${i}` },
      preview: {
        campaign: { name: 'AIREON-IT-Generic (SEED)' },
        keyword: `seed negative ${i}`,
        matchType: 'PHRASE',
        effect: `Stops ads showing for "seed negative ${i}".`,
      },
      status: 'pending',
      expiresAt: EXPIRES(),
    },
  })
}
console.log('  2  × create-negative-keyword · amazon-negative-miner (mixed worker AND kind)')

// A parked row in the tuner group — it must be excluded from select-all and
// must produce the "not affected" clause if selected by hand.
await prisma.agentApproval.create({
  data: {
    agentRunId: tunerRun,
    toolName: 'set-target-bid',
    riskTier: 'high',
    args: { targetId: 'aq-seed-target-parked', proposedBidCents: 99 },
    preview: {
      target: { expression: 'casco seed parked', matchType: 'EXACT' },
      campaign: { name: 'AIREON-IT-Generic (SEED)' },
      currentBidCents: 40,
      proposedBidCents: 99,
      effect: 'Moves "casco seed parked" from €0.40 to €0.99.',
    },
    status: 'scheduled',
    // Ten minutes, not the real twenty seconds: the maintenance sweep reached a
    // 20-second seed during S5 and tried to commit it. Fail-closed held, but a
    // state you want to measure should not be racing a cron.
    executeAfter: new Date(Date.now() + 10 * 60 * 1000),
    decidedBy: 'awaissulhry',
    expiresAt: EXPIRES(),
  },
})
console.log('  1  × parked            · amazon-bid-tuner   (must be excluded from select-all)')

console.log('\nREMEMBER: npx tsx scripts/_apx-seed-bulk.mts clean')
await prisma.$disconnect()
