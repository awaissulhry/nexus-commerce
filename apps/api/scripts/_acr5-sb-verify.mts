/**
 * ACR Stage 5 — does verifyLaunch now actually CHECK Sponsored Brands? READ-ONLY.
 *
 * Before this phase SB coverage stopped at CAMPAIGN, so every SB ad group and ad was counted
 * `uncovered` — verification was blind at exactly the entities the new builder creates. This
 * runs the real verifier over the 4 existing SB campaigns and prints the coverage split.
 *
 * The property that matters: `uncovered` should drop, and NO false MISSING_ON_AMAZON should
 * appear. Inventing failures is what gets a verifier switched off (AX-VT.4).
 *
 * Usage: cd apps/api && railway run npx tsx scripts/_acr5-sb-verify.mts
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })

const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient()
const { verifyLaunch } = await import('../src/services/advertising/ads-launch-verify.service.js')

const sb = await prisma.campaign.findMany({
  where: { adProduct: 'SPONSORED_BRANDS' }, select: { id: true, name: true, marketplace: true },
})
console.log(`\nVerifying ${sb.length} SB campaigns: ${sb.map(c => `${c.marketplace}/${c.name}`).join(', ')}\n`)

const v = await verifyLaunch(sb.map(c => c.id), 'RECONCILE')
console.log(`ok=${v.ok}  total=${v.total}  verified=${v.verified}  mismatch=${v.mismatch}  missingOnAmazon=${v.missingOnAmazon}  notPushed=${v.notPushed}  uncovered=${v.uncovered}`)

const byKind = new Map<string, { n: number; verdicts: Record<string, number> }>()
for (const e of v.entities) {
  const k = byKind.get(e.entityType) ?? { n: 0, verdicts: {} }
  k.n += 1; k.verdicts[e.verdict] = (k.verdicts[e.verdict] ?? 0) + 1
  byKind.set(e.entityType, k)
}
console.log('\nCHECKED BY KIND (an entity here is one the verifier could actually read back):')
for (const [kind, k] of byKind) console.log(`  ${kind.padEnd(12)} ${String(k.n).padStart(4)}  ${JSON.stringify(k.verdicts)}`)

if (v.problems.length) {
  console.log('\nPROBLEMS:')
  for (const p of v.problems.slice(0, 12)) console.log(`  ${p}`)
}
if (v.errors.length) {
  console.log('\nREAD ERRORS:')
  for (const e of v.errors) console.log(`  ${e}`)
}
console.log(`\nSAFETY — no invented failures: ${v.missingOnAmazon === 0 ? 'PASS (0 MISSING_ON_AMAZON)' : `REVIEW — ${v.missingOnAmazon} reported missing`}`)
await prisma.$disconnect(); process.exit(0)
