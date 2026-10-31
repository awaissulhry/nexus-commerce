import { complaintNumbersIn, COMPLAINT_RECORD, OPEN_STATUSES } from '@nexus/factory-domain/quality/complaints/rules'
import type { CommandTx } from '../../../core/command'

/**
 * Complaints by mail (B-W2b-17; B-W2a-65's gap "mail in matched to a complaint by 'mail to sort' needs email-in's matcher
 * to know the record"; design quality.complaints conn "home (mail to sort) — complaints from e-mail", cmp-record "mail
 * thread (record thread)"). Asked by match.ts only for a mail that names no thread (no reply token, no answer to our own
 * mail) and whose sender is an ACTIVE contact of exactly one party: when its subject names an open complaint of THAT party
 * (the customer) by its number ("Re: CMP-2026-0012 giacca"), the mail goes to the complaint's thread instead of the
 * party's — on the party route's own terms (factory-domain sortMail: DMARC PASS, a closed thread is held). A number alone
 * never matches: the sender must be a contact of the complaint's customer. Read only; the thread is made when the mail
 * is matched (sort.ts ensureThread on the record).
 */

/** The most open complaints of one customer a subject is compared with. */
const OPEN_LIMIT = 500

export interface ComplaintMatch {
  readonly record: { readonly type: typeof COMPLAINT_RECORD; readonly id: string }
  readonly number: string
  /** The complaint's thread when it has one already (else it is made when the mail joins it). */
  readonly thread: { readonly id: string; readonly status: 'OPEN' | 'CLOSED' } | null
}

export async function complaintOfMail(tx: CommandTx, mail: { readonly subject: string | null; readonly partyId: string }): Promise<ComplaintMatch | null> {
  if (!mail.subject?.trim()) return null
  const open = await tx.complaint.findMany({
    where: { partyId: mail.partyId, status: { in: [...OPEN_STATUSES] } },
    select: { id: true, number: true },
    orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
    take: OPEN_LIMIT,
  })
  const named = complaintNumbersIn(mail.subject, open.map((row) => row.number))
  if (named.length === 0) return null
  // The first number the subject names wins (a reply quotes the original's number first).
  const complaint = open.find((row) => row.number.toUpperCase() === named[0])!
  const thread = await tx.thread.findFirst({ where: { recordType: COMPLAINT_RECORD, recordId: complaint.id }, select: { id: true, status: true } })
  return { record: { type: COMPLAINT_RECORD, id: complaint.id }, number: complaint.number, thread: thread ? { id: thread.id, status: thread.status as 'OPEN' | 'CLOSED' } : null }
}
