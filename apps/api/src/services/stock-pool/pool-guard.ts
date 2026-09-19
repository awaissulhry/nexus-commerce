import type { Prisma } from '@prisma/client'
import type prisma from '../../db.js'
import { poolLevels } from './pool-doors.js'

/**
 * Shared stock plan step 4 — the guard under the own-ledger primitives (applyStockMovementInTx,
 * reserveStockInTx). Order code routes a pooled product's sales and holds to the doors
 * (order-routing.ts); this refuses the ones that reach this business's own ledger anyway — a path
 * nobody routed — so a pooled product's sale can never quietly come out of stock no listing shows.
 * Imports only the door wrappers, so the primitives can use it without an import cycle.
 */

type Db = Prisma.TransactionClient | typeof prisma

/** Products that sell from a pool right now (the doors' own predicate: nexus_pool_effective_link). */
export async function pooledNow(db: Db, productIds: string[]): Promise<Set<string>> {
  return new Set((await poolLevels(db, productIds)).keys())
}

/** Thrown by the own-ledger primitives when an order-driven write would bypass a product's pool. */
/**
 * A hold a pool door wrote in the LENDER's ledger for a borrower's order ends only through that order:
 * shipped, cancelled, or the borrower's repair job (doors 3 and 4a). Released here, the borrower's order
 * would still count on units no longer held for it.
 */
export class PoolHoldError extends Error {
  readonly code = 'pool_hold'
  readonly statusCode = 409
  constructor(readonly reservationId: string) {
    super('These units are held for an order of a business you lend stock to. They are released when that order ships or is cancelled there.')
    this.name = 'PoolHoldError'
  }
}

export class PooledProductError extends Error {
  readonly code = 'pooled_product'
  readonly statusCode = 409
  constructor(readonly productId: string, what: string) {
    super(`This product sells from shared stock; ${what} must go through the shared stock doors, not this business's own stock (product ${productId}).`)
    this.name = 'PooledProductError'
  }
}
