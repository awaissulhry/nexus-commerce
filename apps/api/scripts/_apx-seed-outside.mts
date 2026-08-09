/**
 * NAF.AQ-S5R — seed the OUTSIDE queue: one row per producer and per state the
 * S5 study defines, so every state is rendered and measured rather than
 * reasoned about, then deleted.
 *
 * ⚠ WHY THIS IS SAFE. These rows deliberately use the four tools that DO have
 * executors — that is the entire point of section 5, and `canExecute` is read
 * from the live tool registry by tool name, so there is no way to render these
 * states with a preview-only tool.
 *
 * The safety is structural, not hopeful:
 *
 * 1. **Every row points at something that does not exist.** Every SKU, order
 *    and recipient below is a seed string. A handler asked to act on one finds
 *    nothing.
 * 2. **`checkStaleness` is fail-closed** (AQ.2) and runs the tool's own dry-run
 *    at commit, so an unresolvable row is REFUSED rather than executed.
 * 3. **Nothing approves an approval except a human clicking Apply**, and Apply
 *    is never pressed on these. Expiry means refused, never approved.
 * 4. **This script never enables anything.** It does not write
 *    `AgentDefinition`, does not touch a dial, does not start a cron. It
 *    creates rows and deletes them. `pricing-watchdog` and
 *    `listing-quality-keeper` appear here only as the `agentKey` STRING on an
 *    inert run row — seeding a name is not switching an agent on.
 *
 * Shares `_apx-seed-card.mts`'s MARKER deliberately, so every cleanup path on
 * this page removes these too — one cleanup, not three that can each miss.
 *
 * Usage:
 *   npx tsx scripts/_apx-seed-outside.mts seed
 *   npx tsx scripts/_apx-seed-outside.mts clean
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
  const aps = await prisma.agentApproval.deleteMany({ where: { agentRunId: { in: ids } } })
  const rr = await prisma.agentRun.deleteMany({ where: { id: { in: ids } } })
  console.log(`deleted approvals=${aps.count} runs=${rr.count}`)
  // Assert the END STATE, never this script's own success message — the
  // cleanup on this page has been over-narrow twice.
  const left = await prisma.agentApproval.count()
  const stray = await prisma.agentRun.count({ where: { trigger: MARKER } })
  const pending = await prisma.agentApproval.count({
    where: { status: { in: ['pending', 'scheduled'] } },
  })
  console.log(`AgentApproval rows: ${left} (must be 18) · pending: ${pending} (must be 0) · seed runs: ${stray} (must be 0)`)
  if (left !== 18 || stray > 0 || pending > 0) {
    console.error('⚠ NOT CLEAN')
    process.exitCode = 1
  }
  await prisma.$disconnect()
  process.exit(0)
}

async function seed(
  label: string,
  agentKey: string,
  data: Record<string, unknown>,
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
    data: { ...data, agentRunId: run.id } as never,
  })
  console.log(`  ${label.padEnd(42)} ${ap.id}`)
}

console.log('seeding the outside queue — one row per producer and per state:')

// ── the three real producers, so all three origin sentences render ──────────

// A PERSON, via the copilot's "Request approval" button. 8 of prod's 18 rows
// carry this key, and the page used to call it "an agent from before the fleet".
await seed('(b) a person · set-price', 'manual-action', {
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

// A live registered cron, switched off. Seeding its NAME is not enabling it.
await seed('(c) price watchdog · set-price', 'pricing-watchdog', {
  toolName: 'set-price',
  riskTier: 'high',
  args: { sku: 'AQ-SEED-SKU-ALSO-FAKE', priceEur: 129 },
  preview: {
    sku: 'AQ-SEED-SKU-ALSO-FAKE',
    changes: { 'base price': { from: 149, to: 129 } },
    deltaPct: -13.4,
    effect: 'Lowers the list price on one SKU.',
  },
  status: 'pending',
  expiresAt: EXPIRES(),
})

await seed('(c) listing keeper · customer message', 'listing-quality-keeper', {
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

// An unknown key, to exercise the fallback rather than assume it.
await seed('(c) unknown producer · apply-content', 'some-other-system', {
  toolName: 'apply-content',
  riskTier: 'medium',
  args: { productId: 'AQ-SEED-PRODUCT-DOES-NOT-EXIST', title: 'seed' },
  preview: {
    changes: { title: { from: 'Casco Integrale (SEED)', to: 'Casco Integrale Nero (SEED)' } },
    note: 'SEED — reversible master-content edit that points at nothing.',
  },
  status: 'pending',
  expiresAt: EXPIRES(),
})

// ── the two remaining states ────────────────────────────────────────────────

// (d) parked, counting down.
//
// ⚠ The first run of this script used a 20-second `executeAfter` — the real
// undo window — and the approval-maintenance sweep picked the row up within
// ~2 minutes and tried to COMMIT it. Nothing happened: `checkStaleness` ran
// the tool's own dry-run, the seed SKU resolves to nothing, and the row was
// refused and returned to `pending` carrying
// `reason: 'not run — productId and numeric price are required'`. That is the
// fail-closed guarantee in §1.2 working on a live row, and it is the reason
// this file's safety argument is built on unresolvable entities rather than on
// nobody noticing.
//
// It is still the wrong way to hold a state still for measurement, so the
// window is now ten minutes. The countdown will therefore read a number no
// operator ever sees (the real window is 20s) — that figure is a FIXTURE
// ARTEFACT, not a finding. What is being verified here is the parked
// treatment: the block, its wording, and the undo control.
await seed('(d) parked · counting down', 'pricing-watchdog', {
  toolName: 'set-price',
  riskTier: 'high',
  args: { sku: 'AQ-SEED-SKU-PARKED', priceEur: 59 },
  preview: {
    sku: 'AQ-SEED-SKU-PARKED',
    changes: { 'base price': { from: 69, to: 59 } },
    effect: 'Lowers the list price on one SKU.',
  },
  status: 'scheduled',
  executeAfter: new Date(Date.now() + 10 * 60 * 1000),
  decidedBy: 'awaissulhry',
  expiresAt: EXPIRES(),
})

// (e) came back from a FAILED execution — reachable only on these rows.
await seed('(e) came back · execution failed', 'listing-quality-keeper', {
  toolName: 'publish-listing',
  riskTier: 'high',
  args: { sku: 'AQ-SEED-SKU-PUBLISH' },
  preview: {
    sku: 'AQ-SEED-SKU-PUBLISH',
    marketplace: 'amazon.it',
    effect: 'Publishes one listing.',
  },
  status: 'pending',
  reason: 'execution failed: Amazon returned 429 (throttled) after 3 attempts',
  decidedBy: 'awaissulhry',
  expiresAt: EXPIRES(),
})

console.log('\nREMEMBER: npx tsx scripts/_apx-seed-outside.mts clean')
await prisma.$disconnect()
