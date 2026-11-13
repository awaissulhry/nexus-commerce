import type { RulePlace, Finding } from '@nexus/factory-domain/alerts/rules'
import { businessDate } from '@nexus/factory-domain/core/time'
import { arrivalOf } from '@nexus/factory-domain/sales/returns-depth/rules'
import type { CommandTx } from '../../../core/command'
import { dayOrNull } from '../returns/store'

/**
 * The late return's alert (B-W2b-385; follow-up NT1:04 "a late return arrival raises its alert"; B-W2b-341 made late arrival a
 * reading: the tile "Arrived after the deadline", GET /sales/returns/arrived-late): the exception rules' kind RETURN_ARRIVED_LATE
 * (factory-domain alerts/kinds) finds, in the tenant's system scope, the returns whose goods were received (RECEIVED or
 * INSPECTED, not closed) on a Rome day after their deadline — the same reading as the tile (returns-depth/rules arrivalOf).
 * The alert clears when the return is closed or no longer late. Nothing here carries money.
 */

const LIMIT = 500

export async function lateReturnFindings(tx: CommandTx, rule: RulePlace & { readonly threshold: unknown }, now: Date, only?: readonly string[]): Promise<Finding[]> {
  const today = businessDate(now)
  const rows = await tx.returnAuthorisation.findMany({
    where: {
      ...(only ? { id: { in: [...only] } } : {}),
      ...(rule.companyId ? { companyId: rule.companyId } : {}),
      ...(rule.siteId ? { siteId: rule.siteId } : {}),
      status: { in: ['RECEIVED', 'INSPECTED'] },
      goodsDueBy: { not: null },
      receivedAt: { not: null },
    },
    orderBy: [{ receivedAt: 'desc' }, { id: 'asc' }],
    take: LIMIT,
    select: { id: true, number: true, companyId: true, siteId: true, partyId: true, goodsDueBy: true, receivedAt: true },
  })
  return rows.flatMap((row) => {
    const dueDate = dayOrNull(row.goodsDueBy)
    const receivedDate = row.receivedAt ? businessDate(row.receivedAt) : null
    const arrival = arrivalOf(dueDate, receivedDate, today)
    if (arrival.state !== 'LATE' || dueDate === null || receivedDate === null) return []
    return [{ recordType: 'ReturnAuthorisation', recordId: row.id, label: row.number, scope: { companyId: row.companyId, siteId: row.siteId, partyId: row.partyId }, facts: { dueDate, receivedDate, daysLate: arrival.daysLate } }]
  })
}
