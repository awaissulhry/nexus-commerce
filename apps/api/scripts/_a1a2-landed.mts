/** Polls prod until the A1+A2 migrations land, or reports the stall. */
import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = (s: string) => p.$queryRawUnsafe<Record<string, unknown>[]>(s)

for (let i = 0; i < 40; i++) {
  try {
    const cols = await q(`
      SELECT
        (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_name='Campaign' AND column_name IN ('minBidCents','maxBidCents','targetAcosPct')) AS campaign_bounds,
        (SELECT COUNT(*) FROM information_schema.columns
           WHERE table_name='AdvertisingActionLog' AND column_name='evidence') AS evidence_col,
        (SELECT COUNT(*) FROM information_schema.tables
           WHERE table_name='AdKeywordProtection') AS protection_table`)
    const c = cols[0] as Record<string, unknown>
    const bounds = Number(c.campaign_bounds), ev = Number(c.evidence_col), tbl = Number(c.protection_table)
    if (bounds === 3 && ev === 1 && tbl === 1) {
      const applied = await q(`SELECT migration_name, finished_at::text, rolled_back_at::text
        FROM _prisma_migrations WHERE migration_name LIKE '%adx_a%' ORDER BY started_at`)
      console.log(`A1A2 LANDED · Campaign bounds=${bounds}/3 · evidence=${ev}/1 · AdKeywordProtection=${tbl}/1`)
      console.log('migrations: ' + JSON.stringify(applied, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)))
      await p.$disconnect(); process.exit(0)
    }
  } catch (e) { /* transient during deploy */ }
  await new Promise((r) => setTimeout(r, 20_000))
}
console.log('A1A2 TIMEOUT — migrations did not land in ~13 min; check for a migrate deploy stall')
await p.$disconnect()
