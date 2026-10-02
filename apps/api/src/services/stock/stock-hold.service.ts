/**
 * MCP full control 08 S6 — holds placed and released by a person (the stock page and Claude's reserve-stock). Moved
 * out of routes/stock.routes.ts (`POST /stock/reserve`, `/stock/release/:id`; stock-change.vitest.test.ts holds the
 * routes' answers):
 *   placeHold      refuses a product that sells from shared stock (a hold on own stock would hold nothing buyers see),
 *                  reserves through reserveStock, then re-advertises the product (AS.5).
 *   releaseHold    releases through releaseReservationFromStockPage, then re-advertises the freed units.
 * A hold changes `available` but runs no movement, so without the recascade following listings kept advertising the
 * held units until the next movement or the 30-minute drift heal.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { releaseReservationFromStockPage, reserveStock, type ReserveStockArgs } from '../stock-level.service.js'

/** A product that sells from shared stock: a hold on this business's own stock would hold nothing buyers see. */
export class PooledHoldRefusal extends Error {
  readonly code = 'pooled_product' as const
  constructor() {
    super('This product sells from shared stock. Its listings follow that stock, so a hold on your own stock would not hold anything buyers see. Holds for orders are made in the shared stock automatically.')
    this.name = 'PooledHoldRefusal'
  }
}

/** Re-advertise a product after a hold changed its available units. Fire-and-forget, as the routes did. */
function recascadeAfterHold(productId: string, reservationId: string, actor: string, what: string) {
  void (async () => {
    try {
      const { recascadeProduct } = await import('../stock-movement.service.js')
      await recascadeProduct(productId, { reason: 'MANUAL_ADJUSTMENT', referenceType: 'RESERVATION', referenceId: reservationId, actor })
    } catch (err) {
      logger.warn(`[stock/${what}] recascade failed (non-fatal)`, { error: err instanceof Error ? err.message : String(err) })
    }
  })()
}

export async function placeHold(input: ReserveStockArgs & { actor: string }) {
  const { pooledNow } = await import('../stock-pool/pool-guard.js')
  if ((await pooledNow(prisma, [input.productId])).has(input.productId)) throw new PooledHoldRefusal()
  const reservation = await reserveStock(input)
  recascadeAfterHold(input.productId, reservation.id, input.actor, 'reserve')
  return reservation
}

export async function releaseHold(reservationId: string, opts: { actor: string }) {
  const updated = await releaseReservationFromStockPage(reservationId, { actor: opts.actor })
  void (async () => {
    const sl = await prisma.stockLevel.findUnique({ where: { id: (updated as { stockLevelId: string }).stockLevelId }, select: { productId: true } }).catch(() => null)
    if (sl?.productId) recascadeAfterHold(sl.productId, reservationId, opts.actor, 'release')
  })()
  return updated
}
