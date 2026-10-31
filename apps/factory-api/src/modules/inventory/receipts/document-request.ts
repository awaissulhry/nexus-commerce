import { DomainError, ForbiddenError, InvalidStateError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import type { DocumentLanguage } from '@nexus/factory-domain/documents/model'
import { DOCUMENT_REQUEST_LIMITS, documentRequestMail, wantedDocuments, type WantedDocument } from '@nexus/factory-domain/inventory/receipts/document-request'
import { INVENTORY_RECEIPT_DOCUMENTS_REQUEST } from '@nexus/factory-domain/inventory/receipts/permissions'
import { supplierLanguageOf } from '@nexus/factory-domain/purchasing/orders'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { sendEmail } from '../../../platform/email-out/outbound'
import { holdsOf, visibleReceipt } from './read'
import { byId, ddtPhotosOf, ids, LOT_COLUMNS, type Reader, type ReceiptRow } from './store'

/**
 * "Request from supplier" on a receipt's Documents check (B-W2a-F4; Owner answer 1A, 2026-10-30: one narrow route and
 * permission, NOT email.send for the warehouse; design warehouse.receipts rec "Documents check"):
 *
 *   GET  /inventory/receipts/:receiptId/documents/request?language=   inventory.receipts.documents.request: what the
 *        request would send now — the documents the lots wait for, the supplier's contacts with an e-mail (QUALITY,
 *        then ORDERS first, `suggested`), the language, the standard subject and text, and why it cannot go yet
 *   POST /inventory/receipts/:receiptId/documents/request              inventory.receipts.documents.request:
 *        {contactIds, documents?, language?, note?}
 *
 * Narrow on purpose: the recipients are only the receipt's supplier's own active contacts with an e-mail, named by id
 * (no free address, no copy); the text is factory-domain inventory/receipts/document-request's standard mail in the
 * supplier's language naming the documents asked (each one the receipt still waits for; default all of them) plus an
 * optional short note (DOCUMENT_REQUEST_LIMITS.note); no subject of one's own, no attachment. It goes on the receipt's
 * thread through email out (`sendEmail` inside ONE command: the OUTBOUND message, the EmailOutbound QUEUED, its audit
 * and email.queued; the worker delivers, FAKE SES off Railway), so the supplier's answer lands on the receipt. A repeated
 * Idempotency-Key answers the first send (no second mail). Refused in words: a receipt reversed or cancelled, nothing
 * missing, a document not missing, a contact that is not the supplier's (or has no e-mail), a supplier with no contact
 * with an e-mail, a note too long.
 */

type Language = DocumentLanguage

/** The receipt's facts the request reads: what is missing, the supplier, its contacts with an e-mail. */
async function requestFacts(db: Reader, receipt: ReceiptRow) {
  const lines = await db.goodsReceiptLine.findMany({ where: { receiptId: receipt.id }, select: { id: true, itemId: true } })
  const items = byId(await db.item.findMany({ where: { id: { in: ids(lines.map((line) => line.itemId)) } }, select: { id: true, isPpeComponent: true } }))
  const itemOfLine = new Map(lines.map((line) => [line.id, line.itemId]))
  const lots = await db.lot.findMany({ where: { receiptLineId: { in: lines.map((line) => line.id) } }, select: LOT_COLUMNS, orderBy: { code: 'asc' } })
  const photos = await ddtPhotosOf(db, receipt.id)
  const wanted = wantedDocuments(
    { supplierDdtNumber: receipt.supplierDdtNumber, ddtPhotoCount: photos.length },
    lots.map((lot) => ({
      id: lot.id,
      code: lot.code,
      supplierLotRef: lot.supplierLotRef,
      dyeBatch: lot.dyeBatch,
      qualityStatus: lot.qualityStatus,
      crViStatus: lot.crViStatus,
      holds: holdsOf(lot, items.get(itemOfLine.get(lot.receiptLineId ?? '') ?? '')?.isPpeComponent ?? false),
    })),
  )
  const party = await db.party.findUniqueOrThrow({ where: { id: receipt.supplierId }, select: { id: true, legalName: true, language: true } })
  const contacts = await db.partyContact.findMany({ where: { partyId: party.id, status: 'ACTIVE', email: { not: null } }, select: { id: true, name: true, email: true, roles: true, language: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] })
  const rank = (roles: readonly string[]) => (roles.includes('QUALITY') ? 0 : roles.includes('ORDERS') ? 1 : 2)
  return { wanted, party, contacts: [...contacts].sort((a, b) => rank(a.roles) - rank(b.roles)) }
}

/** A receipt takes a request while it is open or posted (a reversed or cancelled one waits for nothing). */
const receiptProblem = (receipt: Pick<ReceiptRow, 'status' | 'number'>): string | null =>
  receipt.status === 'OPEN' || receipt.status === 'POSTED' ? null : `${receipt.number} is ${receipt.status === 'REVERSED' ? 'reversed' : 'cancelled'}: it waits for no document.`

const NOTHING_MISSING = 'Nothing is missing: the lots of this receipt wait for no document and its delivery note is recorded.'
const noContact = (supplier: string) => `${supplier} has no active contact with an e-mail: add one to the supplier first.`

const supplierDdtDay = (receipt: ReceiptRow) => (receipt.supplierDdtDate ? businessDate(receipt.supplierDdtDate, 'UTC') : null)

/** The receipt as the caller may ask for it: the permission over its company and site, and over its supplier. */
async function requestableReceipt(caller: CommandCaller, receiptId: string) {
  const { context, receipt } = await visibleReceipt(caller, receiptId, INVENTORY_RECEIPT_DOCUMENTS_REQUEST)
  if (context.audience === 'office' && !can(actorOf(context), INVENTORY_RECEIPT_DOCUMENTS_REQUEST, { companyId: receipt.companyId, siteId: receipt.siteId, partyId: receipt.supplierId })) throw new ForbiddenError()
  return { context: context as OfficeContext, receipt }
}

/** GET /inventory/receipts/:receiptId/documents/request: what the request would send now, and why it cannot yet. */
export async function documentRequestCheck(caller: CommandCaller, receiptId: string, query: { readonly language?: Language | undefined }) {
  const { receipt } = await requestableReceipt(caller, receiptId)
  const facts = await caller.withClient((client) => requestFacts(client, receipt))
  const suggested = facts.contacts[0] ?? null
  const language = query.language ?? supplierLanguageOf(suggested?.language ?? null, facts.party.language)
  const mail = documentRequestMail({ language, receiptNumber: receipt.number, supplierDdtNumber: receipt.supplierDdtNumber, supplierDdtDate: supplierDdtDay(receipt), asked: facts.wanted })
  const stateProblem = receiptProblem(receipt)
  const problems: Issue[] = [
    ...(stateProblem ? [{ path: 'receipt', message: stateProblem }] : []),
    ...(facts.wanted.length === 0 ? [{ path: 'documents', message: NOTHING_MISSING }] : []),
    ...(facts.contacts.length === 0 ? [{ path: 'contactIds', message: noContact(facts.party.legalName) }] : []),
  ]
  return {
    ready: problems.length === 0,
    problems,
    receipt: { id: receipt.id, number: receipt.number, status: receipt.status, supplierDdtNumber: receipt.supplierDdtNumber, supplierDdtDate: supplierDdtDay(receipt) },
    wanted: facts.wanted,
    recipients: facts.contacts.map((contact) => ({ contactId: contact.id, name: contact.name, email: contact.email!, roles: contact.roles, language: contact.language, suggested: contact.id === suggested?.id })),
    language,
    subject: mail.subject,
    body: mail.body,
  }
}

export interface DocumentRequestBody {
  /** The supplier's contacts that get it (active, with an e-mail): no other address. */
  readonly contactIds: readonly string[]
  /** The documents asked for, by WantedDocument key (each one the receipt still waits for); default every one. */
  readonly documents?: readonly string[] | undefined
  readonly language?: Language | undefined
  /** A short note of one's own, set under the list. */
  readonly note?: string | null | undefined
}

/** POST /inventory/receipts/:receiptId/documents/request: the standard mail to the supplier's contacts (see the module comment). */
export async function requestDocuments(caller: CommandCaller, receiptId: string, body: DocumentRequestBody, idempotencyKey?: string) {
  const { context, receipt } = await requestableReceipt(caller, receiptId)
  const stateProblem = receiptProblem(receipt)
  if (stateProblem) throw new InvalidStateError(stateProblem)
  const facts = await caller.withClient((client) => requestFacts(client, receipt))
  if (facts.wanted.length === 0) throw new DomainError('conflict', NOTHING_MISSING, [{ path: 'documents', message: NOTHING_MISSING }])
  if (facts.contacts.length === 0) throw new DomainError('conflict', noContact(facts.party.legalName), [{ path: 'contactIds', message: noContact(facts.party.legalName) }])

  const problems: Issue[] = []
  // The recipients: only the supplier's own active contacts with an e-mail, by id.
  const contacts = [...new Set(body.contactIds)].flatMap((contactId, index) => {
    const contact = isUuid(contactId) ? facts.contacts.find((entry) => entry.id === contactId) : undefined
    if (!contact) problems.push({ path: `body/contactIds/${index}`, message: `Not an active contact of ${facts.party.legalName} with an e-mail.` })
    return contact ? [contact] : []
  })
  if (body.contactIds.length === 0) problems.push({ path: 'body/contactIds', message: 'Choose who gets the request.' })
  if (contacts.length > DOCUMENT_REQUEST_LIMITS.recipients) problems.push({ path: 'body/contactIds', message: `At most ${DOCUMENT_REQUEST_LIMITS.recipients} recipients.` })
  // The documents: each one the receipt still waits for.
  const keys = body.documents === undefined ? facts.wanted.map((entry) => entry.key) : [...new Set(body.documents)]
  const asked: WantedDocument[] = []
  keys.forEach((key, index) => {
    const entry = facts.wanted.find((wanted) => wanted.key === key)
    if (entry) asked.push(entry)
    else problems.push({ path: `body/documents/${index}`, message: 'Not a document this receipt still waits for.' })
  })
  if (keys.length === 0) problems.push({ path: 'body/documents', message: 'Choose what to ask for.' })
  const note = body.note?.trim() ? body.note.trim() : null
  if (note && note.length > DOCUMENT_REQUEST_LIMITS.note) problems.push({ path: 'body/note', message: `A note holds at most ${DOCUMENT_REQUEST_LIMITS.note} characters.` })
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)

  const first = contacts[0]!
  const language = body.language ?? supplierLanguageOf(first.language, facts.party.language)
  // In the order the receipt lists them (the person's ticks may come in any order).
  const ordered = facts.wanted.filter((entry) => asked.includes(entry))
  const mail = documentRequestMail({ language, receiptNumber: receipt.number, supplierDdtNumber: receipt.supplierDdtNumber, supplierDdtDate: supplierDdtDay(receipt), asked: ordered, note })
  const plan = { to: contacts.map((contact) => contact.email!), language, subject: mail.subject, body: mail.body, documents: ordered.map((entry) => entry.key), note: note !== null }

  const { result } = await command(caller, { name: 'inventory.requestReceiptDocuments', idempotencyKey, input: { receiptId, ...body } }, async (tools) => requestInCommand(tools, receipt, context, plan))
  return result
}

interface RequestPlan {
  readonly to: readonly string[]
  readonly language: Language
  readonly subject: string
  readonly body: string
  readonly documents: readonly string[]
  readonly note: boolean
}

async function requestInCommand(tools: CommandTools, receipt: ReceiptRow, context: OfficeContext, plan: RequestPlan) {
  const { tx, now } = tools
  // A reversal that raced the request: it no longer waits for anything.
  const current = await tx.goodsReceipt.findUnique({ where: { id: receipt.id }, select: { status: true, number: true } })
  const stateProblem = current ? receiptProblem(current) : 'The receipt is gone.'
  if (stateProblem) throw new InvalidStateError(stateProblem)
  const user = await tx.user.findUnique({ where: { id: context.actorId }, select: { displayName: true, email: true } })
  const sent = await sendEmail(tools, {
    record: { type: 'GoodsReceipt', id: receipt.id },
    sender: { userId: context.actorId, name: user?.displayName ?? 'Magazzino', email: user?.email ?? null },
    to: [...plan.to],
    subject: plan.subject,
    body: plan.body,
    locale: plan.language,
  })
  tools.audit({
    action: 'inventory.receiptDocumentsRequested',
    recordType: 'GoodsReceipt',
    recordId: receipt.id,
    companyId: receipt.companyId,
    siteId: receipt.siteId,
    after: { documents: [...plan.documents], recipients: plan.to.length, language: plan.language, note: plan.note, outboundId: sent.outbound.id, messageId: sent.messageId },
  })
  return {
    request: { emailId: sent.outbound.id, threadId: sent.thread.id, messageId: sent.messageId, to: [...plan.to], language: plan.language, subject: plan.subject, documents: [...plan.documents], status: sent.outbound.status, sentAt: toUtcIso(now) },
  }
}
