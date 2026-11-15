import type { Prisma } from '@nexus/factory-db'
import { events as emailEvents } from '@nexus/factory-domain/email/events'
import { eventFor } from '@nexus/factory-domain/events/define'
import { ownHold, PERSONAL_COLUMNS } from './own'
import { kept, ROWS, section, type ApplyTools, type PersonFacts, type PersonSource, type PlannedRecord, type Reader } from './type'

/**
 * What the person wrote and received, and the history of their record (B-W2b-405; PLT-202, PLT-203; PV1:01). They are in the
 * person's package in full. An erasure BLANKS the person's part of them through the database's guarded path (B-W2b-F54,
 * …_privacy_erasure_w2b_guards): every row stays, only these columns go blank, and only through `factory_privacy_erase_row`
 * with the row's ErasureRecord written in the same command (erase.ts writes every record before any change):
 *
 *   messages   a message they wrote (as a contact, an office account or a floor account): the author's name, the text, the HTML
 *   mails      a mail received from them: the sender's address and name, the subject, the text, the HTML (the envelope sender
 *              the mail server recorded stays: kept, IMMUTABLE); a mail sent to them: their address among the recipients (each
 *              other address stays) and the subject. A mail still waiting to go (QUEUED, or SENDING whose sender stopped) is
 *              stopped first (FAILED: nothing goes to an erased person); one being sent right now blocks the erasure for two
 *              minutes (MAIL_SENDING, erase.ts)
 *   history    an audit row of their own record: the values of the record's personal columns inside before and after
 *
 * A legal hold on their own record (a dispute, a safety report being assessed, employment or health records: own.ts `ownHold`)
 * keeps these as they are too, with the same why. Rows an earlier erasure of the person kept (B-W2b-405 kept them all) are
 * found again through its ErasureRecords, so a new request blanks them even once the person's address is gone (then every
 * address of such a sent mail is blanked: which one was theirs is no longer known).
 */

const [, statusChanged] = emailEvents

/** The database's door: blanks the columns the record's ErasureRecord names (B-W2b-F54); only the office role may call it. */
async function blank(tools: ApplyTools, addresses: readonly string[] = [], keys: readonly string[] = []): Promise<void> {
  await tools.tx.$queryRaw`SELECT "factory_privacy_erase_row"(${tools.erasureId}::uuid, ${[...addresses]}::text[], ${[...keys]}::text[]) AS changed`
}

/** The rows of a table an earlier erasure of this person kept (the same person: kind and record). */
async function keptBefore(db: Reader, person: PersonFacts, recordType: string): Promise<string[]> {
  const rows = await db.erasureRecord.findMany({
    where: { recordType, method: 'KEPT', dataRequest: { personKind: person.kind, personRecordType: person.recordType, personRecordId: person.recordId } },
    select: { recordId: true },
  })
  return [...new Set(rows.map((row) => row.recordId))]
}

const normal = (address: string): string => address.trim().toLowerCase()

/**
 * The messages the person wrote on record threads: as an office account (USER) or a floor account (WORKER) by the author's id;
 * as a contact (PARTY) by the author's id the mail sorting sets; the INBOUND message each of their mails became on a thread
 * (its author the contact when known, else the sender's name); and what they posted in the portal (as a portal person of the
 * contact's party with the contact's e-mail, or as the person's own account) or through a share link of theirs: the audit row
 * that wrote such a message names the portal person (actor) or the share (B-W2b-F54: those carry no author id).
 */
async function authoredBy(db: Reader, person: PersonFacts): Promise<Prisma.MessageWhereInput | null> {
  const or: Prisma.MessageWhereInput[] = []
  if (person.kind === 'CONTACT') or.push({ authorKind: 'PARTY', authorId: person.recordId })
  if (person.userId) or.push({ authorKind: 'USER', authorId: person.userId })
  if (person.workerIds.length > 0) or.push({ authorKind: 'WORKER', authorId: { in: [...person.workerIds] } })
  const ids = new Set<string>()
  const from = await mailsFrom(db, person)
  if (from) for (const mail of await db.inboundEmail.findMany({ where: { AND: [from, { messageId: { not: null } }] }, select: { messageId: true } })) ids.add(mail.messageId!)
  const portalPeople = new Set<string>(person.userId ? [person.userId] : [])
  const shares: string[] = []
  if (person.kind === 'CONTACT' && person.partyId) {
    if (person.email) for (const user of await db.user.findMany({ where: { partyId: person.partyId, email: { equals: person.email, mode: 'insensitive' } }, select: { id: true } })) portalPeople.add(user.id)
    const shareWhere: Prisma.RecordShareWhereInput[] = [{ contactId: person.recordId }, ...(person.email ? [{ email: { equals: person.email, mode: 'insensitive' as const } }] : [])]
    for (const share of await db.recordShare.findMany({ where: { partyId: person.partyId, OR: shareWhere }, select: { id: true } })) shares.push(share.id)
  }
  const posted: Prisma.AuditLogWhereInput[] = [
    ...(portalPeople.size > 0 ? [{ actorId: { in: [...portalPeople] }, audience: 'PARTNER' as const }] : []),
    ...shares.map((shareId) => ({ after: { path: ['shareId'], equals: shareId } })),
  ]
  if (posted.length > 0) for (const row of await db.auditLog.findMany({ where: { recordType: 'Message', OR: posted }, select: { recordId: true } })) ids.add(row.recordId)
  if (ids.size > 0) or.push({ id: { in: [...ids] }, authorKind: { in: ['PARTY', 'USER', 'WORKER'] } })
  return or.length === 0 ? null : { OR: or }
}

const MESSAGE_COLUMNS = ['authorName', 'bodyText', 'bodyHtml'] as const

export const messages: PersonSource = {
  key: 'messages',
  kinds: ['CONTACT', 'PROSPECT', 'REPORTER', 'USER', 'WORKER'],
  async collect(db, person) {
    const where = await authoredBy(db, person)
    if (!where) return { sections: [], fileRecords: [] }
    const rows = await db.message.findMany({ where, select: { id: true, threadId: true, at: true, authorKind: true, authorName: true, bodyText: true, attachmentFileIds: true }, orderBy: [{ at: 'asc' }, { id: 'asc' }], take: ROWS + 1 })
    return { sections: [section('messages', 'Messages written on record threads', rows)], fileRecords: [] }
  },
  async plan(db, person, now) {
    const where = await authoredBy(db, person)
    if (!where) return []
    const rows = await db.message.findMany({ where, select: { id: true, authorName: true, bodyText: true, bodyHtml: true }, orderBy: [{ at: 'asc' }, { id: 'asc' }] })
    const hold = await ownHold(db, person, now)
    if (hold) return rows.map((row) => kept('Message', row.id, hold, [...MESSAGE_COLUMNS]))
    return rows.flatMap((row): PlannedRecord[] => {
      const erasedFields = MESSAGE_COLUMNS.filter((column) => (column === 'bodyText' ? row.bodyText !== '' : row[column] !== null))
      if (erasedFields.length === 0) return []
      return [{ recordType: 'Message', recordId: row.id, method: 'ANONYMISED', erasedFields, keptFields: [], why: null, apply: (tools) => blank(tools) }]
    })
  },
}

/** The mails received from the person's address (or matched to the contact), and those an earlier erasure of them kept. */
async function mailsFrom(db: Reader, person: PersonFacts): Promise<Prisma.InboundEmailWhereInput | null> {
  const or: Prisma.InboundEmailWhereInput[] = []
  if (person.kind === 'CONTACT') or.push({ senderContactId: person.recordId })
  if (person.email) or.push({ fromAddress: { equals: person.email, mode: 'insensitive' } })
  if (person.kind === 'PROSPECT') {
    // The mail the inquiry came from (a plain id: the mail has no tenant-safe key).
    const inquiry = await db.inquiry.findUnique({ where: { id: person.recordId }, select: { sourceEmailId: true } })
    if (inquiry?.sourceEmailId) or.push({ id: inquiry.sourceEmailId })
  }
  const earlier = await keptBefore(db, person, 'InboundEmail')
  if (earlier.length > 0) or.push({ id: { in: earlier } })
  return or.length === 0 ? null : { OR: or }
}

/** The mails sent to the person's address (in To or Cc, any letter case), and those an earlier erasure of them kept. */
async function mailsTo(db: Reader, person: PersonFacts): Promise<Prisma.EmailOutboundWhereInput | null> {
  const or: Prisma.EmailOutboundWhereInput[] = []
  if (person.email) {
    // Any letter case and spacing of the address (an array filter of Prisma compares exactly).
    const rows = await db.$queryRaw<{ id: string }[]>`SELECT id FROM "EmailOutbound" WHERE EXISTS (SELECT 1 FROM unnest("to" || "cc") AS a(address) WHERE lower(btrim(a.address)) = ${normal(person.email)})`
    if (rows.length > 0) or.push({ id: { in: rows.map((row) => row.id) } })
  }
  const earlier = await keptBefore(db, person, 'EmailOutbound')
  if (earlier.length > 0) or.push({ id: { in: earlier } })
  return or.length === 0 ? null : { OR: or }
}

/** Whether a mail to the person is being sent right now (SENDING, its sender's claim still running): the erasure waits for it. */
export async function mailSendingNow(db: Reader, person: PersonFacts, now: Date): Promise<boolean> {
  const to = await mailsTo(db, person)
  if (!to) return false
  return (await db.emailOutbound.count({ where: { AND: [to, { status: 'SENDING', claimedUntil: { gt: now } }] } })) > 0
}

const RECEIVED_COLUMNS = ['fromAddress', 'fromName', 'subject', 'bodyText', 'bodyHtml'] as const
const STOPPED = 'stopped: the person it was going to asked to be erased (GDPR art. 17)'

export const mails: PersonSource = {
  key: 'mails',
  kinds: ['CONTACT', 'PROSPECT', 'REPORTER', 'USER'],
  async collect(db, person) {
    const from = await mailsFrom(db, person)
    const received = from
      ? await db.inboundEmail.findMany({ where: from, select: { id: true, receivedAt: true, fromAddress: true, fromName: true, subject: true, bodyText: true, status: true }, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }], take: ROWS + 1 })
      : []
    const to = await mailsTo(db, person)
    const sent = to ? await db.emailOutbound.findMany({ where: to, select: { id: true, queuedAt: true, sentAt: true, subject: true, status: true, recordType: true, recordId: true }, orderBy: [{ queuedAt: 'asc' }, { id: 'asc' }], take: ROWS + 1 }) : []
    return {
      sections: [section('mailsReceived', 'Mails received from the person', received), section('mailsSent', 'Mails sent to the person', sent)],
      fileRecords: received.map((row) => ({ recordType: 'InboundEmail', recordId: row.id })),
    }
  },
  async plan(db, person, now) {
    const from = await mailsFrom(db, person)
    const received = from ? await db.inboundEmail.findMany({ where: from, select: { id: true, fromAddress: true, fromName: true, subject: true, bodyText: true, bodyHtml: true, envelopeFrom: true }, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }] }) : []
    const to = await mailsTo(db, person)
    const sent = to
      ? await db.emailOutbound.findMany({ where: to, select: { id: true, companyId: true, threadId: true, recordType: true, recordId: true, status: true, claimedUntil: true, to: true, cc: true, subject: true }, orderBy: [{ queuedAt: 'asc' }, { id: 'asc' }] })
      : []
    const hold = await ownHold(db, person, now)
    if (hold) return [...received.map((row) => kept('InboundEmail', row.id, hold, [...RECEIVED_COLUMNS])), ...sent.map((row) => kept('EmailOutbound', row.id, hold, ['to', 'cc', 'subject']))]

    const planned: PlannedRecord[] = []
    for (const row of received) {
      const erasedFields = RECEIVED_COLUMNS.filter((column) => row[column] !== null)
      if (erasedFields.length === 0) continue
      const envelope = row.envelopeFrom !== null
      planned.push({ recordType: 'InboundEmail', recordId: row.id, method: 'ANONYMISED', erasedFields, keptFields: envelope ? ['envelopeFrom'] : [], why: envelope ? 'IMMUTABLE' : null, apply: (tools) => blank(tools) })
    }
    for (const row of sent) {
      // The person's address when it is still known; otherwise (an earlier erasure took it) every address of the mail.
      const addresses = person.email ? [normal(person.email)] : [...row.to, ...row.cc].filter((address) => address.trim() !== '').map(normal)
      const holds = (list: readonly string[]) => list.some((address) => addresses.includes(normal(address)))
      const erasedFields = [...(holds(row.to) ? ['to'] : []), ...(holds(row.cc) ? ['cc'] : []), ...(row.subject !== '' ? ['subject'] : [])]
      if (erasedFields.length === 0) continue
      const waiting = row.status === 'QUEUED' || (row.status === 'SENDING' && (row.claimedUntil === null || row.claimedUntil.getTime() <= now.getTime()))
      planned.push({
        recordType: 'EmailOutbound',
        recordId: row.id,
        method: 'ANONYMISED',
        erasedFields,
        keptFields: [],
        why: null,
        async apply(tools) {
          if (waiting) {
            // Nothing goes to an erased person: the mail is stopped before its recipients and subject go blank.
            const { count } = await tools.tx.emailOutbound.updateMany({
              where: { id: row.id, OR: [{ status: 'QUEUED' }, { status: 'SENDING', OR: [{ claimedUntil: null }, { claimedUntil: { lte: tools.now } }] }] },
              data: { status: 'FAILED', failedAt: tools.now, claimedUntil: null, lastError: STOPPED },
            })
            if (count === 1) tools.emit(eventFor(statusChanged, { subject: row.id, companyId: row.companyId, payload: { outboundId: row.id, threadId: row.threadId, recordType: row.recordType, recordId: row.recordId, status: 'FAILED' } }))
          }
          await blank(tools, addresses)
        },
      })
    }
    return planned
  },
}

/** The audit rows of the person's own records (they may hold their earlier values): their history in the package. */
function historyOf(person: PersonFacts): Prisma.AuditLogWhereInput {
  const records: Prisma.AuditLogWhereInput[] = [{ recordType: person.recordType, recordId: person.recordId }]
  if (person.employeeId && person.recordType !== 'Employee') records.push({ recordType: 'Employee', recordId: person.employeeId })
  for (const workerId of person.workerIds) if (!(person.recordType === 'Worker' && person.recordId === workerId)) records.push({ recordType: 'Worker', recordId: workerId })
  return { OR: records }
}

/** Whether a JSON value holds one of these keys with a value (at any depth): what the door would blank. */
function holdsKey(value: Prisma.JsonValue | null, keys: readonly string[]): boolean {
  if (Array.isArray(value)) return value.some((item) => holdsKey(item, keys))
  if (value === null || typeof value !== 'object') return false
  return Object.entries(value).some(([key, inner]) => (keys.includes(key) ? inner !== null : holdsKey(inner ?? null, keys)))
}

export const history: PersonSource = {
  key: 'history',
  kinds: ['CONTACT', 'PROSPECT', 'REPORTER', 'USER', 'WORKER'],
  async collect(db, person) {
    const rows = await db.auditLog.findMany({ where: historyOf(person), select: { id: true, at: true, action: true, recordType: true, recordId: true, reason: true }, orderBy: [{ at: 'asc' }, { id: 'asc' }], take: ROWS + 1 })
    return { sections: [section('history', "The changes to the person's own record (what was done, when)", rows)], fileRecords: [] }
  },
  async plan(db, person, now) {
    const rows = await db.auditLog.findMany({ where: historyOf(person), select: { id: true, recordType: true, before: true, after: true }, orderBy: [{ at: 'asc' }, { id: 'asc' }] })
    const hold = await ownHold(db, person, now)
    if (hold) return rows.map((row) => kept('AuditLog', row.id, hold, ['before', 'after']))
    return rows.flatMap((row): PlannedRecord[] => {
      const keys = PERSONAL_COLUMNS[row.recordType] ?? []
      const erasedFields = [...(holdsKey(row.before, keys) ? ['before'] : []), ...(holdsKey(row.after, keys) ? ['after'] : [])]
      if (erasedFields.length === 0) return []
      return [{ recordType: 'AuditLog', recordId: row.id, method: 'ANONYMISED', erasedFields, keptFields: [], why: null, apply: (tools) => blank(tools, [], keys) }]
    })
  },
}
