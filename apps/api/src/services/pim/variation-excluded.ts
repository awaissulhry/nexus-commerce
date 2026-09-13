/**
 * VT.1 — the ONE reader/writer of `ChannelListing.variationExcluded`, extracted to a LEAF.
 *
 * It lived in `family-projection.service.ts`, which imports `studio-sheet.service.ts` (for `readAxisValues` and
 * `UnknownProductError`). So when the sheet needed the exclusion set for the variation theme cell's collision count,
 * importing it from there closed a CYCLE — and a cycle does not fail loudly: it hands the importer a
 * partially-initialised module. Measured 2026-09-13: `studio-sheet-axis.vitest.test.ts` went from 18/18 passing to
 * 14 failures reporting `Cannot read properties of undefined (reading 'findMany')` at frames in code VT.1 never
 * touched — the classic mis-attributing symptom of a half-built module.
 *
 * This file imports prisma and NOTHING else, so both sides can read it.
 */

import prisma from '../../db.js'

/**
 * `variationExcluded` is read and written through narrow raw SQL on purpose: the column is **not in the Prisma
 * schema at all** — it exists in real databases because a migration added it, and `prisma.channelListing` therefore
 * cannot select it.
 *
 * 🔴 That has a consequence VT.1 measured the hard way. A database built from the Prisma schema alone (the
 * "real disposable PostgreSQL" that `content-write.vitest.test.ts` creates) does NOT have the column, so the query
 * fails with `42703 column does not exist`. A failed statement inside a caller's transaction ABORTS it —
 * `25P02 current transaction is aborted, commands ignored until end of transaction block` — and every later
 * statement in that transaction fails too. Measured: ONE unguarded read of this column turned into **12** failing
 * tests reporting an error on `readinessIndex.deleteMany`, a line nothing to do with variations. A try/catch around
 * the read does NOT help: by the time JavaScript sees the error, the transaction is already poisoned.
 *
 * So the column's PRESENCE is checked first, against `information_schema` — a catalogue read that cannot fail and
 * therefore cannot poison anything — and the answer is memoised per process. `hasColumn === false` means the
 * exclusion set is UNKNOWN, and the caller must report "not computed" rather than "nothing excluded".
 */
let columnPresent: boolean | null = null

export async function variationExcludedColumnExists(): Promise<boolean> {
  if (columnPresent !== null) return columnPresent
  const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*)::bigint AS n FROM information_schema.columns
     WHERE table_name = 'ChannelListing' AND column_name = 'variationExcluded'`,
  )
  columnPresent = Number(rows[0]?.n ?? 0) > 0
  return columnPresent
}

/** Test seam: forget the memoised answer (a disposable database is created per suite). */
export function resetVariationExcludedProbe(): void { columnPresent = null }

export async function readExcludedListingIds(listingIds: string[]): Promise<Set<string>> {
  if (listingIds.length === 0) return new Set()
  if (!(await variationExcludedColumnExists())) {
    throw new Error('ChannelListing.variationExcluded does not exist on this database, so exclusions cannot be read.')
  }
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    'SELECT "id" FROM "ChannelListing" WHERE "variationExcluded" = true AND "id" = ANY($1::text[])',
    listingIds,
  )
  return new Set(rows.map((r) => r.id))
}
