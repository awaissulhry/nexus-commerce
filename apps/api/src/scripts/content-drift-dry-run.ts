/**
 * PLAN A-39 (R-41) — Step 3.5b's Amazon content read, DRY RUN ONLY: how many Amazon listings are due for a content
 * check in one business (never checked by `amazon-content`, or checked more than 20 h ago). Reads nothing from Amazon
 * and writes nothing — the nightly cron is the only writer.
 *
 *   node docs/product-cheat/tools/prod-run.mjs content-drift [--local] [--workspace <id>]
 */
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import prisma from '../db.js'
import { runContentDrift } from '../jobs/content-drift.job.js'
import { describeSweep } from '../services/pim/resumable-sweep.js'

const argv = process.argv.slice(2)
const flag = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
if (argv.includes('--apply')) { console.error('[content-drift] REFUSE: this script is a dry run only; the nightly cron is the only writer.'); process.exit(2) }
const WORKSPACE = flag('workspace') ?? LEGACY_WORKSPACE_ID

async function main() {
  const [{ d: database }] = (await prisma.$queryRawUnsafe(`select current_database()::text as d`)) as Array<{ d: string }>
  console.log(`[content-drift] database ${database} · business ${WORKSPACE} · DRY RUN — nothing read from Amazon, nothing written`)
  await withWorkspace({ workspaceId: WORKSPACE, actorUserId: null, membershipId: null, roleKeys: [] }, async () => {
    const amazon = await prisma.channelListing.count({ where: { channel: 'AMAZON', externalListingId: { not: null }, channelConnectionId: { not: null }, listingStatus: { in: ['ACTIVE', 'INACTIVE'] }, product: { deletedAt: null } } })
    const report = await runContentDrift({ dryRun: true })
    console.log(`[content-drift] ${describeSweep(report)}`)
    console.log(`[content-drift] Amazon listings in scope: ${amazon} · due now: ${report.planned}`)
  })
  process.exit(0)
}

main().catch((error) => { console.error(error); process.exit(1) })
