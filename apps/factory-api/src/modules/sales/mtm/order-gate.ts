import { DomainError } from '@nexus/factory-domain/core/errors'
import type { Reader } from './store'

/**
 * A made-to-measure unit's order waits for the factory review (B-W2b-358; SAL-292 "the factory confirms the measures or asks for
 * more before the order is confirmed"; B-W2b-297: the database does not require it, the API does):
 *
 *   mtmOrderPlan(db, lines)        orders/make.ts, BEFORE the order row: a made-to-measure line of a style no longer flagged
 *                                  made to measure is refused in words (409; the database's SalesOrderLine_mtm_style would
 *                                  answer 500), and `waits` when a unit's measures are not CONFIRMED: the order is made
 *                                  PENDING_APPROVAL (B-W2b-281: nothing moves into it later, it is inserted waiting)
 *   waitsForMeasures(db, orderId)  the yes of a SALES_ORDER request (orders-depth/approval.ts) and a credit override or a
 *                                  passing re-check (credit/override.ts): while true the order keeps waiting (the yes is kept)
 *   ordersAfterReview(tools, id)   (./orders.ts) the review's CONFIRM, in its command: every waiting order with a unit on that revision that
 *                                  now waits for nothing else goes on (CONFIRMED and W1's sales_order.status_changed, which
 *                                  B-W2b-294's handler follows to carry the delivery schedule): no other unit unconfirmed, no
 *                                  SALES_ORDER request pending, no credit HOLD standing, and no SALES_ORDER rule holding on it
 *                                  without an APPROVED request
 */

export interface MtmLine {
  readonly seq: number
  readonly kind: string
  readonly styleId: string
  readonly measurementProfileId: string | null
}

/** See the file's head: refuses an unflagged style in words; `waits` while a unit's measures are not confirmed. */
export async function mtmOrderPlan(db: Reader, lines: readonly MtmLine[]): Promise<{ waits: boolean }> {
  const units = lines.filter((line) => line.kind === 'MADE_TO_MEASURE' && line.measurementProfileId !== null)
  if (units.length === 0) return { waits: false }
  const styles = await db.style.findMany({ where: { id: { in: [...new Set(units.map((line) => line.styleId))] } }, select: { id: true, code: true, mtmAllowed: true } })
  const off = units.filter((line) => styles.find((style) => style.id === line.styleId)?.mtmAllowed !== true)
  if (off.length > 0) {
    const words = off.map((line) => `line ${line.seq} (${styles.find((style) => style.id === line.styleId)?.code ?? 'a style'})`)
    const message = `A made-to-measure unit's style is no longer made to measure: ${words.join(', ')}. A person flags the style again (PRD-017), or the unit leaves the quote.`
    throw new DomainError('conflict', message, off.map((line) => ({ path: `line-rule/MTM_NOT_STARTED/${line.seq}`, message })))
  }
  const profiles = await db.measurementProfile.findMany({ where: { id: { in: units.map((line) => line.measurementProfileId!) } }, select: { id: true, reviewStatus: true } })
  return { waits: profiles.some((profile) => profile.reviewStatus !== 'CONFIRMED') || profiles.length < new Set(units.map((line) => line.measurementProfileId)).size }
}

/** True while one of the order's made-to-measure units is made to measures the factory has not confirmed. */
export async function waitsForMeasures(db: Reader, orderId: string): Promise<boolean> {
  const lines = await db.salesOrderLine.findMany({ where: { orderId, kind: 'MADE_TO_MEASURE', measurementProfileId: { not: null } }, select: { measurementProfileId: true } })
  if (lines.length === 0) return false
  const confirmed = await db.measurementProfile.count({ where: { id: { in: [...new Set(lines.map((line) => line.measurementProfileId!))] }, reviewStatus: 'CONFIRMED' } })
  return confirmed < new Set(lines.map((line) => line.measurementProfileId)).size
}
