/**
 * MX.1 — `ChannelListing.salePriceStart` / `salePriceEnd` (D-MX4), read and written through narrow raw SQL, on purpose.
 *
 * The two columns are added by the additive migration `20260913_mx1_sale_price_window` and are live on the LOCAL
 * database; production is migrated only on the Owner's word. They are deliberately NOT declared in `schema.prisma`
 * yet — the same rule VP.2 wrote for `variationExcluded` (`family-projection.service.ts`): a database ahead of the
 * schema is inert, a schema ahead of a database is an outage (Prisma emits an explicit column list, so every
 * un-selected `channelListing` query would fail on a database without the column). These two helpers are the whole
 * cost of staying on the safe side; they fold into typed client calls once both databases carry the columns.
 *
 * Dates are DATE-precision ISO strings (`YYYY-MM-DD`) on the wire — Amazon's `discounted_price.schedule` takes
 * `format: date`, and the window is inclusive on both ends (the contract's `SaleCell`).
 */
import type { Prisma } from '@prisma/client'

type Raw = { $queryRawUnsafe: <T = unknown>(sql: string, ...values: unknown[]) => Promise<T>; $executeRawUnsafe: (sql: string, ...values: unknown[]) => Promise<number> }

export interface SaleWindow { start: string | null; end: string | null }

/** Accepts the `YYYY-MM-DD` string the query already shaped; anything else (a Date from another caller) is refused to null. */
const dateOnly = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null)

let columnsKnown: boolean | null = null

/** Does THIS database carry the two columns? Cached per process; a database without them answers `null` windows. */
export async function saleWindowColumnsExist(db: Raw): Promise<boolean> {
  if (columnsKnown !== null) return columnsKnown
  const rows = await db.$queryRawUnsafe<Array<{ n: number | bigint }>>(
    `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'ChannelListing' AND column_name IN ('salePriceStart', 'salePriceEnd')`,
  )
  columnsKnown = Number(rows[0]?.n ?? 0) === 2
  return columnsKnown
}

/** For tests: forget the cached answer. */
export function resetSaleWindowColumnCache(): void { columnsKnown = null }

/** One query for the whole family: listing id → window. Ids absent from the map carry no window. */
export async function readSaleWindows(db: Raw, listingIds: readonly string[]): Promise<Map<string, SaleWindow>> {
  const out = new Map<string, SaleWindow>()
  if (listingIds.length === 0 || !(await saleWindowColumnsExist(db))) return out
  /* `to_char`, never a JS Date: a DATE column read back as a Date lands at LOCAL midnight and `toISOString()` would
     shift it a day for any operator east of UTC. The column is a calendar day; it leaves the database as one. */
  const rows = await db.$queryRawUnsafe<Array<{ id: string; start: string | null; end: string | null }>>(
    `SELECT "id", to_char("salePriceStart", 'YYYY-MM-DD') AS "start", to_char("salePriceEnd", 'YYYY-MM-DD') AS "end" FROM "ChannelListing" WHERE "id" = ANY($1::text[])`,
    [...listingIds],
  )
  for (const r of rows) out.set(r.id, { start: dateOnly(r.start), end: dateOnly(r.end) })
  return out
}

/** Write one listing's window inside the caller's transaction. `null` clears. Throws when the database lacks the columns. */
export async function writeSaleWindow(tx: Pick<Prisma.TransactionClient, '$executeRawUnsafe'>, listingId: string, window: SaleWindow): Promise<void> {
  await tx.$executeRawUnsafe(
    `UPDATE "ChannelListing" SET "salePriceStart" = $2::date, "salePriceEnd" = $3::date WHERE "id" = $1`,
    listingId, window.start, window.end,
  )
}

/** A sale that Amazon can carry: a value needs BOTH dates (its schedule entry requires start_at AND end_at), end ≥ start. */
export function validateSaleWindow(value: number | null, window: SaleWindow): string | null {
  if (value == null) return null
  if (!Number.isFinite(value) || value < 0) return 'A sale price is zero or more'
  if (!window.start || !window.end) return 'A sale needs a start and an end date — Amazon schedules a sale with both'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(window.start) || !/^\d{4}-\d{2}-\d{2}$/.test(window.end)) return 'Sale dates are YYYY-MM-DD'
  if (window.end < window.start) return 'A sale ends on or after the day it starts'
  return null
}
