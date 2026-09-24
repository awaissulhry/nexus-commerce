import { PrismaClient } from '@prisma/client'
import { MARKET_CATALOGUE, marketCatalogueRows } from '../../../apps/api/src/services/pim/market-catalogue.js'

const prisma = new PrismaClient()

/**
 * The seed list is the ONE market catalogue (A-53): `apps/api/src/services/pim/market-catalogue.ts`, the
 * 20 reference rows (identity, currency, languages, VAT) that business creation, `POST /marketplaces/seed`
 * and the backfill migration also write. This file used to keep its own 17-row copy (no BE, IE, TR).
 *
 * Re-EXPORTED as `MARKETPLACES` because the 15.11 scale fixture (`apps/api/src/scripts/seed-scale-fixture.ts`)
 * reads it from here. Imported first, then exported: a bare `export { x } from` binds nothing locally, and
 * `main()` below reads it.
 */
export const MARKETPLACES = MARKET_CATALOGUE

// CREATE-ONLY, like every catalogue writer: a market row that exists is never rewritten. `workspaceId` comes
// from the connection's business context (`nexus.workspace_id`), as for every Marketplace insert.
async function main() {
  const { count } = await prisma.marketplace.createMany({ data: marketCatalogueRows(), skipDuplicates: true })
  console.log(`Seeded ${count} of ${MARKETPLACES.length} catalogue marketplaces (the rest existed)`)
}

// 🔴 Only when RUN, never when imported. `MARKETPLACES` above is now read by the 15.11 scale
// fixture; an unguarded `main()` made that import seed a database as a side effect, and the
// failure arrived later as an unhandled rejection that killed the importing process mid-write.
const runDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (runDirectly) {
  main()
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
    .finally(() => prisma.$disconnect())
}
