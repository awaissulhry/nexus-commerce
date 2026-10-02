/**
 * MCP full control — advertising's read statements on its own eBay listing index (`EbayListingIndex`), for the
 * identity audit and find-by-id (services/identity/), which may not read advertising's tables themselves
 * (scripts/check-context-boundary.mjs; that guard cannot see raw SQL, so the table name stays here).
 *
 * Each function returns one SQL statement, not rows: the identity side composes it unchanged into its own
 * keyset-paged runner (audit) or UNION ALL (find-by-id). Both statements are scoped to one business by `ws`.
 */
import { Prisma } from '@prisma/client'

const sql = Prisma.sql

/**
 * Index rows (still live on eBay) that name at least one product which no longer exists or is in the bin.
 * Columns: key, sku, product_id, listing_id, channel, market, facts — the identity audit's check row shape.
 */
export function ebayIndexGoneProductsSql(ws: string): Prisma.Sql {
  return sql`
    SELECT e.marketplace || ' ' || e."itemId" AS key, NULL::text AS sku, NULL::text AS product_id, NULL::text AS listing_id,
      'EBAY'::text AS channel, e.marketplace AS market,
      jsonb_build_object('itemId', e."itemId", 'goneProductIds', g.ids, 'matchStatus', e."matchStatus") AS facts
    FROM "EbayListingIndex" e
    CROSS JOIN LATERAL (
      SELECT array_agg(x ORDER BY x) AS ids FROM unnest(e."productIds") AS x
      WHERE NOT EXISTS (SELECT 1 FROM "Product" gp WHERE gp.id = x AND gp."deletedAt" IS NULL)
    ) g
    WHERE e."workspaceId" = ${ws} AND e."endedAt" IS NULL AND g.ids IS NOT NULL`
}

/**
 * Index rows for one eBay Item ID, with the first live product they name (by SKU).
 * Columns: product_id, listing_id, channel, market, account_id, value — find-by-id's match row shape.
 */
export function ebayIndexItemMatchSql(ws: string, itemId: string): Prisma.Sql {
  return sql`SELECT (SELECT ip.id FROM unnest(e."productIds") AS x JOIN "Product" ip ON ip.id = x AND ip."deletedAt" IS NULL ORDER BY ip.sku LIMIT 1) AS product_id,
          NULL::text AS listing_id, 'EBAY'::text AS channel, e.marketplace AS market, NULL::text AS account_id,
          e."itemId" || ' (' || e."matchStatus" || CASE WHEN e."endedAt" IS NOT NULL THEN ', ended' ELSE '' END || ')' AS value
        FROM "EbayListingIndex" e WHERE e."workspaceId" = ${ws} AND e."itemId" = ${itemId}`
}
