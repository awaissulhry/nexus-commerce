import prisma from '../../db.js'
import { Prisma } from '@prisma/client'

/**
 * Shared stock — the five safe doors (plan docs/2026-09-19-shared-stock-plan.md §6, contract
 * docs/2026-09-19-shared-stock-build.md §1).
 *
 * Each door is a SECURITY DEFINER function in packages/database/workspaces/stock-pool.sql. It runs
 * in the BORROWER's business context and takes no lender, lender product, location or grant from
 * the caller: all of them come from the borrower's own product link. These wrappers only type the
 * calls; every rule lives in the database.
 *
 * A door refuses with `{ error, code, status }` (a sentence for a person and a stable code). The
 * wrappers return that as `{ ok: false, refusal }` — a refusal is an answer, not an exception.
 */

type Db = Prisma.TransactionClient | typeof prisma

export interface PoolRefusal {
  error: string
  code: string
  status: number
  [detail: string]: unknown
}

export type PoolResult<T> = ({ ok: true } & T) | { ok: false; refusal: PoolRefusal }

/** The refusal of a door's answer, or null when it succeeded. (apps/api compiles without `strict`, so a
 *  check on `ok` does not narrow the union; this does.) */
export function refusalOf<T>(r: PoolResult<T>): PoolRefusal | null {
  return r.ok ? null : (r as { refusal: PoolRefusal }).refusal
}

/** One lent location's numbers for a borrower product that sells from a pool right now. */
export interface PoolLevel {
  grantId: string
  ownerWorkspaceId: string
  locationId: string
  /** The lender's location code; null when the location no longer exists. */
  locationCode: string | null
  quantity: number
  reserved: number
  available: number
}

async function door(db: Db, sql: Prisma.Sql): Promise<Record<string, unknown>> {
  const rows = await db.$queryRaw<Array<{ result: Record<string, unknown> }>>(sql)
  const result = rows[0]?.result
  if (!result || typeof result !== 'object') throw new Error('A shared stock door returned nothing.')
  return result
}

function answer<T>(result: Record<string, unknown>): PoolResult<T> {
  if (typeof result.error === 'string') return { ok: false, refusal: result as unknown as PoolRefusal }
  return { ok: true, ...(result as T) }
}

/**
 * Door 1 — CHECK. For each given product of the current business that sells from a pool right now,
 * its lent locations and their numbers. A product missing from the map uses its own stock.
 */
export async function poolLevels(db: Db, productIds: string[]): Promise<Map<string, PoolLevel[]>> {
  const out = new Map<string, PoolLevel[]>()
  const ids = [...new Set(productIds.filter((id) => typeof id === 'string' && id.length > 0))]
  if (ids.length === 0) return out
  const rows = await db.$queryRaw<Array<{
    product_id: string; grant_id: string; owner_workspace_id: string; location_id: string
    location_code: string | null; quantity: number; reserved: number; available: number
  }>>`SELECT * FROM nexus_pool_available(${ids}::text[])`
  for (const row of rows) {
    const list = out.get(row.product_id) ?? []
    list.push({
      grantId: row.grant_id,
      ownerWorkspaceId: row.owner_workspace_id,
      locationId: row.location_id,
      locationCode: row.location_code,
      quantity: Number(row.quantity),
      reserved: Number(row.reserved),
      available: Number(row.available),
    })
    out.set(row.product_id, list)
  }
  return out
}

export interface PoolHold {
  reservationId: string
  quantity: number
  /** open | released | consumed — a reused hold keeps whatever state it reached. */
  state: 'open' | 'released' | 'consumed'
  reused: boolean
  locationCode?: string
  availableAfter?: number
  grantId?: string
}

/** Door 2 — HOLD. One hold per borrower order and product, ever; a second call returns the first. */
export async function poolReserve(db: Db, args: { productId: string; quantity: number; orderRef: string; actor?: string | null }): Promise<PoolResult<PoolHold>> {
  return answer(await door(db, Prisma.sql`SELECT nexus_pool_reserve(${args.productId}, ${args.quantity}::integer, ${args.orderRef}, ${args.actor ?? null}::text) AS result`))
}

/** Door 3 — GIVE BACK the open holds of one borrower order (every product, or one). */
export async function poolRelease(db: Db, args: { orderRef: string; productId?: string | null; actor?: string | null; reason?: string | null }): Promise<PoolResult<{ released: number; units: number }>> {
  return answer(await door(db, Prisma.sql`SELECT nexus_pool_release(${args.orderRef}, ${args.productId ?? null}::text, ${args.actor ?? null}::text, ${args.reason ?? null}::text) AS result`))
}

/** Door 4a — TAKE OUT the open holds of one borrower order (it shipped). */
export async function poolConsume(db: Db, args: { orderRef: string; productId?: string | null; actor?: string | null }): Promise<PoolResult<{ consumed: number; units: number }>> {
  return answer(await door(db, Prisma.sql`SELECT nexus_pool_consume(${args.orderRef}, ${args.productId ?? null}::text, ${args.actor ?? null}::text) AS result`))
}

/** Door 4b — TAKE OUT at once, for a sale with no hold. All or nothing; one take per order and product. */
export async function poolTake(db: Db, args: { productId: string; quantity: number; orderRef: string; actor?: string | null }): Promise<PoolResult<{ taken: number; reused: boolean; movements?: Array<{ movementId: string; units: number }>; grantId?: string }>> {
  return answer(await door(db, Prisma.sql`SELECT nexus_pool_take(${args.productId}, ${args.quantity}::integer, ${args.orderRef}, ${args.actor ?? null}::text) AS result`))
}

/** Door 5 — PUT BACK units an order took out: a cancelled sale or a return put back on the shelf. */
export async function poolPutBack(db: Db, args: {
  productId: string
  quantity: number
  orderRef: string
  /** The order for a cancellation, the return for a return. One put-back per reason and ref. */
  putBackRef: string
  reason: 'ORDER_CANCELLED' | 'RETURN_RESTOCKED'
  actor?: string | null
}): Promise<PoolResult<{ movementId: string; reused: boolean; units?: number }>> {
  return answer(await door(db, Prisma.sql`SELECT nexus_pool_put_back(${args.productId}, ${args.quantity}::integer, ${args.orderRef}, ${args.putBackRef}, ${args.reason}, ${args.actor ?? null}::text) AS result`))
}

/** For the repair job: this business's orders that still have an open hold in a pool, oldest first. */
export async function poolOpenHoldOrders(db: Db, maxOrders: number): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ order_ref: string }>>`SELECT order_ref FROM nexus_pool_open_hold_orders(${maxOrders}::integer)`
  return rows.map((r) => r.order_ref)
}
