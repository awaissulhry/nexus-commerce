/**
 * ADX G5 — make the per-campaign live-write allowlist mean something.
 *
 * The gate calls it "default-deny", but all 216 campaigns are allowlisted, so it has
 * been containing nothing. Evidence over 90 days: 134 campaigns (133 PAUSED, 1
 * ARCHIVED) have received ZERO writes, hold no schedule, and are not serving.
 *
 * Denying them changes nothing operationally and makes the property real.
 * Reversible: one boolean. Dry-run unless --apply.
 */
import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const APPLY = process.argv.includes('--apply')

const candidates = await p.campaign.findMany({
  where: { liveBidWritesEnabled: true, status: { in: ['PAUSED', 'ARCHIVED'] } },
  select: { id: true, name: true, status: true, marketplace: true },
  orderBy: { name: 'asc' },
})

// Never deny a campaign that still holds an enabled schedule, whatever its status —
// a schedule is an explicit statement that something is meant to manage it.
const scheduled = new Set(
  (await p.adSchedule.findMany({ where: { enabled: true }, select: { campaignId: true } })).map((s) => s.campaignId),
)
const toDeny = candidates.filter((c) => !scheduled.has(c.id))
const skipped = candidates.filter((c) => scheduled.has(c.id))

console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'}`)
console.log(`  allowlisted today : ${await p.campaign.count({ where: { liveBidWritesEnabled: true } })}`)
console.log(`  would deny        : ${toDeny.length}  (PAUSED/ARCHIVED, no enabled schedule)`)
console.log(`  kept (scheduled)  : ${skipped.length}`)
console.log(`  remaining allowed : ${(await p.campaign.count({ where: { liveBidWritesEnabled: true } })) - toDeny.length}`)
for (const c of toDeny.slice(0, 8)) console.log(`    · [${c.status}] ${c.marketplace ?? '—'} ${c.name.slice(0, 64)}`)
if (toDeny.length > 8) console.log(`    …and ${toDeny.length - 8} more`)

if (APPLY && toDeny.length) {
  await p.campaign.updateMany({ where: { id: { in: toDeny.map((c) => c.id) } }, data: { liveBidWritesEnabled: false } })
  console.log(`\n✅ denied ${toDeny.length} campaigns.`)
  console.log(`REVERSAL: UPDATE "Campaign" SET "liveBidWritesEnabled"=true WHERE id IN (${toDeny.map((c) => `'${c.id}'`).join(',')});`)
}
await p.$disconnect()
