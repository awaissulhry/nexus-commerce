import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { PAYMENTS_VIEW } from '@nexus/factory-domain/payments/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { balancesOf } from '../credit-balance'
import { officeContextOf } from '../store'
import { toleranceOf } from '../write-offs/sums'
import { openItemsOf } from './facts'

/**
 * The unapplied cash queue (B-W2b-393; FIN-117; design finance.payments tile "Not placed on an invoice", Rows ▾ "Not
 * placed"): every RECEIVED payment of a company with money not placed on an invoice or a deposit request — its amount less
 * its allocations, its live refunds and what an OVERPAYMENT write-off keeps — oldest first, in ONE queue (whether it came
 * from a bank line or was typed by hand), each with how long it waits, what its customer still has open (to place it:
 * W1's POST /payments/:id/allocations), whether the leftover is within the write-off tolerance (POST
 * /payments/:id/write-offs), and the bank line it came from. `totals` are the tile: how many, and how much per currency.
 *
 *   GET /payments/unapplied?companyId[&partyId][&cursor][&limit]    payments.view over the company and each customer
 */

const day = (value: Date): string => value.toISOString().slice(0, 10)

export async function unappliedQueue(caller: CommandCaller, query: { readonly companyId: string; readonly partyId?: string | undefined; readonly cursor?: number | undefined; readonly limit: number }) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  if (!can(actor, PAYMENTS_VIEW, { companyId: query.companyId })) throw new NotFoundError('Company not found.')
  const today = businessDate(serverClock.now())
  return caller.withClient(async (db) => {
    const rows = await db.$queryRaw<{ id: string; partyId: string; amount: number; currency: string; receivedOn: Date; externalRef: string; unplaced: bigint }[]>`
      SELECT p.id, p."partyId", p.amount, p.currency, p."receivedOn", p."externalRef",
             p.amount - coalesce(a.allocated, 0) - coalesce(r.refunded, 0) - coalesce(w.written, 0) AS unplaced
        FROM "Payment" p
        LEFT JOIN LATERAL (SELECT sum(pa.amount) AS allocated FROM "PaymentAllocation" pa WHERE pa."paymentId" = p.id) a ON true
        LEFT JOIN LATERAL (SELECT sum(rf.amount) AS refunded FROM "Refund" rf WHERE rf."paymentId" = p.id AND rf.status IN ('DUE', 'PAID')) r ON true
        LEFT JOIN LATERAL (SELECT sum(wo.amount) AS written FROM "PaymentWriteOff" wo WHERE wo."paymentId" = p.id AND wo.kind = 'OVERPAYMENT') w ON true
       WHERE p."companyId" = ${query.companyId}::uuid AND p.status = 'RECEIVED'
         AND (${query.partyId ?? null}::uuid IS NULL OR p."partyId" = ${query.partyId ?? null}::uuid)
         AND p.amount - coalesce(a.allocated, 0) - coalesce(r.refunded, 0) - coalesce(w.written, 0) > 0
       ORDER BY p."receivedOn", p.id`
    // Each customer's payments only with payments.view over it (a grant may name customers).
    const queue = rows.filter((row) => can(actor, PAYMENTS_VIEW, { companyId: query.companyId, partyId: row.partyId }))
    const start = query.cursor ?? 0
    const page = queue.slice(start, start + query.limit)
    const partyIds = [...new Set(page.map((row) => row.partyId))]
    const parties = partyIds.length === 0 ? [] : await db.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, code: true, legalName: true } })
    const lines = page.length === 0 ? [] : await db.bankMatch.findMany({ where: { paymentId: { in: page.map((row) => row.id) }, acceptedAt: { not: null }, reversedAt: null }, select: { paymentId: true, bankLineId: true, bankLine: { select: { bookedOn: true } } } })
    const open = partyIds.length === 0 ? [] : await openItemsOf(db, query.companyId)
    const tolerance = (await toleranceOf(db, query.companyId)).amount
    const unplacedOf = (row: (typeof rows)[number]) => Number(row.unplaced)
    return {
      companyId: query.companyId,
      tolerance: asMoney('price', tolerance),
      totals: { count: queue.length, amounts: balancesOf(queue.map((row) => ({ currency: row.currency, unplaced: unplacedOf(row) }))).map((entry) => ({ currency: entry.currency, amount: asMoney('price', entry.amount) })) },
      payments: page.map((row) => {
        const received = day(row.receivedOn)
        const line = lines.find((entry) => entry.paymentId === row.id)
        const unplaced = unplacedOf(row)
        return {
          id: row.id,
          partyId: row.partyId,
          party: parties.find((party) => party.id === row.partyId) ?? { id: row.partyId, code: '', legalName: '' },
          receivedOn: received,
          externalRef: row.externalRef,
          currency: row.currency,
          amount: asMoney('price', row.amount),
          unplacedAmount: asMoney('price', unplaced),
          waitingDays: Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${received}T00:00:00Z`)) / 86_400_000)),
          // How many items the customer still has open in the currency (W1's open items say how much; placing is W1's allocation).
          openItems: open.filter((item) => item.partyId === row.partyId && item.currency === row.currency).length,
          writeOffWithinTolerance: tolerance !== null && unplaced <= tolerance,
          bankLine: line ? { id: line.bankLineId, bookedOn: day(line.bankLine.bookedOn) } : null,
        }
      }),
      nextCursor: start + query.limit < queue.length ? start + query.limit : null,
    }
  })
}
