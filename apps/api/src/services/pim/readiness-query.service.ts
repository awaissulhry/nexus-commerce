/**
 * P7 (docs/attributes/PLAN.md §4.6, §10.8) — "which products miss a required field HERE" as ONE query on the stored
 * readiness index, never a rebuild.
 *
 * A coordinate is `channel × market × account × language` (the index's own key); `channel: null, market: null` is the
 * shared product. The answer comes from `ReadinessIndex.missing[]`: an entry flagged `requiredEmpty` (A-45), optionally
 * narrowed to one field and to one source (`requiredBy`, P7 — e.g. `"Amazon · IT"` or `"Family: Jackets"`).
 *
 * Honest about what it cannot see:
 *   · `pendingProductIds` — a bulk edit changed these products and their rebuild has not run yet (P2), so their
 *     verdict is the PREVIOUS one: show "checking…", never "missing" or "complete" as current;
 *   · `checkedProducts` — products that HAVE a row at this coordinate. A product with none was never checked there,
 *     which is not the same as "nothing missing" (R-LX-9).
 */
import { Prisma } from '@prisma/client'
import prisma from '../../db.js'

export interface MissingRequiredFilter {
  channel: string | null
  market: string | null
  /** Omit for every account of the channel; `null` for rows with no account. */
  accountId?: string | null
  language?: string | null
  /** One field key (`fit`, `productType`, …). */
  field?: string | null
  /** One source, exactly as stored in `requiredBy` (`"Amazon · IT"`, `"Family: Jackets"`, `"Shared product"`). */
  requiredBy?: string | null
  /** Page size, 1–1,000. Default 200. */
  take?: number
  /** The last `productId` of the previous page. */
  after?: string | null
}

export interface MissingRequiredPage {
  productIds: string[]
  /** Among `productIds`: the ones whose row at this coordinate is pending a rebuild (previous verdict). */
  pendingProductIds: string[]
  /** Products with at least one row at this coordinate (checked there at least once). */
  checkedProducts: number
  /** Among `checkedProducts`: the ones with a row pending a rebuild — their verdict here may change either way. */
  pendingProducts: number
  nextCursor: string | null
}

export const MISSING_REQUIRED_MAX_TAKE = 1000

/** An equality that PostgreSQL can serve from `(channel, market, language, state)`: `IS NOT DISTINCT FROM` cannot. */
const matches = (column: Prisma.Sql, value: string | null) => value === null ? Prisma.sql`${column} IS NULL` : Prisma.sql`${column} = ${value}`

export async function productsMissingRequired(filter: MissingRequiredFilter): Promise<MissingRequiredPage> {
  const take = Math.min(Math.max(Math.trunc(filter.take ?? 200), 1), MISSING_REQUIRED_MAX_TAKE)
  const coordinate = Prisma.join([
    matches(Prisma.sql`r.channel`, filter.channel),
    matches(Prisma.sql`r.market`, filter.market),
    ...(filter.accountId !== undefined ? [matches(Prisma.sql`r."accountId"`, filter.accountId)] : []),
    ...(filter.language ? [Prisma.sql`r.language = ${filter.language}`] : []),
    Prisma.sql`p."deletedAt" IS NULL`,
  ], ' AND ')
  // One element of `missing[]` must hold every key given: flagged required-and-empty, and the field / source asked for.
  const pattern = JSON.stringify([{ requiredEmpty: true, ...(filter.field ? { field: filter.field } : {}), ...(filter.requiredBy ? { requiredBy: [filter.requiredBy] } : {}) }])
  const [rows, [checked]] = await Promise.all([
    prisma.$queryRaw<Array<{ productId: string; pending: boolean }>>`
      SELECT r."productId", bool_or(r."pendingSince" IS NOT NULL) AS pending
      FROM "ReadinessIndex" r JOIN "Product" p ON p.id = r."productId"
      WHERE ${coordinate} AND r.missing @> ${pattern}::jsonb
        ${filter.after ? Prisma.sql`AND r."productId" > ${filter.after}` : Prisma.empty}
      GROUP BY r."productId" ORDER BY r."productId" LIMIT ${take + 1}`,
    prisma.$queryRaw<Array<{ n: number; pending: number }>>`
      SELECT count(DISTINCT r."productId")::int AS n,
             count(DISTINCT r."productId") FILTER (WHERE r."pendingSince" IS NOT NULL)::int AS pending
      FROM "ReadinessIndex" r JOIN "Product" p ON p.id = r."productId"
      WHERE ${coordinate}`,
  ])
  const page = rows.slice(0, take)
  return {
    productIds: page.map(row => row.productId),
    pendingProductIds: page.filter(row => row.pending).map(row => row.productId),
    checkedProducts: Number(checked?.n ?? 0),
    pendingProducts: Number(checked?.pending ?? 0),
    nextCursor: rows.length > take ? page[page.length - 1].productId : null,
  }
}
