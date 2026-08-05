/**
 * ACR Stage 5 — prove createCampaignLocal now routes SD/SB to their OWN endpoints. DRY RUN.
 *
 * Nothing is sent to Amazon and no local row is written. This exercises the real service
 * path — connection resolution, brandEntityId lookup, endpoint routing — and prints the exact
 * body that would go out. Before this change all three types printed `/sp/campaigns`.
 *
 * Usage: cd apps/api && npx tsx scripts/_acr5-create-dryrun.mts
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })

const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient()
const { createCampaignLocal } = await import('../src/services/advertising/ads-create.service.js')

const before = await prisma.campaign.count()

for (const [type, extra] of [
  ['SD', { sdTactic: 'T00020' as const }],
  ['SB', {}],
  ['SP', {}],
] as const) {
  console.log(`\n════════ type: ${type} ════════`)
  try {
    const r = await createCampaignLocal({
      name: `ACR5 dry-run ${type}`, type, marketplace: 'IT', dailyBudgetEur: 25, dryRun: true, ...extra,
    })
    const w = (r.dryRun as { wouldSend?: { method: string; path: string; body: unknown } })?.wouldSend
    if (!w) { console.log('  (no payload)', JSON.stringify(r.dryRun)); continue }
    console.log(`  → ${w.method} ${w.path}`)
    console.log('  ' + JSON.stringify(w.body, null, 2).split('\n').join('\n  '))
  } catch (e: any) {
    console.log(`  ✖ ${e.message}`)
  }
}

const after = await prisma.campaign.count()
console.log(`\nSAFETY — local campaign rows before=${before} after=${after} → ${before === after ? 'PASS (dry run wrote nothing)' : 'FAIL (a row leaked!)'}`)
await prisma.$disconnect(); process.exit(0)
