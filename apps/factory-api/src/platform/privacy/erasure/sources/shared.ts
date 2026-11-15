import type { Prisma } from '@nexus/factory-db'
import { kept, ROWS, section, type PersonFacts, type PersonSource, type Reader } from './type'

/**
 * What the person wrote and received, and the history of their record (B-W2b-405; PLT-202; PV1:01). The database keeps these
 * unchanged once written for every login (Message_append_only, the email-in and email-out guards, AuditLog_append_only), so an
 * erasure KEEPS them with why (IMMUTABLE) until a guarded erasure path exists (the open schema need of B-W2b-279/290): the
 * business record stays, the name cannot go yet. They are in the person's package in full.
 */

/** The messages the person wrote on record threads: as a contact (PARTY), an office account (USER) or a floor account (WORKER). */
function authoredBy(person: PersonFacts): Prisma.MessageWhereInput | null {
  const or: Prisma.MessageWhereInput[] = []
  if (person.kind === 'CONTACT') or.push({ authorKind: 'PARTY', authorId: person.recordId })
  if (person.userId) or.push({ authorKind: 'USER', authorId: person.userId })
  if (person.workerIds.length > 0) or.push({ authorKind: 'WORKER', authorId: { in: [...person.workerIds] } })
  return or.length === 0 ? null : { OR: or }
}

export const messages: PersonSource = {
  key: 'messages',
  kinds: ['CONTACT', 'USER', 'WORKER'],
  async collect(db, person) {
    const where = authoredBy(person)
    if (!where) return { sections: [], fileRecords: [] }
    const rows = await db.message.findMany({ where, select: { id: true, threadId: true, at: true, authorKind: true, authorName: true, bodyText: true, attachmentFileIds: true }, orderBy: [{ at: 'asc' }, { id: 'asc' }], take: ROWS + 1 })
    return { sections: [section('messages', 'Messages written on record threads', rows)], fileRecords: [] }
  },
  async plan(db, person) {
    const where = authoredBy(person)
    if (!where) return []
    const rows = await db.message.findMany({ where, select: { id: true }, orderBy: [{ at: 'asc' }, { id: 'asc' }] })
    return rows.map((row) => kept('Message', row.id, 'IMMUTABLE', ['authorName', 'bodyText', 'bodyHtml']))
  },
}

/** The mails received from the person's address (or matched to the contact) and the mails sent to it. */
async function mailsFrom(db: Reader, person: PersonFacts): Promise<Prisma.InboundEmailWhereInput | null> {
  const or: Prisma.InboundEmailWhereInput[] = []
  if (person.kind === 'CONTACT') or.push({ senderContactId: person.recordId })
  if (person.email) or.push({ fromAddress: { equals: person.email, mode: 'insensitive' } })
  if (person.kind === 'PROSPECT') {
    // The mail the inquiry came from (a plain id: the mail has no tenant-safe key).
    const inquiry = await db.inquiry.findUnique({ where: { id: person.recordId }, select: { sourceEmailId: true } })
    if (inquiry?.sourceEmailId) or.push({ id: inquiry.sourceEmailId })
  }
  return or.length === 0 ? null : { OR: or }
}

export const mails: PersonSource = {
  key: 'mails',
  kinds: ['CONTACT', 'PROSPECT', 'REPORTER', 'USER'],
  async collect(db, person) {
    const from = await mailsFrom(db, person)
    const received = from
      ? await db.inboundEmail.findMany({ where: from, select: { id: true, receivedAt: true, fromAddress: true, fromName: true, subject: true, bodyText: true, status: true }, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }], take: ROWS + 1 })
      : []
    const sent = person.email
      ? await db.emailOutbound.findMany({ where: { OR: [{ to: { has: person.email } }, { cc: { has: person.email } }] }, select: { id: true, queuedAt: true, sentAt: true, subject: true, status: true, recordType: true, recordId: true }, orderBy: [{ queuedAt: 'asc' }, { id: 'asc' }], take: ROWS + 1 })
      : []
    return {
      sections: [section('mailsReceived', 'Mails received from the person', received), section('mailsSent', 'Mails sent to the person', sent)],
      fileRecords: received.map((row) => ({ recordType: 'InboundEmail', recordId: row.id })),
    }
  },
  async plan(db, person) {
    const from = await mailsFrom(db, person)
    const received = from ? await db.inboundEmail.findMany({ where: from, select: { id: true }, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }] }) : []
    const sent = person.email ? await db.emailOutbound.findMany({ where: { OR: [{ to: { has: person.email } }, { cc: { has: person.email } }] }, select: { id: true }, orderBy: [{ queuedAt: 'asc' }, { id: 'asc' }] }) : []
    return [
      ...received.map((row) => kept('InboundEmail', row.id, 'IMMUTABLE', ['fromAddress', 'fromName', 'subject', 'bodyText', 'bodyHtml'])),
      ...sent.map((row) => kept('EmailOutbound', row.id, 'IMMUTABLE', ['to', 'cc', 'subject'])),
    ]
  },
}

/** The audit rows of the person's own record (they may hold its earlier values): their history in the package, kept by the database. */
function historyOf(person: PersonFacts): Prisma.AuditLogWhereInput {
  const records: Prisma.AuditLogWhereInput[] = [{ recordType: person.recordType, recordId: person.recordId }]
  if (person.employeeId && person.recordType !== 'Employee') records.push({ recordType: 'Employee', recordId: person.employeeId })
  for (const workerId of person.workerIds) if (!(person.recordType === 'Worker' && person.recordId === workerId)) records.push({ recordType: 'Worker', recordId: workerId })
  return { OR: records }
}

export const history: PersonSource = {
  key: 'history',
  kinds: ['CONTACT', 'PROSPECT', 'REPORTER', 'USER', 'WORKER'],
  async collect(db, person) {
    const rows = await db.auditLog.findMany({ where: historyOf(person), select: { id: true, at: true, action: true, recordType: true, recordId: true, reason: true }, orderBy: [{ at: 'asc' }, { id: 'asc' }], take: ROWS + 1 })
    return { sections: [section('history', "The changes to the person's own record (what was done, when)", rows)], fileRecords: [] }
  },
  async plan(db, person) {
    const rows = await db.auditLog.findMany({ where: historyOf(person), select: { id: true }, orderBy: [{ at: 'asc' }, { id: 'asc' }] })
    return rows.map((row) => kept('AuditLog', row.id, 'IMMUTABLE', ['before', 'after']))
  },
}
