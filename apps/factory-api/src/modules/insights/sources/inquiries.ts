import type { AttentionCandidate } from '@nexus/factory-domain/insights/attention'
import { inquiryWaitingWords, phrase } from '@nexus/factory-domain/insights/words'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { SALES_INQUIRIES_VIEW } from '@nexus/factory-domain/sales/inquiries/permissions'
import { overdue, type InquiryStatus } from '@nexus/factory-domain/sales/inquiries/rules'
import type { Prisma } from '@nexus/factory-db'
import { serverClock } from '../../../core/time'
import { waitingMinutesOf } from '../../sales/inquiries/views'
import { SOURCE_LIMIT, type Source } from './common'

/**
 * Inquiries waiting for us (B-W2b-385; follow-up NT1:02 "an inquiry waiting over a day is a Today item"; B-W2b-322's gap
 * "Today has no inquiry source"): the open inquiries that wait for us (NEW, ASSIGNED) over one working day on their company's
 * calendar — the inquiries list's WAITING_US tile, the same reading (modules/sales/inquiries waitingMinutesOf,
 * factory-domain sales/inquiries `overdue`) — that are the reader's: given to them, or given to nobody yet (then everyone's
 * who answers the company's inquiries). Names inside the row are the customer's or the prospect's, never a colleague's.
 */

export const inquiryWaiting: Source = async ({ caller, viewer }) => {
  const now = serverClock.now()
  const { rows, minutes } = await caller.withClient(async (client) => {
    const found = await client.inquiry.findMany({
      where: { AND: [scopeWhere(viewer.actor, SALES_INQUIRIES_VIEW, { company: 'companyId' }) as Prisma.InquiryWhereInput, { status: { in: ['NEW', 'ASSIGNED'] } }, { OR: [{ assigneeId: viewer.personId }, { assigneeId: null }] }] },
      orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
      take: SOURCE_LIMIT,
      select: { id: true, number: true, companyId: true, status: true, receivedAt: true, assigneeId: true, partyId: true, prospectName: true, prospectCompany: true, prospectEmail: true, prospectErasedAt: true, party: { select: { legalName: true, tradeName: true } } },
    })
    return { rows: found, minutes: await waitingMinutesOf(client, found, now) }
  })
  const candidates: AttentionCandidate[] = rows.flatMap((row) => {
    const waited = minutes.get(row.id) ?? null
    if (!overdue(row.status as InquiryStatus, waited)) return []
    const from = row.party ? (row.party.tradeName ?? row.party.legalName) : row.prospectErasedAt ? 'Erased prospect' : (row.prospectCompany ?? row.prospectName ?? row.prospectEmail ?? '—')
    const assigned = row.assigneeId !== null
    return [
      {
        kind: 'INQUIRY_WAITING' as const,
        state: assigned ? 'ASSIGNED' : 'NEW',
        severity: 'MEDIUM' as const,
        record: { type: 'Inquiry', id: row.id, label: row.number },
        scope: { companyId: row.companyId, siteId: null, partyId: row.partyId },
        ...inquiryWaitingWords({ number: row.number, from, assigned }),
        due: null,
        since: row.receivedAt,
        ...(assigned ? { why: (personId: string) => (personId === row.assigneeId ? phrase('why.INQUIRY_WAITING.assigned') : null) } : {}),
      },
    ]
  })
  return { kind: 'INQUIRY_WAITING', candidates, complete: rows.length < SOURCE_LIMIT }
}
