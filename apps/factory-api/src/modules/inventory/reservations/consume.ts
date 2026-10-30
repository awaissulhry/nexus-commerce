import { consumption, giveBack, issueConflict, type HeldReservation, type ReservationChange } from '@nexus/factory-domain/inventory/reservations/rules'
import type { CommandTools } from '../../../core/command'
import { stockContextOf } from '../ledger/access'
import { decimalOf, demandWords, lockReservations, orderLinesOf, readKeyFacts, RESERVATION_COLUMNS, type KeyFacts, type ReservationRow } from './store'

/**
 * Issues and reservations (B-W2a-11; SCM-205, SCM-209): what modules/inventory/issue calls inside its commands, office
 * and floor alike. Before the moves (`reservedForIssue`): the reserve lock of the item and colour, then a refusal in
 * words when the stock is held for another work order or order line (a hide another one holds; more than the others
 * leave free, for the item and colour or the lot). After the moves (`consume`): the issue counts against the work order's
 * own ACTIVE reservations — the hide's own, then those of its lot, then those of any lot — raising issuedQuantity, and
 * ISSUED (issuedAt) once all of one is issued. The work order's own reservations are those made for it, and those made
 * for an order line it makes (its cells' lines) before it existed. The undo or reversal of an issue gives its quantity
 * back to those still ACTIVE (`giveBackIssue`; ISSUED is final). A floor session writes only what the
 * …_stock_plan_w2a_guards trigger lets it: issuedQuantity, ACTIVE → ISSUED, issuedAt.
 */

export interface IssueStock {
  readonly workOrder: { readonly id: string; readonly siteId: string; readonly companyId: string; readonly number: string }
  readonly itemId: string
  readonly itemColourId: string | null
  readonly label: string
  readonly baseUom: string
  readonly lot: { readonly id: string; readonly code: string } | null
  readonly hide: { readonly id: string; readonly code: string } | null
}

export class ReservedForOtherError extends Error {
  override name = 'ReservedForOtherError'
  constructor(readonly words: string) {
    super(words)
  }
}

const contextOf = (tools: Pick<CommandTools, 'context'>) => stockContextOf({ factoryContext: tools.context, withClient: () => Promise.reject(new Error('inside a command')) })

async function factsFor(tools: CommandTools, stock: IssueStock): Promise<{ facts: KeyFacts; mine: (reservation: HeldReservation) => boolean }> {
  const context = contextOf(tools)
  const key = { siteId: stock.workOrder.siteId, itemId: stock.itemId, itemColourId: stock.itemColourId }
  await lockReservations(tools.tx, context.tenantId, [key])
  const facts = await readKeyFacts(tools.tx, key, { withOrders: context.audience !== 'floor' })
  const lines = facts.rows.some((row) => row.salesOrderLineId) ? await orderLinesOf(tools.tx, stock.workOrder.id) : new Set<string>()
  const mine = (reservation: HeldReservation) => reservation.workOrderId === stock.workOrder.id || (reservation.salesOrderLineId !== null && lines.has(reservation.salesOrderLineId))
  return { facts, mine }
}

/** Writes the changes (issued more, or given back) on the reservations, with their audit rows. */
async function apply(tools: CommandTools, facts: KeyFacts, changes: readonly ReservationChange[], why: { readonly action: string; readonly moveIds: readonly string[] }): Promise<void> {
  const byId = new Map<string, ReservationRow>(facts.rows.map((row) => [row.id, row]))
  for (const change of changes) {
    const row = byId.get(change.id)!
    const updated = await tools.tx.reservation.update({
      where: { id: row.id },
      data: { issuedQuantity: change.issuedQuantity, ...(change.issued ? { status: 'ISSUED', issuedAt: tools.now } : {}), version: { increment: 1 } },
      select: RESERVATION_COLUMNS,
    })
    tools.audit({
      action: why.action,
      recordType: 'Reservation',
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      before: { status: row.status, issuedQuantity: row.issuedQuantity.toFixed(4) },
      after: { status: updated.status, issuedQuantity: updated.issuedQuantity.toFixed(4), moveIds: why.moveIds },
    })
  }
}

/**
 * Before an issue's moves: the reserve lock, and a ReservedForOtherError when the stock is held for another demand. Returns
 * what counts the issue against the work order's own reservations once its moves are posted.
 */
export async function reservedForIssue(tools: CommandTools, stock: IssueStock, baseQuantity: string): Promise<{ consume(moveIds: readonly string[], issued: string): Promise<void> }> {
  const { facts, mine } = await factsFor(tools, stock)
  const words = {
    label: stock.label,
    baseUom: stock.baseUom,
    lotCode: stock.lot?.code ?? null,
    hideCode: stock.hide?.code ?? null,
    holderOf: (reservation: HeldReservation) => demandWords(facts.rows.find((row) => row.id === reservation.id)!, facts.demands),
  }
  const conflict = issueConflict(facts.stock, facts.reservations, mine, { lotId: stock.lot?.id ?? null, hideId: stock.hide?.id ?? null, baseQuantity }, words)
  if (conflict) throw new ReservedForOtherError(conflict)
  return {
    async consume(moveIds, issued) {
      const own = facts.reservations.filter(mine)
      if (own.length === 0 || !decimalOf(issued).greaterThan(0)) return
      const changes = consumption(own, { lotId: stock.lot?.id ?? null, hideId: stock.hide?.id ?? null, baseQuantity: issued })
      await apply(tools, facts, changes, { action: 'inventory.reservationIssued', moveIds })
    },
  }
}

/** The undo or reversal of an issue: what it took goes back to the work order's ACTIVE reservations (before its moves). */
export async function giveBackIssue(tools: CommandTools, stock: IssueStock, reversed: string, moveIds: readonly string[]): Promise<void> {
  const { facts, mine } = await factsFor(tools, stock)
  const own = facts.reservations.filter(mine)
  if (own.length === 0) return
  if (stock.hide) {
    // The hide's own HIDE reservation took the whole issue (and is ISSUED, final): nothing else gave anything to it.
    const lines = await orderLinesOf(tools.tx, stock.workOrder.id)
    const hideOwn = await tools.tx.reservation.findMany({ where: { hideId: stock.hide.id, kind: 'HIDE', status: 'ISSUED' }, select: { workOrderId: true, salesOrderLineId: true } })
    if (hideOwn.some((row) => row.workOrderId === stock.workOrder.id || (row.salesOrderLineId !== null && lines.has(row.salesOrderLineId)))) return
  }
  const changes = giveBack(own, { lotId: stock.lot?.id ?? null, hideId: stock.hide?.id ?? null, baseQuantity: reversed })
  await apply(tools, facts, changes, { action: 'inventory.reservationGivenBack', moveIds })
}
