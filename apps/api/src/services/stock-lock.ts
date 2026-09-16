import type { Prisma } from '@prisma/client'

/**
 * AE.1 — the one lock every stock write takes FIRST.
 *
 * Every StockLevel writer reads the row, computes the next value in JavaScript and writes it
 * back. Without a lock two writers read the same value and one update is lost. Measured on a
 * real multi-connection PostgreSQL before this existed (stock-concurrency.vitest.test.ts):
 * 20 simultaneous sales on 20 units left 19 units; 25 buyers all reserved 20 units; one
 * reservation consumed twice took the stock twice; a bulk import overwrote a sale.
 *
 * Why the PRODUCT row and not an advisory lock or the StockLevel row:
 * - Every stock write already updates `Product.totalStock`, so it already took this row lock —
 *   only late, after reading stock. Taking the same lock at the start adds no new kind of lock
 *   and so no new deadlock cycle with code that edits a product and changes its stock in one
 *   transaction (the catalog PATCH routes lock the product row first, then move stock).
 * - One product can hold stock at several locations. The cascade reads all of them and writes
 *   every listing, so the unit that must not interleave is the product, not one level row.
 * - `FOR NO KEY UPDATE`, not `FOR UPDATE`: inserting a row that references the product (a
 *   movement, an event) takes `FOR KEY SHARE`, which `FOR UPDATE` would block.
 *
 * Several products are locked in ONE statement, ordered by id, so every caller acquires them
 * in the same order and two multi-product writers cannot deadlock each other.
 *
 * The lock is transaction-scoped: it is released at COMMIT or ROLLBACK. Hold it over database
 * work only — never over a network call.
 */
export async function lockProductStock(tx: Prisma.TransactionClient, productIds: Iterable<string>): Promise<void> {
  const ids = [...new Set(productIds)].filter((id): id is string => typeof id === 'string' && id.length > 0)
  if (ids.length === 0) return
  await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ANY(${ids}::text[]) ORDER BY id COLLATE "C" FOR NO KEY UPDATE`
}
