import { ForbiddenError, InvalidStateError } from '@nexus/factory-domain/core/errors'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import type { PostalAddress } from '@nexus/factory-domain/documents/model'
import { letterDocument } from '@nexus/factory-domain/receivables/documents'
import type { EffectiveSettings } from '@nexus/factory-domain/receivables/ladder'
import { daysBetween } from '@nexus/factory-domain/receivables/ledger'
import { claimLine, claimNow, type OpenInvoice } from '@nexus/factory-domain/receivables/reminders'
import { reminderLanguageOf } from '@nexus/factory-domain/receivables/wording'
import type { CommandCaller } from '../../core/command'
import { companyLegalOf } from '../../platform/documents/documents'
import { renderDocumentPdf } from '../../platform/documents/pdf'
import { putGeneratedFile, type PreparedGeneratedFile } from '../../platform/files/files'
import { processFiles } from '../../platform/files/service'
import { RECEIVABLES_VIEW } from '@nexus/factory-domain/receivables/permissions'
import { holdsPrice, knownReminderOf, officeContextOf, officeReminder, openInvoices, refused, settingsFor, today, type ReminderRow } from './store'

/**
 * The reminder letter (a LETTER step of the ladder; B-W2a-55): the approved text with its invoices, on the company's
 * letterhead (factory-domain receivables/documents letterDocument, painted by platform/documents pdf.ts). When the
 * reminder is sent, the PDF is stored on the reminder (StoredFile DOCUMENT of record PaymentReminder, office only: it is
 * printed and posted); before that `GET /receivables/reminders/:id/pdf` shows it inline, stored nowhere.
 */

/** An inline Content-Disposition for a PDF shown in the browser (ASCII name and the UTF-8 one). */
export function inlineDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

/** A party address row as the documents print it. */
export function addressOf(value: unknown): PostalAddress | null {
  if (!value || typeof value !== 'object') return null
  const row = value as { line1?: unknown; line2?: unknown; postalCode?: unknown; city?: unknown; province?: unknown; country?: unknown }
  if (typeof row.line1 !== 'string' || typeof row.postalCode !== 'string' || typeof row.city !== 'string' || typeof row.country !== 'string') return null
  return { line1: row.line1, line2: typeof row.line2 === 'string' ? row.line2 : null, postalCode: row.postalCode, city: row.city, province: typeof row.province === 'string' ? row.province : null, country: row.country }
}

async function letterBytes(caller: CommandCaller, row: ReminderRow, text: { readonly subject: string | null; readonly body: string | null }, settings: EffectiveSettings, on: BusinessDate) {
  if (!text.subject?.trim() || !text.body?.trim()) throw refused('NO_TEXT')
  const facts = await caller.withClient(async (db) => {
    const party = await db.party.findUniqueOrThrow({ where: { id: row.partyId }, select: { code: true, legalName: true } })
    const address = await db.partyAddress.findFirst({ where: { partyId: row.partyId, status: 'ACTIVE' }, orderBy: [{ isDefaultBillTo: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }], select: { line1: true, line2: true, postalCode: true, city: true, province: true, country: true } })
    const identity = await db.partyTaxIdentity.findFirst({ where: { partyId: row.partyId }, orderBy: [{ validFrom: 'desc' }, { createdAt: 'desc' }], select: { vatNumber: true, country: true } })
    const open = await openInvoices(db, { invoiceIds: row.invoiceIds, asOf: on })
    return { party, address, identity, open }
  })
  const byId = new Map<string, OpenInvoice>(facts.open.map((invoice) => [invoice.id, invoice]))
  const known = knownReminderOf(row)
  if (claimNow(known, byId, settings.ladder) !== row.amountDue) throw refused('CHANGED')
  const offset = known.byHand ? null : (settings.ladder.find((step) => step.level === row.level)?.offsetDays ?? null)
  const lines = row.invoiceIds
    .map((id) => byId.get(id))
    .filter((invoice): invoice is OpenInvoice => invoice !== undefined)
    .map((invoice) => claimLine(invoice, offset, known.preparedOn, { mode: 'NONE', agreedPct: null }))
    .filter((line) => line !== null)
    .map((line) => ({ number: line.number, issueDate: line.issueDate, dueDate: line.dueDate, claimed: line.claimed, daysLate: daysBetween(line.dueDate, on) }))
  const vat = facts.identity?.vatNumber ? (/^[A-Z]{2}/.test(facts.identity.vatNumber) ? facts.identity.vatNumber : `${facts.identity.country}${facts.identity.vatNumber}`) : null
  const composed = letterDocument({
    language: reminderLanguageOf(row.language),
    company: await companyLegalOf(caller, row.companyId),
    customer: { name: facts.party.legalName, code: facts.party.code, address: addressOf(facts.address), vatNumber: vat },
    currency: row.currency,
    level: row.level,
    action: row.action,
    subject: text.subject.trim(),
    body: text.body.trim(),
    lines,
    amountDue: row.amountDue,
    interestAmount: row.interestAmount,
    printedOn: on,
  })
  return { pdf: await renderDocumentPdf(composed), fileName: `${composed.meta.title.replace(/[\\/]/g, '-')}.pdf` }
}

/** The letter's PDF put in the store (outside any transaction), for the send command to record on the reminder. */
export async function letterPdf(caller: CommandCaller, row: ReminderRow, text: { readonly subject: string | null; readonly body: string | null }, settings: EffectiveSettings, on: BusinessDate): Promise<PreparedGeneratedFile> {
  const { pdf, fileName } = await letterBytes(caller, row, text, settings, on)
  return putGeneratedFile(processFiles(), caller, { companyId: row.companyId, recordType: 'PaymentReminder', recordId: row.id, kind: 'DOCUMENT', originalName: fileName, contentType: 'application/pdf', body: pdf })
}

/** GET /receivables/reminders/:id/pdf (receivables.view + the price grain): a LETTER's PDF as it would print now. */
export async function letterPreview(caller: CommandCaller, reminderId: string) {
  const context = officeContextOf(caller)
  const row = await officeReminder(caller, reminderId, RECEIVABLES_VIEW, RECEIVABLES_VIEW)
  if (!holdsPrice(context)) throw new ForbiddenError('A reminder letter shows invoice amounts: it needs the price grain.')
  if (row.action !== 'LETTER') throw new InvalidStateError('Only a reminder sent as a letter has a PDF; an e-mail shows its text, a call its notes.')
  if (row.status !== 'PREPARED' && row.status !== 'APPROVED') throw new InvalidStateError('This letter is no longer waiting: a sent letter is the PDF stored on the reminder (letterFileId).')
  const settings = await caller.withClient((db) => settingsFor(db, row.companyId))
  return letterBytes(caller, row, row, settings, today())
}
