import { InvalidStateError, ValidationError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { sendEmail } from '../../../platform/email-out/outbound'
import { normaliseVisibility } from '../../../platform/files/rules'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { readInvoice, type Reader } from '../store'
import { readSend } from './store'

/**
 * The courtesy copy of an invoice SDI could not deliver (FIN-088; Provv. AdE 89757/2018: the seller tells the customer
 * the invoice is in their reserved area of the tax agency's site and may send them a copy). The worker's handler
 * `invoicing.sdiCourtesyCopy`, on invoice.sdi_status_changed when the invoice became NOT_DELIVERABLE, in ONE command
 * (its Idempotency-Key fixed per send: a redelivered event sends nothing twice): the PDF courtesy copy is shared with the
 * customer (the invoice's party), then e-mailed through email out (`sendEmail` on the invoice's thread: the customer's
 * active contacts for invoices, as the person who sent the invoice to SDI, from the company's conversation address,
 * the PDF attached), and the invoice's audit row names the mail (`readCopies`). When it cannot be sent (no contact with
 * an address, nobody to send it as, no PDF, no sending address for the company, a suppressed address …) a second
 * command records why (invoice.courtesy_copy_missing), the SDI tab says so, and a person sends it from the thread
 * (POST /threads/Invoice/:id/emails, email.send).
 */

export const COPY_ACTION = 'invoices.sdiCourtesyCopy'
export const COPY_MISSING_ACTION = 'invoices.sdiCourtesyCopyMissing'

export interface CourtesyCopies {
  readonly queued: { readonly emailId: string; readonly status: string; readonly queuedAt: string }[]
  /** Why the automatic copy could not be sent, when none went out. */
  readonly missing: string | null
}

/** The courtesy copies e-mailed for an invoice (its audit rows, joined to the mails), and why one was missing. */
export async function readCopies(db: Reader, invoiceId: string): Promise<CourtesyCopies> {
  const rows = await db.auditLog.findMany({ where: { recordType: 'Invoice', recordId: invoiceId, action: { in: [COPY_ACTION, COPY_MISSING_ACTION] } }, select: { action: true, after: true, at: true }, orderBy: { at: 'asc' } })
  const ids = rows.filter((row) => row.action === COPY_ACTION).flatMap((row) => {
    const id = (row.after as { outboundId?: unknown } | null)?.outboundId
    return typeof id === 'string' ? [id] : []
  })
  const mails = ids.length > 0 ? await db.emailOutbound.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, queuedAt: true }, orderBy: { queuedAt: 'asc' } }) : []
  const missing = rows.filter((row) => row.action === COPY_MISSING_ACTION).at(-1)
  return {
    queued: mails.map((mail) => ({ emailId: mail.id, status: mail.status, queuedAt: toUtcIso(mail.queuedAt) })),
    missing: mails.length === 0 && missing ? String((missing.after as { reason?: unknown } | null)?.reason ?? 'not sent') : null,
  }
}

const TEXT = {
  it: (number: string, date: string, fileName: string) => ({
    subject: `Fattura n. ${number} del ${date}: copia di cortesia`,
    body:
      `Gentile cliente,\n\nil Sistema di Interscambio (SDI) dell'Agenzia delle Entrate non ha potuto recapitare la fattura n. ${number} del ${date} (file ${fileName}) al Suo indirizzo telematico.\n\n` +
      "La fattura è comunque emessa ed è a Sua disposizione nella Sua area riservata del sito dell'Agenzia delle Entrate (Fatture e Corrispettivi).\n\n" +
      'In allegato una copia di cortesia in PDF, che non sostituisce la fattura elettronica.',
  }),
  en: (number: string, date: string, fileName: string) => ({
    subject: `Invoice ${number} of ${date}: courtesy copy`,
    body:
      `Dear customer,\n\nthe Italian tax agency's exchange system (SDI) could not deliver invoice ${number} of ${date} (file ${fileName}) to your electronic address.\n\n` +
      "The invoice is issued all the same and is available in your reserved area of the tax agency's website (Fatture e Corrispettivi).\n\n" +
      'Attached is a courtesy copy as a PDF; it does not replace the electronic invoice.',
  }),
} as const

const dateText = (day: string, language: 'it' | 'en'): string => (language === 'it' ? `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}` : day)

/** Shares the invoice's PDF with its customer (the partner audience and its party key), inside the command. */
async function shareWithParty(tools: CommandTools, fileId: string, partyId: string): Promise<void> {
  const file = await tools.tx.storedFile.findUniqueOrThrow({ where: { id: fileId }, select: { visibility: true, partyId: true, floorSiteId: true, companyId: true } })
  if (file.partyId === partyId && file.visibility.includes('PARTNER')) return
  const visibility = normaliseVisibility([...file.visibility, 'PARTNER'])
  await tools.tx.storedFile.update({ where: { id: fileId }, data: { visibility, partyId, version: { increment: 1 } }, select: { id: true } })
  tools.audit({ action: 'files.setVisibility', recordType: 'StoredFile', recordId: fileId, companyId: file.companyId, before: { visibility: file.visibility, floorSiteId: file.floorSiteId, partyId: file.partyId }, after: { visibility, floorSiteId: file.floorSiteId, partyId } })
}

/** Sends (queues) the courtesy copy of an invoice that SDI could not deliver, or records why it could not. */
export async function sendCourtesyCopy(caller: CommandCaller, invoiceId: string, submissionId: string, causationId?: string): Promise<'queued' | 'missing'> {
  const facts = await caller.withClient(async (client) => {
    const invoice = await readInvoice(client, invoiceId)
    if (!invoice) return null
    const send = await readSend(client, submissionId)
    const contacts = await client.partyContact.findMany({ where: { partyId: invoice.buyerPartyId, status: 'ACTIVE', roles: { has: 'INVOICES' }, email: { not: null } }, select: { email: true, language: true }, orderBy: { name: 'asc' } })
    const party = await client.party.findUnique({ where: { id: invoice.buyerPartyId }, select: { language: true } })
    const senderId = send?.createdById ?? invoice.issuedById
    const sender = senderId ? await client.user.findUnique({ where: { id: senderId }, select: { id: true, displayName: true, email: true, status: true } }) : null
    return { invoice, send, contacts, language: contacts[0]?.language ?? party?.language ?? 'it', sender: sender?.status === 'ACTIVE' ? sender : null }
  })
  if (!facts) return 'missing'
  const { invoice } = facts
  let problem: string | null =
    facts.contacts.length === 0
      ? 'The customer has no active contact for invoices with an e-mail address.'
      : facts.sender === null
        ? 'Nobody to send it as: the person who sent the invoice to SDI is not an active user.'
        : invoice.pdfFileId === null
          ? 'The invoice has no PDF copy yet.'
          : null
  if (problem === null) {
    const language = facts.language === 'en' ? 'en' : 'it'
    const text = TEXT[language](invoice.number ?? '', dateText(invoice.issueDate!.toISOString().slice(0, 10), language), facts.send?.fileName ?? '')
    try {
      await command(caller, { name: COPY_ACTION, idempotencyKey: `sdi-copy.${submissionId}`, input: { invoiceId, submissionId }, ...(causationId ? { causationId } : {}) }, async (tools) => {
        await shareWithParty(tools, invoice.pdfFileId!, invoice.buyerPartyId)
        const sent = await sendEmail(tools, {
          record: { type: 'Invoice', id: invoiceId },
          sender: { userId: facts.sender!.id, name: facts.sender!.displayName, email: facts.sender!.email },
          to: [...new Set(facts.contacts.map((contact) => contact.email!))],
          subject: text.subject,
          body: text.body,
          attachments: [invoice.pdfFileId!],
          locale: language,
        })
        tools.audit({ action: COPY_ACTION, recordType: 'Invoice', recordId: invoiceId, companyId: invoice.companyId, after: { submissionId, outboundId: sent.outbound.id, recipients: sent.outbound.to.length } })
        tools.emit({ type: 'invoice.courtesy_copy_queued', subject: invoiceId, companyId: invoice.companyId, payload: { invoiceId, submissionId, outboundId: sent.outbound.id } })
        return { outboundId: sent.outbound.id }
      })
      return 'queued'
    } catch (error) {
      if (!(error instanceof ValidationError || error instanceof InvalidStateError)) throw error
      problem = `${error.message}${error.issues && error.issues.length > 0 ? ` ${error.issues.map((issue) => issue.message).join(' ')}` : ''}`.slice(0, 500)
    }
  }
  await command(caller, { name: COPY_MISSING_ACTION, idempotencyKey: `sdi-copy-missing.${submissionId}`, input: { invoiceId, submissionId }, ...(causationId ? { causationId } : {}) }, async (tools) => {
    tools.audit({ action: COPY_MISSING_ACTION, recordType: 'Invoice', recordId: invoiceId, companyId: invoice.companyId, after: { submissionId, reason: problem } })
    tools.emit({ type: 'invoice.courtesy_copy_missing', subject: invoiceId, companyId: invoice.companyId, payload: { invoiceId, submissionId, reason: problem! } })
    return { missing: true }
  })
  return 'missing'
}

/** The worker's handler: on invoice.sdi_status_changed into NOT_DELIVERABLE. Listed in background.ts HANDLERS. */
export function sdiCourtesyCopyHandler(): EventHandler {
  return defineHandler({
    name: 'invoicing.sdiCourtesyCopy',
    events: ['invoice.sdi_status_changed'],
    attempts: 5,
    async handle(event, { caller }) {
      const payload = event.payload as { invoiceId: string; submissionId: string; invoiceStatus: string; previousStatus: string }
      if (payload.invoiceStatus !== 'NOT_DELIVERABLE' || payload.previousStatus === 'NOT_DELIVERABLE') return
      await sendCourtesyCopy(caller, payload.invoiceId, payload.submissionId, event.eventId)
    },
  })
}
