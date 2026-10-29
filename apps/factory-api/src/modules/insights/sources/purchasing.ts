import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import type { AttentionCandidate, Viewer } from '@nexus/factory-domain/insights/attention'
import { hoursUnconfirmed, PO_CONFIRM_HOURS } from '@nexus/factory-domain/insights/states'
import { poNotConfirmedWords, poProposalWords } from '@nexus/factory-domain/insights/words'
import { PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import { capped, dayOrNull, partyNames, SOURCE_LIMIT, type Source } from './common'

/**
 * Purchasing (B-W1-30 orders, B-W1-31 the supplier's answer): changes a supplier proposed by link, waiting for the buyer
 * (P2 answer A: the buyer decides), and purchase orders still SENT 48 hours after they went out. Purchase prices are the
 * cost grain.
 */

const COLUMNS = { id: true, number: true, companyId: true, siteId: true, partyId: true, status: true, currency: true, netAmount: true, requestedDate: true, sentAt: true, proposedAt: true, createdAt: true } as const

function scopeOf(viewer: Viewer): Prisma.PurchaseOrderWhereInput {
  return scopeWhere(viewer.actor, PURCHASING_VIEW, { company: 'companyId', site: 'siteId', party: 'partyId' }) as Prisma.PurchaseOrderWhereInput
}

/** PO_PROPOSAL: orders in CHANGES_PROPOSED. */
export const poProposal: Source = async ({ caller, viewer }) =>
  caller.withClient(async (db) => {
    const found = await db.purchaseOrder.findMany({ where: { AND: [scopeOf(viewer), { status: 'CHANGES_PROPOSED' }] }, orderBy: [{ proposedAt: 'asc' }, { id: 'asc' }], take: SOURCE_LIMIT + 1, select: COLUMNS })
    const { rows, complete } = capped(found, SOURCE_LIMIT)
    const names = await partyNames(db, rows.map((row) => row.partyId))
    const candidates: AttentionCandidate[] = rows.map((row) => ({
      kind: 'PO_PROPOSAL',
      state: 'CHANGES_PROPOSED',
      severity: 'MEDIUM',
      record: { type: 'PurchaseOrder', id: row.id, label: row.number },
      scope: { companyId: row.companyId, siteId: row.siteId, partyId: row.partyId },
      ...poProposalWords({ number: row.number, supplier: names.get(row.partyId) ?? 'The supplier' }),
      due: dayOrNull(row.requestedDate),
      since: row.proposedAt ?? row.createdAt,
      amounts: { currency: row.currency, purchaseAmount: row.netAmount },
    }))
    return { kind: 'PO_PROPOSAL', candidates, complete }
  })

/** PO_NOT_CONFIRMED: orders SENT at least PO_CONFIRM_HOURS ago. */
export const poNotConfirmed: Source = async ({ caller, viewer }) =>
  caller.withClient(async (db) => {
    const before = new Date(viewer.now.getTime() - PO_CONFIRM_HOURS * 3_600_000)
    const found = await db.purchaseOrder.findMany({ where: { AND: [scopeOf(viewer), { status: 'SENT', sentAt: { lte: before } }] }, orderBy: [{ sentAt: 'asc' }, { id: 'asc' }], take: SOURCE_LIMIT + 1, select: COLUMNS })
    const { rows, complete } = capped(found, SOURCE_LIMIT)
    const names = await partyNames(db, rows.map((row) => row.partyId))
    const candidates: AttentionCandidate[] = []
    for (const row of rows) {
      const hours = hoursUnconfirmed(row.sentAt, viewer.now)
      if (hours === null || row.sentAt === null) continue
      const requestedDate = dayOrNull(row.requestedDate)
      candidates.push({
        kind: 'PO_NOT_CONFIRMED',
        state: 'SENT',
        severity: 'MEDIUM',
        record: { type: 'PurchaseOrder', id: row.id, label: row.number },
        scope: { companyId: row.companyId, siteId: row.siteId, partyId: row.partyId },
        ...poNotConfirmedWords({ number: row.number, supplier: names.get(row.partyId) ?? 'the supplier', hours, requestedDate }),
        due: requestedDate,
        since: row.sentAt,
        amounts: { currency: row.currency, purchaseAmount: row.netAmount, inSentence: 'purchaseAmount' },
      })
    }
    return { kind: 'PO_NOT_CONFIRMED', candidates, complete }
  })
