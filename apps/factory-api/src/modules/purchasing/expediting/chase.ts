import { InvalidStateError, ValidationError } from '@nexus/factory-domain/core/errors'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { purchaseOrderDocumentNumber } from '@nexus/factory-domain/purchasing/document'
import { chaseMail, chaseProblem, MAX_CHASE_MESSAGE, type ChaseLine } from '@nexus/factory-domain/purchasing/expediting/worklist'
import { supplierLanguageOf } from '@nexus/factory-domain/purchasing/orders'
import { PURCHASING_SEND } from '@nexus/factory-domain/purchasing/permissions'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { sendEmail } from '../../../platform/email-out/outbound'
import { detailInCommand, onOrder } from '../orders'
import { officeContextOf, officeOrder, readOrder, senderOf, type OrderRow, type Reader } from '../store'
import { namesOf, workLinesOf, type WorkLine } from './lines'

/**
 * Chase a supplier (B-W2b-305; SCM-068; design purchasing.orders pop "Chase Conceria Alfa": "Lines late or unconfirmed;
 * e-mail in their language (preview)"; W2a-52: "its chase is Remind until W2b's Chase"): a mail on the order's thread to
 * its ACTIVE contact, in the supplier's language, naming the lines on the expediting worklist (late, not confirmed in
 * time, confirmed later than needed) with their days; no link (a bearer token kept nowhere) and no price. The worker sends
 * it (email out; FAKE in local and test).
 *
 *   GET  /purchasing/orders/:purchaseOrderId/chase?language    purchasing.view: the preview (or why there is nothing to chase)
 *   POST /purchasing/orders/:purchaseOrderId/chase {version, lineIds?, message?}    purchasing.send: ONE command on the order
 */

async function chaseFacts(db: Reader, order: OrderRow, today: string, now: Date) {
  const read = await workLinesOf(db, [{ id: order.id }], today, now)
  // In the order's own order (line number), as the supplier reads its order.
  const chased = read.lines.filter((line) => line.reasons.length > 0).sort((a, b) => a.seq - b.seq)
  const lines = await db.purchaseOrderLine.findMany({ where: { id: { in: chased.map((line) => line.lineId) } }, select: { id: true, supplierArticleCode: true } })
  const codes = new Map(lines.map((line) => [line.id, line.supplierArticleCode]))
  const names = await namesOf(db, chased, [order.partyId])
  const contact = order.contactId ? await db.partyContact.findUnique({ where: { id: order.contactId }, select: { id: true, name: true, email: true, language: true, status: true } }) : null
  const party = await db.party.findUniqueOrThrow({ where: { id: order.partyId }, select: { language: true } })
  const labelOf = (line: WorkLine): string => {
    const item = names.items.get(line.itemId)
    const colour = line.itemColourId ? names.colours.get(line.itemColourId) : undefined
    return `Line ${line.seq} · ${[codes.get(line.lineId) ?? item?.code, item?.name, colour?.name].filter(Boolean).join(' ')}`
  }
  return { chased, contact, language: supplierLanguageOf(contact?.language, party.language), labelOf }
}

const chaseLineOf = (line: WorkLine, label: string): ChaseLine => ({ label, needDate: line.nextDelivery?.needDate ?? line.needDate, confirmedDate: line.nextDelivery?.confirmedDate ?? line.confirmedDate, reasons: line.reasons })

/** GET …/chase: the lines it would chase and the mail as it would go. */
export async function chasePreview(caller: CommandCaller, orderId: string, language?: 'it' | 'en') {
  const order = await officeOrder(caller, orderId)
  const now = serverClock.now()
  return caller.withClient(async (client) => {
    const facts = await chaseFacts(client, order, businessDate(now), now)
    const mailLanguage = language ?? facts.language
    const lines = facts.chased.map((line) => ({ lineId: line.lineId, seq: line.seq, label: facts.labelOf(line), needDate: line.needDate, confirmedDate: line.confirmedDate, expectedDate: line.expectedDate, daysLate: line.daysLate, confirmedLaterBy: line.confirmedLaterBy, reasons: line.reasons }))
    const problem = chaseProblem(order.status, lines.length) ?? (!facts.contact?.email || facts.contact.status !== 'ACTIVE' ? 'Choose an active contact with an e-mail: the chase goes to them.' : null)
    const mail = chaseMail({ language: mailLanguage, number: purchaseOrderDocumentNumber(order.number, order.revision), recipientName: facts.contact?.name ?? null, lines: facts.chased.map((line) => chaseLineOf(line, facts.labelOf(line))), message: null })
    return {
      chase: {
        orderId: order.id,
        version: order.version,
        allowed: problem === null,
        why: problem,
        lines,
        recipient: facts.contact ? { contactId: facts.contact.id, name: facts.contact.name, email: facts.contact.email } : null,
        language: mailLanguage,
        subject: mail.subject,
        body: mail.body,
      },
    }
  })
}

export interface ChaseBody {
  readonly version: number
  /** Some of the lines it would chase; none: all of them. */
  readonly lineIds?: readonly string[] | undefined
  readonly message?: string | null | undefined
}

/** POST …/chase: the mail to the supplier, in ONE command on the order (its version guards it). */
export async function chaseSupplier(caller: CommandCaller, orderId: string, body: ChaseBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId, PURCHASING_SEND)
  const message = body.message?.trim() ? body.message.trim() : null
  if (message !== null && message.length > MAX_CHASE_MESSAGE) throw new ValidationError('The message is too long.', [{ path: 'body/message', message: `At most ${MAX_CHASE_MESSAGE} characters.` }])
  return onOrder(caller, order, { name: 'purchasing.chase', idempotencyKey, input: { orderId, ...body }, version: body.version }, async (tools, current) => {
    const facts = await chaseFacts(tools.tx, (await readOrder(tools.tx, current.id))!, businessDate(tools.now), tools.now)
    const named = body.lineIds ? [...body.lineIds] : null
    if (named) {
      const unknown = named.findIndex((id) => !facts.chased.some((line) => line.lineId === id))
      if (unknown >= 0) throw new ValidationError('Not a line of this order to chase: it is not late, unconfirmed or confirmed later than needed.', [{ path: `body/lineIds/${unknown}`, message: 'Not a line to chase.' }])
    }
    const chosen = named ? facts.chased.filter((line) => named.includes(line.lineId)) : facts.chased
    const problem = chaseProblem(current.status, chosen.length)
    if (problem) throw new InvalidStateError(problem)
    if (!facts.contact?.email || facts.contact.status !== 'ACTIVE') throw new InvalidStateError('Choose an active contact with an e-mail: the chase goes to them.')
    const mail = chaseMail({ language: facts.language, number: purchaseOrderDocumentNumber(current.number, current.revision), recipientName: facts.contact.name, lines: chosen.map((line) => chaseLineOf(line, facts.labelOf(line))), message })
    const sent = await sendEmail(tools, { record: { type: 'PurchaseOrder', id: current.id }, sender: await senderOf(tools.tx, context), to: [facts.contact.email], subject: mail.subject, body: mail.body, locale: facts.language })
    const lineIds = chosen.map((line) => line.lineId)
    tools.audit({ action: 'purchasing.chase', recordType: 'PurchaseOrder', recordId: current.id, companyId: current.companyId, siteId: current.siteId, after: { lineIds, reasons: chosen.map((line) => ({ lineId: line.lineId, reasons: line.reasons })), to: facts.contact.email, outboundId: sent.outbound.id, language: facts.language } })
    tools.emit({ type: 'purchase_order.chased', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { purchaseOrderId: current.id, number: current.number, lineIds, outboundId: sent.outbound.id } })
    return { ...(await detailInCommand(tools, current.id)), chase: { lineIds, to: facts.contact.email, emailId: sent.outbound.id, sentAt: toUtcIso(tools.now), language: facts.language } }
  })
}
