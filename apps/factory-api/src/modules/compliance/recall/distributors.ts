import type { Prisma } from '@nexus/factory-db'
import { REGISTER_VIEW } from '@nexus/factory-domain/compliance/register/permissions'
import { draftDistributorMessage } from '@nexus/factory-domain/compliance/recall/drafts'
import { RECALL_MANAGE, RECALL_SEND } from '@nexus/factory-domain/compliance/recall/permissions'
import {
  distributorDraftProblems,
  metOnProblems,
  RECALL_LAW,
  RECALL_LIMITS,
  toldCount,
  TOLD_STATUSES,
  type DistributorChannel,
  type DistributorStatus,
  type DraftedChannel,
  type RecallKind,
} from '@nexus/factory-domain/compliance/recall/rules'
import { ConflictError, DomainError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { cleanBody } from '@nexus/factory-domain/threads/rules'
import { runCommand, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { sendEmail } from '../../../platform/email-out/outbound'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { ensureThread, writeMessage } from '../../../platform/threads/threads'
import { changed as entryChanged, ENTRY_SCOPE } from '../register/register'
import { lockEntry, updateEntry, type EntryRecord } from '../register/store'
import { traceOf } from '../register/trace'
import type { DistributorNoticeView } from './contract'
import { assertMay, entryScope, guarded, mayOn, namesFor, officeOf, settings, textOrNull, uuidOr404, visibleEntry, type Reader } from './common'
import { draftFactsOf } from './notices'

/**
 * Distributors told one by one (B-W2b-260; RG1:02 "Inform distributors sends a mail per recipient through the outbox and
 * records the answer (DistributorNotice), not only a date"; PPE Reg. (EU) 2016/425 art. 8(4); design compliance.register ›
 * pop:rg-inform "recipients found from shipments of the batch, each with the message in their language; review per
 * recipient; one send; a result per recipient; log kept on the entry").
 *
 *   recipients  the customers the entry's trace found with garments that left (W1's register trace), with their contacts
 *               and the notices so far ("3 of 5 informed").
 *   draft       one DRAFT notice per recipient: by e-mail (to the contact's address), a portal message or a call; the
 *               message drafted in the recipient's language (Italian or English; else English), the person edits it.
 *   send        compliance.recall.send (step-up), by the person: an e-mail goes through the outbox on the notice's own
 *               thread (EmailOutbound recordType DistributorNotice; FAKE locally), a call or portal message is recorded
 *               as made. Each recipient in its own command, so one refused address does not hold the others; a result per
 *               recipient. When the last recipient was told, W1's entry gets its "distributors informed" date (when empty)
 *               and a note on its thread naming who was told how.
 *   answer      the distributor's reply on the notice's thread is recorded as its answer by the worker (handler
 *               compliance.recall.distributorReply); one taken by phone is recorded by hand. A bounce or a failed send
 *               marks the notice FAILED (handler compliance.recall.distributorMail); a second try is a new notice.
 */

export const DISTRIBUTOR_NOT_FOUND = 'Distributor notice not found.'

const NOTICE_SELECT = {
  id: true,
  companyId: true,
  registerEntryId: true,
  recallActionId: true,
  partyId: true,
  channel: true,
  contactName: true,
  contact: true,
  language: true,
  subject: true,
  message: true,
  status: true,
  sentAt: true,
  sentById: true,
  answeredAt: true,
  answer: true,
  answeredByName: true,
  failedAt: true,
  failureReason: true,
  cancelledAt: true,
  cancelReason: true,
  note: true,
  version: true,
  createdAt: true,
  party: { select: { id: true, code: true, legalName: true } },
  recallAction: { select: { number: true } },
  registerEntry: { select: { partyId: true, status: true } },
} as const satisfies Prisma.DistributorNoticeSelect
type NoticeRow = Prisma.DistributorNoticeGetPayload<{ select: typeof NOTICE_SELECT }>

const iso = (value: Date | null): string | null => (value ? toUtcIso(value) : null)
const EMIT_SELECT = { id: true, companyId: true, registerEntryId: true, recallActionId: true, partyId: true, channel: true, status: true } as const satisfies Prisma.DistributorNoticeSelect
type Change = 'DRAFTED' | 'EDITED' | 'SENT' | 'ANSWERED' | 'FAILED' | 'CANCELLED'
function emitNotice(tools: Pick<CommandTools, 'emit'>, row: Prisma.DistributorNoticeGetPayload<{ select: typeof EMIT_SELECT }>, change: Change): void {
  tools.emit({
    type: 'distributor_notice.changed',
    subject: row.id,
    companyId: row.companyId,
    payload: { noticeId: row.id, entryId: row.registerEntryId, recallId: row.recallActionId, partyId: row.partyId, channel: row.channel, status: row.status, change },
  })
}

export async function distributorViews(db: Reader, context: OfficeContext | null, rows: readonly NoticeRow[]): Promise<DistributorNoticeView[]> {
  const people = await namesFor(db, rows.map((row) => row.sentById))
  const mails = rows.length
    ? await db.emailOutbound.findMany({ where: { recordType: 'DistributorNotice', recordId: { in: rows.map((row) => row.id) } }, select: { recordId: true, status: true, queuedAt: true }, orderBy: [{ queuedAt: 'desc' }] })
    : []
  const mailOf = new Map<string, string>()
  for (const mail of mails) if (mail.recordId && !mailOf.has(mail.recordId)) mailOf.set(mail.recordId, mail.status)
  return rows.map((row) => {
    const scope = { companyId: row.companyId, partyId: row.registerEntry.partyId }
    const manage = context !== null && mayOn(context, RECALL_MANAGE, scope)
    const send = context !== null && mayOn(context, RECALL_SEND, scope)
    const open = row.registerEntry.status === 'OPEN'
    return {
      id: row.id,
      companyId: row.companyId,
      entryId: row.registerEntryId,
      recallId: row.recallActionId,
      recallNumber: row.recallAction?.number ?? null,
      party: { id: row.party.id, code: row.party.code, name: row.party.legalName },
      channel: row.channel,
      contactName: row.contactName,
      contact: row.contact,
      language: row.language,
      subject: row.subject,
      message: row.message,
      status: row.status,
      sentAt: iso(row.sentAt),
      sentBy: people(row.sentById),
      answeredAt: iso(row.answeredAt),
      answer: row.answer,
      answeredByName: row.answeredByName,
      failedAt: iso(row.failedAt),
      failureReason: row.failureReason,
      cancelledAt: iso(row.cancelledAt),
      cancelReason: row.cancelReason,
      mail: mailOf.has(row.id) ? { status: mailOf.get(row.id)! } : null,
      note: row.note,
      version: row.version,
      createdAt: toUtcIso(row.createdAt),
      may: {
        edit: manage && row.status === 'DRAFT' && open,
        send: send && row.status === 'DRAFT' && open && row.channel !== 'LINK',
        answer: manage && row.status === 'SENT',
        fail: manage && row.status === 'SENT',
        cancel: manage && row.status === 'DRAFT',
      },
    }
  })
}

const reach = (context: OfficeContext): Prisma.DistributorNoticeWhereInput => ({ registerEntry: scopeWhere(actorOf(context), REGISTER_VIEW, ENTRY_SCOPE) as Prisma.PpeRegisterEntryWhereInput })

async function readNotice(db: Reader, context: OfficeContext, noticeId: string): Promise<NoticeRow> {
  uuidOr404(noticeId, DISTRIBUTOR_NOT_FOUND)
  const row = await db.distributorNotice.findFirst({ where: { AND: [{ id: noticeId }, reach(context)] }, select: NOTICE_SELECT })
  if (!row) throw new NotFoundError(DISTRIBUTOR_NOT_FOUND)
  return row
}

async function noticeAnswer(caller: CommandCaller, noticeId: string): Promise<{ notice: DistributorNoticeView }> {
  const context = officeOf(caller)
  return caller.withClient(async (db) => ({ notice: (await distributorViews(db, context, [await readNotice(db, context, noticeId)]))[0]! }))
}

// ---- recipients -----------------------------------------------------------------------------------------------------------

/** The customers the entry's trace found with garments that left: the recipients. */
async function recipientsOfEntry(db: Reader, entry: EntryRecord) {
  return (await traceOf(db, entry.companyId, entry)).customers
}

/** "3 of 5 informed" of an entry (the record's Actions tab and the surveillance read). */
export async function toldOfEntry(db: Reader, entry: EntryRecord): Promise<{ told: number; of: number; allTold: boolean }> {
  const customers = await recipientsOfEntry(db, entry)
  const notices = await db.distributorNotice.findMany({ where: { registerEntryId: entry.id }, select: { partyId: true, status: true } })
  return toldCount(customers.map((customer) => customer.partyId), notices)
}

/** GET /compliance/register/:entryId/distributors: the recipients, their contacts and the notices so far. */
export async function recipients(caller: CommandCaller, entryId: string) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const entry = await visibleEntry(db, context, entryId)
    const customers = await recipientsOfEntry(db, entry)
    const ids = customers.map((customer) => customer.partyId)
    const parties = new Map((await db.party.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, legalName: true, language: true } })).map((party) => [party.id, party]))
    const contacts = await db.partyContact.findMany({ where: { partyId: { in: ids }, status: 'ACTIVE' }, select: { id: true, partyId: true, name: true, email: true, phone: true, language: true, roles: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] })
    const rows = await db.distributorNotice.findMany({ where: { registerEntryId: entry.id }, select: NOTICE_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    const views = await distributorViews(db, context, rows)
    const { told, of, allTold } = toldCount(ids, rows)
    const scope = entryScope(entry)
    return {
      entryId: entry.id,
      told,
      of,
      allTold,
      informedAt: iso(entry.distributorsInformedAt),
      recipients: customers.map((customer) => {
        const party = parties.get(customer.partyId)
        const own = views.filter((view) => view.party.id === customer.partyId)
        return {
          party: { id: customer.partyId, code: party?.code ?? customer.code, name: party?.legalName ?? customer.name, language: party?.language ?? 'it' },
          garments: customer.garments,
          shipmentNumbers: [...customer.shipmentNumbers],
          contacts: contacts
            .filter((contact) => contact.partyId === customer.partyId)
            .map((contact) => ({ id: contact.id, name: contact.name, email: contact.email, phone: contact.phone, language: contact.language, quality: contact.roles.includes('QUALITY') })),
          told: own.some((view) => TOLD_STATUSES.includes(view.status)),
          notices: own,
        }
      }),
      others: views.filter((view) => !ids.includes(view.party.id)),
      law: RECALL_LAW.distributors,
      may: { draft: mayOn(context, RECALL_MANAGE, scope) && entry.status === 'OPEN', send: mayOn(context, RECALL_SEND, scope) && entry.status === 'OPEN' },
    }
  })
}

// ---- draft -------------------------------------------------------------------------------------------------------------------

export interface RecipientBody {
  readonly partyId: string
  readonly channel: DraftedChannel
  readonly contactId?: string | undefined
  readonly contactName?: string | undefined
  readonly contact?: string | undefined
  readonly language?: string | undefined
  readonly subject?: string | undefined
  readonly message?: string | undefined
}

export interface DraftDistributorBody {
  readonly recallId?: string | undefined
  readonly recipients?: readonly RecipientBody[] | undefined
  readonly note?: string | undefined
}

interface Planned {
  readonly partyId: string
  readonly channel: DraftedChannel
  readonly contactName: string | null
  readonly contact: string | null
  readonly language: string
  readonly subject: string | null
  readonly message: string
}

/**
 * POST /compliance/register/:entryId/distributor-notices: DRAFT notices, one per recipient. Left out: every recipient of the
 * trace not told yet and without a draft, by e-mail to its quality contact (else its first contact) with an address; one
 * without an address is skipped with the reason.
 */
export async function draftDistributorNotices(caller: CommandCaller, entryId: string, body: DraftDistributorBody, key: string | null | undefined) {
  const context = officeOf(caller)
  const entry = await caller.withClient((db) => visibleEntry(db, context, entryId))
  assertMay(context, RECALL_MANAGE, entryScope(entry), 'Drafting notices to distributors')
  if (entry.status !== 'OPEN') throw new ConflictError(`Register entry ${entry.reference} is closed: distributors are told while it is open.`)
  const skipped: { partyId: string; reason: string }[] = []
  const planned = await caller.withClient(async (db) => {
    let kind: RecallKind | null = null
    if (body.recallId) {
      const recall = await db.recallAction.findUnique({ where: { id: body.recallId }, select: { registerEntryId: true, kind: true, status: true } })
      if (!recall || recall.registerEntryId !== entry.id) throw new ValidationError('The recall is not one of this entry.', [{ path: 'body/recallId', message: 'Choose a recall or withdrawal of this register entry.' }])
      if (recall.status === 'CANCELLED') throw new ValidationError('The recall was cancelled.', [{ path: 'body/recallId', message: 'A cancelled recall is not told to anyone.' }])
      kind = recall.kind
    }
    const facts = await draftFactsOf(db, entry)
    const asked: RecipientBody[] = body.recipients ? [...body.recipients] : []
    if (!body.recipients) {
      const existing = await db.distributorNotice.findMany({ where: { registerEntryId: entry.id, status: { in: ['DRAFT', 'SENT', 'ANSWERED'] } }, select: { partyId: true } })
      const covered = new Set(existing.map((row) => row.partyId))
      for (const customer of await recipientsOfEntry(db, entry)) if (!covered.has(customer.partyId)) asked.push({ partyId: customer.partyId, channel: 'EMAIL' })
      if (asked.length === 0) throw new ConflictError('Every recipient the trace found has a notice already (drafted or sent).')
    }
    const partyIds = [...new Set(asked.map((recipient) => recipient.partyId))]
    const parties = new Map((await db.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, companyId: true, language: true } })).map((party) => [party.id, party]))
    const contacts = await db.partyContact.findMany({ where: { partyId: { in: partyIds }, status: 'ACTIVE' }, select: { id: true, partyId: true, name: true, email: true, phone: true, language: true, roles: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] })
    const problems: Issue[] = []
    const out: Planned[] = []
    asked.forEach((recipient, index) => {
      const at = `body/recipients/${index}`
      const party = parties.get(recipient.partyId)
      if (!party || (party.companyId !== null && party.companyId !== entry.companyId)) {
        problems.push({ path: `${at}/partyId`, message: 'Not a party of this company (or of every company).' })
        return
      }
      const own = contacts.filter((contact) => contact.partyId === recipient.partyId)
      const named = recipient.contactId ? own.find((contact) => contact.id === recipient.contactId) : undefined
      if (recipient.contactId && !named) {
        problems.push({ path: `${at}/contactId`, message: 'Not an active contact of this party.' })
        return
      }
      const fit = (contact: (typeof own)[number]) => (recipient.channel === 'PHONE' ? contact.phone : recipient.channel === 'EMAIL' ? contact.email : contact.email ?? contact.phone)
      const chosen = named ?? own.find((contact) => contact.roles.includes('QUALITY') && fit(contact)) ?? own.find((contact) => fit(contact))
      const contact = recipient.contact?.trim() ?? (chosen ? fit(chosen) : null) ?? null
      if (!body.recipients && contact === null) {
        skipped.push({ partyId: recipient.partyId, reason: 'No active contact with an e-mail address: draft it by hand (a call, the portal) or add the address to the party.' })
        return
      }
      const language = (recipient.language ?? chosen?.language ?? party.language ?? 'it').slice(0, 2).toLowerCase()
      const drafted = draftDistributorMessage(facts, kind, language)
      const plan: Planned = {
        partyId: recipient.partyId,
        channel: recipient.channel,
        contactName: recipient.contactName?.trim() ?? chosen?.name ?? null,
        contact,
        language,
        subject: recipient.subject?.trim() ?? (recipient.channel === 'PHONE' ? null : drafted.subject),
        message: recipient.message ?? drafted.message,
      }
      problems.push(...distributorDraftProblems(plan, at))
      out.push(plan)
    })
    if (problems.length > 0) throw new ValidationError('The notices are not valid.', problems)
    return out
  })
  if (planned.length === 0) throw new DomainError('conflict', 'No recipient could be drafted.', skipped.map((entry, index) => ({ path: `skipped/${index}`, message: entry.reason })))
  const { result } = await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.recall.draftDistributors', idempotencyKey: key, input: { entryId, ...body } },
      async (tools) => {
        const { tx, now, audit } = tools
        const ids: string[] = []
        for (const plan of planned) {
          const id = newId()
          const row = await tx.distributorNotice.create({
            data: { id, companyId: entry.companyId, registerEntryId: entry.id, recallActionId: body.recallId ?? null, ...plan, note: textOrNull(body.note), createdAt: now, updatedAt: now, createdById: context.actorId },
            select: EMIT_SELECT,
          })
          audit({ recordType: 'DistributorNotice', recordId: id, companyId: entry.companyId, after: { entryId: entry.id, recallId: body.recallId ?? null, partyId: plan.partyId, channel: plan.channel, language: plan.language, status: 'DRAFT' } })
          emitNotice(tools, row, 'DRAFTED')
          ids.push(id)
        }
        return { ids }
      },
      settings(),
    ),
  )
  const notices = await caller.withClient(async (db) => distributorViews(db, context, await db.distributorNotice.findMany({ where: { id: { in: result.ids } }, select: NOTICE_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })))
  return { notices, skipped }
}

export interface EditDistributorBody {
  readonly version: number
  readonly channel?: DraftedChannel | undefined
  readonly contactName?: string | null | undefined
  readonly contact?: string | null | undefined
  readonly language?: string | undefined
  readonly subject?: string | null | undefined
  readonly message?: string | undefined
  readonly note?: string | null | undefined
}

/** PATCH /compliance/distributor-notices/:noticeId: a DRAFT reviewed before the send. */
export async function editDistributorNotice(caller: CommandCaller, noticeId: string, body: EditDistributorBody, key: string | null | undefined): Promise<{ notice: DistributorNoticeView }> {
  const context = officeOf(caller)
  const before = await caller.withClient((db) => readNotice(db, context, noticeId))
  assertMay(context, RECALL_MANAGE, { companyId: before.companyId, partyId: before.registerEntry.partyId }, 'Editing a notice to a distributor')
  if (before.status !== 'DRAFT') throw new ConflictError('This notice left (or was cancelled): what was sent never changes; add a note, or send a new one.')
  const after = {
    channel: (body.channel ?? before.channel) as DraftedChannel,
    contactName: body.contactName !== undefined ? textOrNull(body.contactName) : before.contactName,
    contact: body.contact !== undefined ? textOrNull(body.contact) : before.contact,
    language: body.language ?? before.language,
    subject: body.subject !== undefined ? textOrNull(body.subject) : before.subject,
    message: body.message ?? before.message,
  }
  const problems = distributorDraftProblems(after)
  if (problems.length > 0) throw new ValidationError('The notice is not valid.', problems)
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.recall.editDistributor', idempotencyKey: key, input: { noticeId, ...body }, record: { type: 'DistributorNotice', id: noticeId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        const row = await tx.distributorNotice.update({ where: { id: noticeId }, data: { ...after, ...(body.note !== undefined ? { note: textOrNull(body.note) } : {}), updatedAt: now }, select: EMIT_SELECT })
        audit({ recordType: 'DistributorNotice', recordId: noticeId, companyId: before.companyId, before: { channel: before.channel, contactName: before.contactName, contact: before.contact, language: before.language, subject: before.subject }, after: { channel: after.channel, contactName: after.contactName, contact: after.contact, language: after.language, subject: after.subject } })
        emitNotice(tools, row, 'EDITED')
        return {}
      },
      settings(),
    ),
  )
  return noticeAnswer(caller, noticeId)
}

// ---- send ------------------------------------------------------------------------------------------------------------------

const wordsOfChannel: Readonly<Record<DistributorChannel, string>> = Object.freeze({ EMAIL: 'by e-mail', PORTAL: 'in the portal', LINK: 'by a link', PHONE: 'by phone' })

/**
 * The last recipient told: W1's "distributors informed" date (when empty) and a note on the entry's thread naming who was
 * told how, inside the caller's command (the entry's row locked). Answers whether the date was set now.
 */
async function markInformed(tools: CommandTools, entryId: string, at: Date): Promise<boolean> {
  const { tx } = tools
  const locked = await lockEntry(tx, entryId)
  if (locked.status !== 'OPEN' || locked.distributorsInformedAt !== null) return false
  const customers = await recipientsOfEntry(tx, locked)
  const notices = await tx.distributorNotice.findMany({ where: { registerEntryId: entryId, status: { in: [...TOLD_STATUSES] } }, select: { partyId: true, status: true, channel: true, sentAt: true, party: { select: { code: true } } }, orderBy: [{ sentAt: 'asc' }] })
  if (!toldCount(customers.map((customer) => customer.partyId), notices).allTold) return false
  const written = await updateEntry(tools, locked, { distributorsInformedAt: at }, { action: 'compliance.recall.entryDistributorsInformed' })
  const { thread } = await ensureThread(tools, { type: 'PpeRegisterEntry', id: entryId }, tools.context.audience === 'office' ? tools.context.actorId : null)
  if (thread.status === 'OPEN') {
    const lines = notices.map((notice) => `${notice.party.code} ${wordsOfChannel[notice.channel]} on ${notice.sentAt ? businessDate(notice.sentAt) : '?'}`)
    const authorId = tools.context.audience === 'office' ? tools.context.actorId : null
    const author = authorId ? await tx.user.findUnique({ where: { id: authorId }, select: { displayName: true } }) : null
    await writeMessage(tools, thread, {
      direction: 'INTERNAL_NOTE',
      channel: 'APP',
      author: authorId ? { kind: 'USER', id: authorId, name: author?.displayName ?? null } : { kind: 'SYSTEM', id: null, name: null },
      bodyText: cleanBody(`Distributors informed on ${businessDate(at)}: every recipient was told (${lines.join('; ')}).`),
    })
  }
  entryChanged(tools, locked, written, 'DISTRIBUTORS_INFORMED')
  return true
}

/**
 * POST /compliance/register/:entryId/distributor-notices/send (compliance.recall.send, step-up): the DRAFT notices named,
 * each in its own command (an e-mail queued on the notice's thread through the outbox; a call or portal message recorded as
 * made by the person). Then, when every recipient was told, W1's date on the entry.
 */
export async function sendDistributorNotices(caller: CommandCaller, entryId: string, body: { readonly noticeIds: readonly string[]; readonly sentAt?: string | undefined }, options: { readonly stepUp: () => void; readonly idempotencyKey?: string | null | undefined }) {
  const context = officeOf(caller)
  const entry = await caller.withClient((db) => visibleEntry(db, context, entryId))
  assertMay(context, RECALL_SEND, entryScope(entry), 'Sending notices to distributors')
  options.stepUp()
  if (entry.status !== 'OPEN') throw new ConflictError(`Register entry ${entry.reference} is closed: distributors are told while it is open.`)
  const ids = [...new Set(body.noticeIds)]
  const rows = await caller.withClient((db) => db.distributorNotice.findMany({ where: { id: { in: ids } }, select: NOTICE_SELECT }))
  const problems: Issue[] = []
  ids.forEach((id, index) => {
    const row = rows.find((entry) => entry.id === id)
    if (!row || row.registerEntryId !== entryId) problems.push({ path: `body/noticeIds/${index}`, message: 'Not a notice of this register entry.' })
    else if (row.status !== 'DRAFT') problems.push({ path: `body/noticeIds/${index}`, message: `${row.party.code}: this notice is ${row.status}, not a draft.` })
    else if (row.channel === 'LINK') problems.push({ path: `body/noticeIds/${index}`, message: `${row.party.code}: a notice by link is not sent from here.` })
  })
  if (problems.length > 0) throw new ValidationError('Some notices cannot be sent.', problems)
  const user = await caller.withClient((db) => db.user.findUnique({ where: { id: context.actorId }, select: { displayName: true, email: true } }))
  const results: { noticeId: string; sent: boolean; problem: string | null }[] = []
  for (const row of ids.map((id) => rows.find((entry) => entry.id === id)!)) {
    try {
      await guarded(() =>
        runCommand(
          caller,
          { name: 'compliance.recall.sendDistributor', idempotencyKey: options.idempotencyKey ? `${options.idempotencyKey}:${row.id}` : null, input: { entryId, noticeId: row.id, sentAt: body.sentAt ?? null }, record: { type: 'DistributorNotice', id: row.id } },
          async (tools) => {
            const { tx, now, audit } = tools
            const sentAt = row.channel === 'EMAIL' || !body.sentAt ? now : new Date(body.sentAt)
            const issues = metOnProblems(sentAt, entry.reportedAt, now, 'body/sentAt')
            if (issues.length > 0) throw new ValidationError('The date is not valid.', issues)
            const updated = await tx.distributorNotice.update({ where: { id: row.id }, data: { status: 'SENT', sentAt, sentById: context.actorId, updatedAt: now }, select: EMIT_SELECT })
            if (row.channel === 'EMAIL') {
              await sendEmail(tools, {
                record: { type: 'DistributorNotice', id: row.id },
                sender: { userId: context.actorId, name: user?.displayName ?? '', email: user?.email ?? null },
                to: [row.contact!],
                subject: row.subject ?? '',
                body: row.message,
                locale: row.language,
              })
            }
            audit({ recordType: 'DistributorNotice', recordId: row.id, companyId: row.companyId, before: { status: 'DRAFT' }, after: { status: 'SENT', channel: row.channel, sentAt: toUtcIso(sentAt), sentById: context.actorId } })
            emitNotice(tools, updated, 'SENT')
            return {}
          },
          settings(),
        ),
      )
      results.push({ noticeId: row.id, sent: true, problem: null })
    } catch (error) {
      if (!(error instanceof DomainError)) throw error
      const issues = error.issues ?? []
      results.push({ noticeId: row.id, sent: false, problem: issues.length > 0 ? `${error.message} ${issues.map((issue) => issue.message).join(' ')}` : error.message })
    }
  }
  let distributorsInformed = false
  const due = await caller.withClient(async (db) => {
    const now = await visibleEntry(db, context, entryId)
    return now.status === 'OPEN' && now.distributorsInformedAt === null && (await toldOfEntry(db, now)).allTold
  })
  if (due && results.some((entry) => entry.sent)) {
    try {
      await guarded(() =>
        runCommand(
          caller,
          { name: 'compliance.recall.distributorsInformed', idempotencyKey: options.idempotencyKey ? `${options.idempotencyKey}:informed` : null, input: { entryId, noticeIds: ids } },
          async (tools) => {
            if (!(await markInformed(tools, entryId, tools.now))) throw new ConflictError('The entry moved meanwhile.')
            return {}
          },
          settings(),
        ),
      )
      distributorsInformed = true
    } catch (error) {
      // Another person closed the entry or typed the date meanwhile: the notices are sent all the same.
      if (!(error instanceof DomainError && error.code === 'conflict')) throw error
    }
  }
  return caller.withClient(async (db) => {
    const after = await visibleEntry(db, context, entryId)
    const { told, of } = await toldOfEntry(db, after)
    const notices = await distributorViews(db, context, await db.distributorNotice.findMany({ where: { id: { in: ids } }, select: NOTICE_SELECT, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }))
    return { notices, results, distributorsInformed, told, of }
  })
}

// ---- answer, failure, cancel ---------------------------------------------------------------------------------------------

/** POST /compliance/distributor-notices/:noticeId/answer: the distributor's answer taken by hand (a call, a letter). */
export async function answerDistributorNotice(caller: CommandCaller, noticeId: string, body: { readonly version: number; readonly answeredAt?: string | undefined; readonly answer: string; readonly answeredByName?: string | undefined }, key: string | null | undefined): Promise<{ notice: DistributorNoticeView }> {
  const context = officeOf(caller)
  const before = await caller.withClient((db) => readNotice(db, context, noticeId))
  assertMay(context, RECALL_MANAGE, { companyId: before.companyId, partyId: before.registerEntry.partyId }, "Recording a distributor's answer")
  if (before.status !== 'SENT') throw new ConflictError(before.status === 'DRAFT' ? 'Send the notice first: an answer comes after it left.' : `This notice is ${before.status}: it never changes; add a note.`)
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.recall.answerDistributor', idempotencyKey: key, input: { noticeId, ...body }, record: { type: 'DistributorNotice', id: noticeId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        const answeredAt = body.answeredAt ? new Date(body.answeredAt) : now
        const issues = metOnProblems(answeredAt, before.sentAt!, now, 'body/answeredAt')
        if (issues.length > 0) throw new ValidationError('The date is not valid.', issues)
        const row = await tx.distributorNotice.update({ where: { id: noticeId }, data: { status: 'ANSWERED', answeredAt, answer: body.answer.trim(), answeredByName: textOrNull(body.answeredByName), updatedAt: now }, select: EMIT_SELECT })
        audit({ recordType: 'DistributorNotice', recordId: noticeId, companyId: before.companyId, before: { status: 'SENT' }, after: { status: 'ANSWERED', answeredAt: toUtcIso(answeredAt), by: 'person' } })
        emitNotice(tools, row, 'ANSWERED')
        return {}
      },
      settings(),
    ),
  )
  return noticeAnswer(caller, noticeId)
}

/** POST /compliance/distributor-notices/:noticeId/failed: it did not reach them (the number is wrong, nobody answers). A new notice tries again. */
export async function failDistributorNotice(caller: CommandCaller, noticeId: string, body: { readonly version: number; readonly failedAt?: string | undefined; readonly reason: string }, key: string | null | undefined): Promise<{ notice: DistributorNoticeView }> {
  const context = officeOf(caller)
  const before = await caller.withClient((db) => readNotice(db, context, noticeId))
  assertMay(context, RECALL_MANAGE, { companyId: before.companyId, partyId: before.registerEntry.partyId }, 'Recording that a notice did not arrive')
  if (before.status !== 'SENT') throw new ConflictError(before.status === 'DRAFT' ? 'A draft did not leave: cancel it instead.' : `This notice is ${before.status}: it never changes; add a note.`)
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.recall.failDistributor', idempotencyKey: key, input: { noticeId, ...body }, record: { type: 'DistributorNotice', id: noticeId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        const failedAt = body.failedAt ? new Date(body.failedAt) : now
        const issues = metOnProblems(failedAt, before.sentAt!, now, 'body/failedAt')
        if (issues.length > 0) throw new ValidationError('The date is not valid.', issues)
        const reason = body.reason.trim()
        const row = await tx.distributorNotice.update({ where: { id: noticeId }, data: { status: 'FAILED', failedAt, failureReason: reason, updatedAt: now }, select: EMIT_SELECT })
        audit({ recordType: 'DistributorNotice', recordId: noticeId, companyId: before.companyId, before: { status: 'SENT' }, after: { status: 'FAILED', failedAt: toUtcIso(failedAt) }, reason })
        emitNotice(tools, row, 'FAILED')
        return {}
      },
      settings(),
    ),
  )
  return noticeAnswer(caller, noticeId)
}

/** POST /compliance/distributor-notices/:noticeId/cancel: a DRAFT not sent, with why. */
export async function cancelDistributorNotice(caller: CommandCaller, noticeId: string, body: { readonly version: number; readonly reason: string }, key: string | null | undefined): Promise<{ notice: DistributorNoticeView }> {
  const context = officeOf(caller)
  const before = await caller.withClient((db) => readNotice(db, context, noticeId))
  assertMay(context, RECALL_MANAGE, { companyId: before.companyId, partyId: before.registerEntry.partyId }, 'Cancelling a notice to a distributor')
  if (before.status !== 'DRAFT') throw new ConflictError('Only a draft is cancelled: what left stays as it was sent.')
  await guarded(() =>
    runCommand(
      caller,
      { name: 'compliance.recall.cancelDistributor', idempotencyKey: key, input: { noticeId, ...body }, record: { type: 'DistributorNotice', id: noticeId, expectedVersion: body.version } },
      async (tools) => {
        const { tx, now, audit } = tools
        const reason = body.reason.trim()
        const row = await tx.distributorNotice.update({ where: { id: noticeId }, data: { status: 'CANCELLED', cancelledAt: now, cancelReason: reason, updatedAt: now }, select: EMIT_SELECT })
        audit({ recordType: 'DistributorNotice', recordId: noticeId, companyId: before.companyId, before: { status: 'DRAFT' }, after: { status: 'CANCELLED' }, reason })
        emitNotice(tools, row, 'CANCELLED')
        return {}
      },
      settings(),
    ),
  )
  return noticeAnswer(caller, noticeId)
}

// ---- the worker: replies and bounces --------------------------------------------------------------------------------------

export const REPLY_HANDLER = 'compliance.recall.distributorReply'
export const MAIL_HANDLER = 'compliance.recall.distributorMail'

/** A SENT notice moved by the system (a reply recorded, a bounce), in ONE command; any other state is left as it is. */
async function systemMove(caller: CommandCaller, noticeId: string, causationId: string, change: 'ANSWERED' | 'FAILED', data: (row: { sentAt: Date }) => Prisma.DistributorNoticeUncheckedUpdateInput | null): Promise<void> {
  const row = await caller.withClient((db) => db.distributorNotice.findUnique({ where: { id: noticeId }, select: { status: true, sentAt: true, companyId: true } }))
  if (!row || row.status !== 'SENT' || row.sentAt === null) return
  const update = data({ sentAt: row.sentAt })
  if (!update) return
  await guarded(() =>
    runCommand(
      caller,
      { name: change === 'ANSWERED' ? 'compliance.recall.distributorReplied' : 'compliance.recall.distributorBounced', input: { noticeId, causationId }, causationId, record: { type: 'DistributorNotice', id: noticeId } },
      async (tools) => {
        const { tx, now, audit } = tools
        const current = await tx.distributorNotice.findUnique({ where: { id: noticeId }, select: { status: true } })
        if (current?.status !== 'SENT') throw new ConflictError('The notice moved meanwhile.')
        const updated = await tx.distributorNotice.update({ where: { id: noticeId }, data: { ...update, status: change, updatedAt: now }, select: EMIT_SELECT })
        audit({ recordType: 'DistributorNotice', recordId: noticeId, companyId: row.companyId, before: { status: 'SENT' }, after: { status: change, by: 'system' } })
        emitNotice(tools, updated, change)
        return {}
      },
      settings(),
    ),
  ).catch((error: unknown) => {
    // The notice moved meanwhile (a person recorded it, another event did): nothing to do.
    if (error instanceof DomainError && error.code === 'conflict') return
    throw error
  })
}

/** The worker's handlers (background.ts): a reply on a notice's thread is its answer; a bounce or a failed send fails it. */
export function distributorHandlers(): EventHandler[] {
  return [
    defineHandler({
      name: REPLY_HANDLER,
      events: ['thread.message_posted'],
      async handle(event, { caller }) {
        const payload = event.payload as { recordType: string; recordId: string; messageId: string; direction: string }
        if (payload.recordType !== 'DistributorNotice' || payload.direction !== 'INBOUND') return
        const message = await caller.withClient((db) => db.message.findUnique({ where: { id: payload.messageId }, select: { bodyText: true, authorName: true, at: true } }))
        if (!message) return
        await systemMove(caller, payload.recordId, event.eventId, 'ANSWERED', ({ sentAt }) => ({
          answeredAt: message.at.getTime() < sentAt.getTime() ? sentAt : message.at,
          answer: (message.bodyText.trim() || '(an empty reply)').slice(0, RECALL_LIMITS.answer),
          answeredByName: message.authorName?.trim() ? message.authorName.trim().slice(0, RECALL_LIMITS.answeredByName) : null,
        }))
      },
    }),
    defineHandler({
      name: MAIL_HANDLER,
      events: ['email.status_changed'],
      async handle(event, { caller }) {
        const payload = event.payload as { recordType: string | null; recordId: string | null; status: string }
        if (payload.recordType !== 'DistributorNotice' || payload.recordId === null || (payload.status !== 'BOUNCED' && payload.status !== 'FAILED')) return
        const at = new Date(event.occurredAt)
        await systemMove(caller, payload.recordId, event.eventId, 'FAILED', ({ sentAt }) => ({
          failedAt: at.getTime() < sentAt.getTime() ? sentAt : at,
          failureReason: payload.status === 'BOUNCED' ? 'The e-mail bounced: the address does not take mail. Send a new notice another way.' : 'The e-mail could not be sent after every try. Send a new notice.',
        }))
      },
    }),
  ]
}

export type { DistributorStatus }
