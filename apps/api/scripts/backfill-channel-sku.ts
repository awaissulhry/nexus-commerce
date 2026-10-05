/**
 * Per-listing channel SKU — copy each listing's own SKU from the old stores into ChannelListing.channelSku (and, for a
 * listing the channel holds, liveChannelSku). Plan docs/sheet-ids-sku-rows/PLAN.md, step S2; the rule is
 * `backfillChannelSkus` (src/services/listings/channel-sku-backfill.ts).
 *
 * DRY RUN BY DEFAULT: it reads and reports. `--apply` writes. Safe to run again: a column that has a value is never
 * overwritten, so a second run writes nothing. Listings whose old stores disagree are left empty and listed.
 * Every active business, one at a time; counts per business and channel. It never calls a channel.
 *
 * LOCAL ONLY: it refuses to start unless an exported DATABASE_URL names a loopback host and a development or test
 * database (the rule of src/lib/testing/database-target.ts). It never reads a .env file to find one.
 *
 *   cd apps/api && DATABASE_URL=postgresql://…@127.0.0.1:…/nexus_…test npx tsx scripts/backfill-channel-sku.ts [--apply]
 */
import { testDatabaseVerdict } from '../src/lib/testing/database-target.js'

const APPLY = process.argv.includes('--apply')

// Before anything imports src/env.ts (which loads .env files, the repo root's included): only an exported, local URL.
if (!process.env.DATABASE_URL?.trim()) {
  console.error('REFUSED: export DATABASE_URL (a loopback development or test database) before running this script. No .env file is read.')
  process.exit(1)
}
const verdict = testDatabaseVerdict(process.env.DATABASE_URL)
if (!verdict.allowed) {
  console.error(verdict.reason)
  process.exit(1)
}
console.log(`database: host "${verdict.host}", database "${verdict.database}" — ${APPLY ? 'APPLY (writes)' : 'dry run (no writes)'}`)

const { default: prisma } = await import('../src/db.js')
const { visitActiveWorkspaces } = await import('../src/lib/workspace-sweep.js')
const { backfillChannelSkus } = await import('../src/services/listings/channel-sku-backfill.js')

const SHOWN_PROBLEMS = 50
let problemsTotal = 0
let writes = 0

await visitActiveWorkspaces(async () => {
  const report = await backfillChannelSkus(prisma, { apply: APPLY })
  console.log(`\nBusiness ${report.workspaceId}`)
  const channels = Object.keys(report.byChannel).sort()
  if (!channels.length) console.log('  no listings')
  for (const channel of channels) {
    const c = report.byChannel[channel]
    writes += c.channelSkuSet + c.liveChannelSkuSet
    console.log(`  ${channel.padEnd(8)} listings ${c.listings} · follows product SKU ${c.followsProduct} · channelSku ${APPLY ? 'set' : 'to set'} ${c.channelSkuSet}`
      + ` · liveChannelSku ${APPLY ? 'set' : 'to set'} ${c.liveChannelSkuSet} · already set ${c.alreadySet} · conflicts ${c.conflicts}`
      + ` · alias without own SKU ${c.needsOwnSku}${c.changedMeanwhile ? ` · changed meanwhile ${c.changedMeanwhile}` : ''}`)
  }
  problemsTotal += report.problems.length
  for (const p of report.problems.slice(0, SHOWN_PROBLEMS)) {
    console.log(`  LEFT EMPTY ${p.channel} ${p.marketplace} ${p.productSku} (listing ${p.listingId}) ${p.code}: ${p.candidates.join(', ') || '—'}`)
  }
  if (report.problems.length > SHOWN_PROBLEMS) console.log(`  … and ${report.problems.length - SHOWN_PROBLEMS} more left empty`)
})

console.log(`\n${APPLY ? `Written: ${writes} column value(s).` : `Dry run: nothing was written (${writes} column value(s) would be). Run again with --apply to write.`}`
  + ` Left empty and listed: ${problemsTotal}.`)
await prisma.$disconnect()
