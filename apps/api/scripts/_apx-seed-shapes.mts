/**
 * NAF.AQ-S6R S6.d — seed one row per CARD SHAPE the design study defines, so
 * every shape is rendered and measured rather than reasoned about, then delete
 * them all.
 *
 * ⚠ WHY THIS IS SAFE, AND TWO OF THESE ARE NOT PREVIEW-ONLY TOOLS.
 *
 * `_apx-seed-card.mts` gets to lean on `set-target-bid` having no `execute()`.
 * Two shapes here deliberately use tools that DO have executors — `set-price`
 * and `send-customer-message` — because `canExecute` is what shapes (b) and (c)
 * exist to exercise, and it is read from the live tool registry by tool name.
 * There is no way to render those shapes with a preview-only tool.
 *
 * So the safety comes from somewhere else, on three counts:
 *
 * 1. **Every row points at something that does not exist.** The SKU and the
 *    recipient are seed strings. A handler asked to act on them finds nothing.
 * 2. **`checkStaleness` is fail-closed** (AQ.2) and runs the tool's own dry-run
 *    at commit. Both tools have `MATERIAL_PREVIEW_FIELDS` entries, so a stale
 *    or unresolvable row is REFUSED rather than executed.
 * 3. **Nothing approves an approval except a human clicking Apply.** Expiry
 *    means refused, never approved; the maintenance sweep only expires. These
 *    rows are read, screenshotted and deleted — Apply is never pressed on the
 *    two executable ones, and this script never decides anything.
 *
 * Nothing here enables a charter, moves a dial, writes AgentDefinition or
 * starts a cron. It creates rows and deletes them.
 *
 * Shares `_apx-seed-card.mts`'s MARKER deliberately, so THAT script's `clean`
 * also removes these — one cleanup path, not two that can each miss.
 *
 * Usage:
 *   npx tsx scripts/_apx-seed-shapes.mts seed
 *   npx tsx scripts/_apx-seed-shapes.mts clean
 */
import '../src/env.js'
import prisma from '../src/db.js'

const MARKER = 'AQ-VERIFY-SEED'
const mode = process.argv[2] ?? 'seed'
const EXPIRES = () => new Date(Date.now() + 24 * 3600 * 1000)

if (mode === 'clean') {
  const runs = await prisma.agentRun.findMany({ where: { trigger: MARKER }, select: { id: true } })
  const ids = runs.map((r) => r.id)
  const aps = await prisma.agentApproval.deleteMany({ where: { agentRunId: { in: ids } } })
  const rr = await prisma.agentRun.deleteMany({ where: { id: { in: ids } } })
  console.log(`deleted approvals=${aps.count} runs=${rr.count}`)
  // Assert the END STATE, never the cleanup's own success message — this
  // cleanup has been over-narrow twice in this engagement.
  const left = await prisma.agentApproval.count()
  const stray = await prisma.agentRun.count({ where: { trigger: MARKER } })
  console.log(`AgentApproval rows now: ${left} (must be 18); seed runs left: ${stray}`)
  if (left !== 18 || stray > 0) {
    console.error('⚠ NOT CLEAN')
    process.exitCode = 1
  }
  await prisma.$disconnect()
  process.exit(0)
}

async function seed(
  label: string,
  agentKey: string,
  data: Parameters<typeof prisma.agentApproval.create>[0]['data'] extends infer D
    ? Omit<D & Record<string, unknown>, 'agentRunId'>
    : never,
) {
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
  const ap = await prisma.agentApproval.create({
    data: { ...(data as Record<string, unknown>), agentRunId: run.id } as never,
  })
  console.log(`  ${label.padEnd(34)} ${ap.id}`)
}

console.log('seeding one row per card shape:')

// (b) a price change — high risk, reversible, CAN execute. Non-existent SKU.
await seed('(b) price change · can execute', 'listing-quality-keeper', {
  toolName: 'set-price',
  riskTier: 'high',
  args: { sku: 'AQ-SEED-SKU-DOES-NOT-EXIST', priceEur: 39 },
  preview: {
    sku: 'AQ-SEED-SKU-DOES-NOT-EXIST',
    changes: { 'base price': { from: 49, to: 39 } },
    deltaPct: -20,
    effect: 'Lowers the list price on one SKU.',
  },
  status: 'pending',
  expiresAt: EXPIRES(),
})

// (c) a customer message — IRREVERSIBLE and can execute, so the tick appears.
await seed('(c) customer message · tick', 'listing-quality-keeper', {
  toolName: 'send-customer-message',
  riskTier: 'high',
  args: { orderId: 'AQ-SEED-ORDER-DOES-NOT-EXIST', message: 'seed' },
  preview: {
    to: 'aq-seed-recipient@example.invalid',
    marketplace: 'amazon.it',
    message: 'Thank you for your order — your helmet ships tomorrow.',
    suppressed: false,
    note: 'SEED — never sent',
  },
  status: 'pending',
  expiresAt: EXPIRES(),
})

// (d) came back from STALENESS — nothing was attempted.
await seed('(d) comeback · stale', 'amazon-bid-tuner', {
  toolName: 'set-target-bid',
  riskTier: 'high',
  args: { targetId: 'seed-target-does-not-exist', proposedBidCents: 84 },
  preview: {
    target: { expression: 'casco modulare', matchType: 'EXACT' },
    campaign: { name: 'AIREON-IT-Generic (SEED)' },
    currentBidCents: 31,
    proposedBidCents: 84,
    effect: 'Moves "casco modulare" from €0.31 to €0.84.',
  },
  status: 'pending',
  reason: 'not run — the bid had already moved to €0.55 before this ran',
  decidedBy: 'awaissulhry',
  expiresAt: EXPIRES(),
})

// (e) came back from a FAILED EXECUTION — it was attempted.
await seed('(e) comeback · execution failed', 'amazon-bid-tuner', {
  toolName: 'set-target-bid',
  riskTier: 'high',
  args: { targetId: 'seed-target-does-not-exist', proposedBidCents: 84 },
  preview: {
    target: { expression: 'casco integrale', matchType: 'EXACT' },
    campaign: { name: 'AIREON-IT-Generic (SEED)' },
    currentBidCents: 31,
    proposedBidCents: 84,
    effect: 'Moves "casco integrale" from €0.31 to €0.84.',
  },
  status: 'pending',
  reason: 'execution failed: Amazon returned 429 (throttled) after 3 attempts',
  decidedBy: 'awaissulhry',
  expiresAt: EXPIRES(),
})

// (h) an action that describes NOTHING — no delta, no evidence, no effect.
await seed('(h) no delta, no evidence', 'amazon-bid-tuner', {
  toolName: 'set-target-bid',
  riskTier: 'high',
  args: { targetId: 'seed-target-does-not-exist' },
  preview: {},
  status: 'pending',
  expiresAt: EXPIRES(),
})

console.log('\nREMEMBER: npx tsx scripts/_apx-seed-shapes.mts clean')
await prisma.$disconnect()
