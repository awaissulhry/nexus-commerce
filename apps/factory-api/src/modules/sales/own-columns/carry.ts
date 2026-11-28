import { isUseOn } from '@nexus/factory-domain/sales/own-columns/rules'
import { newId } from '@nexus/factory-domain/core/ids'
import type { CommandTx } from '../../../core/command'
import { USE_SELECT, VALUE_SELECT } from './store'

/**
 * The customer's own columns go with the order at Confirm (owb- order workflow, S1 po1.5; design § 5zi C "the next order starts with
 * the columns of the last one"; the accept's ONE line map, B-CP-077). Inside the accept's command (the office's scope), after the
 * order and its lines are made: every column ON the request becomes a use of the order in the same place, and every value of a
 * request line is copied onto each order line the map made from it. A line taken out is in no map (it counts nowhere), so its values
 * stay behind; a column switched off is not carried. Returns what it carried (counts, for the accept's audit row).
 */
export async function carryOwnColumns(
  tx: CommandTx,
  request: { readonly id: string; readonly companyId: string; readonly partyId: string },
  orderId: string,
  lineMap: readonly { readonly requestLineId: string; readonly into: readonly { readonly lineId: string }[] }[],
  actorId: string,
  now: Date,
): Promise<{ readonly uses: number; readonly values: number }> {
  const uses = (await tx.orderLineColumnUse.findMany({ where: { portalOrderRequestId: request.id }, select: USE_SELECT, orderBy: [{ seq: 'asc' }, { id: 'asc' }] })).filter((use) => isUseOn(use.seq))
  if (uses.length === 0) return { uses: 0, values: 0 }
  await tx.orderLineColumnUse.createMany({ data: uses.map((use) => ({ id: newId(), companyId: request.companyId, partyId: request.partyId, salesOrderId: orderId, portalOrderRequestId: null, columnId: use.columnId, seq: use.seq, createdById: actorId, createdAt: now, updatedAt: now })) })
  const requestLineIds = lineMap.map((entry) => entry.requestLineId)
  const values = requestLineIds.length === 0 ? [] : await tx.orderLineOwnValue.findMany({ where: { portalOrderRequestLineId: { in: requestLineIds }, columnId: { in: uses.map((use) => use.columnId) } }, select: VALUE_SELECT })
  const copies = lineMap.flatMap((entry) =>
    values
      .filter((value) => value.portalOrderRequestLineId === entry.requestLineId)
      .flatMap((value) => entry.into.map((line) => ({ id: newId(), partyId: request.partyId, columnId: value.columnId, salesOrderLineId: line.lineId, portalOrderRequestLineId: null, valueText: value.valueText, valueNumber: value.valueNumber, valueDate: value.valueDate, valueBool: value.valueBool, createdById: actorId, createdAt: now, updatedAt: now }))),
  )
  if (copies.length > 0) await tx.orderLineOwnValue.createMany({ data: copies })
  return { uses: uses.length, values: copies.length }
}
