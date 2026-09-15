import { Prisma } from '@prisma/client'

/** Customer purchase time; legacy orders without it retain their recorded creation time. */
export const orderInSalesWindow = (since: Date, until: Date): Prisma.Sql => Prisma.sql`
  COALESCE(o."purchaseDate", o."createdAt") >= ${since}
  AND COALESCE(o."purchaseDate", o."createdAt") <= ${until}
  AND o.status <> 'CANCELLED'`

/** The same family measure for cells, sorting and groups. Deleted variants retain sales history.
 * A non-EUR order makes the euro total unknown, never a silently mislabelled currency sum. */
export const salesRollupCte = (ids: readonly string[], since: Date, until: Date): Prisma.Sql => Prisma.sql`
  salesq AS (
    SELECT own.id,
      CASE WHEN COUNT(*) FILTER (WHERE o.id IS NOT NULL AND COALESCE(o."currencyCode", 'EUR') <> 'EUR') > 0
        THEN NULL ELSE COALESCE(ROUND(SUM(CASE WHEN o.id IS NULL THEN 0 ELSE oi.quantity * oi.price END) * 100), 0)
      END AS "revenueCents",
      COALESCE(SUM(CASE WHEN o.id IS NULL THEN 0 ELSE oi.quantity END), 0) AS units
    FROM unnest(${[...ids]}::text[]) AS own(id)
    LEFT JOIN "Product" c ON c.id = own.id OR c."parentId" = own.id
    LEFT JOIN "OrderItem" oi ON oi."productId" = c.id
    LEFT JOIN "Order" o ON o.id = oi."orderId" AND ${orderInSalesWindow(since, until)}
    GROUP BY own.id
  )`
