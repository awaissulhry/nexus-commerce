/**
 * ACR Stage 5 — SD ad-group + target reconcile harness. READ-ONLY unless APPLY=1.
 * Amazon → local only. Never writes to Amazon.
 *
 *   dry run:  cd apps/api && railway run npx tsx scripts/_acr5-sd-reconcile.mts
 *   apply:    cd apps/api && APPLY=1 railway run npx tsx scripts/_acr5-sd-reconcile.mts
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })
const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient()
const { reconcileSdEntities } = await import('../src/services/advertising/ads-family-reconcile.service.js')

const apply = process.env.APPLY === '1'
console.log(`\n${apply ? '⚠️  APPLYING (Amazon → local)' : 'DRY RUN — nothing will be written'}\n`)

const snap = async () => ({
  t: await prisma.adTarget.groupBy({ by: ['status'], where: { adGroup: { campaign: { adProduct: 'SPONSORED_DISPLAY' } }, isNegative: false }, _count: { _all: true } }),
  g: await prisma.adGroup.groupBy({ by: ['status'], where: { campaign: { adProduct: 'SPONSORED_DISPLAY' } }, _count: { _all: true } }),
})
const fmt = (rows: any[]) => rows.map(r => `${r.status}=${r._count._all}`).join(' ')

const before = await snap()
console.log(`BEFORE  targets: ${fmt(before.t)}   adGroups: ${fmt(before.g)}`)

const r = await reconcileSdEntities({ apply })
console.log(`\nad groups: checked=${r.adGroups.checked} drift=${r.adGroups.drift} updated=${r.adGroups.updated}`)
console.log(`targets:   checked=${r.targets.checked} drift=${r.targets.drift} updated=${r.targets.updated}`)
if (r.samples.length) { console.log('\nsamples:'); r.samples.forEach(s => console.log(`  ${s}`)) }
if (r.errors.length) { console.log('\nERRORS:'); r.errors.forEach(e => console.log(`  ${e}`)) }

const after = await snap()
console.log(`\nAFTER   targets: ${fmt(after.t)}   adGroups: ${fmt(after.g)}`)
if (!apply) console.log('SAFETY — dry run: BEFORE and AFTER must be identical.')
await prisma.$disconnect(); process.exit(0)
