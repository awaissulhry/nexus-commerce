import { parseCc } from '../../../_shared/document-send/model'
import type { Phrase } from '../model'
import type { KeptPdfs, PdfLanguage } from './api'

/**
 * The price list PDF kept for mail on the print page (B-W2b-380, XF6:01; design tab pricelists.pdf "Sent to a customer or
 * printed for a fair"): the kept PDFs of the version shown (newest first, whether the newest still shows the version as it
 * is), Keep this version as a PDF (in Italian or English), Open one, Send… (to, copies, subject, message; the newest showing
 * the version as it is goes, kept first when none does). Pure: the words are `prices-followups` keys; held buttons say why.
 */

export type Tone = 'success' | 'warning' | 'danger' | 'info'

export interface SendDraft {
  /** The customer it goes to (one of the list's customers). */
  partyId: string
  to: string
  cc: string
  subject: string
  message: string
  sending: boolean
  /** The send refused, in words. */
  problem: Phrase | null
  /** Sent: to whom, when (an ISO instant). */
  sent: { to: string; at: string } | null
}

export interface KeptPdfModel {
  can: { manage: boolean; price: boolean }
  /** The list's customers: the mail goes to one of them (on its thread). */
  customers: readonly { id: string; code: string; legalName: string }[]
  /** `none`: the list has no version to print. */
  read: { status: 'loading' } | { status: 'none' } | { status: 'error'; problem: Phrase } | { status: 'ready'; value: KeptPdfs }
  language: PdfLanguage
  busy: boolean
  notice: { tone: Tone; words: Phrase } | null
  /** The Send dialog, open. */
  send: SendDraft | null
}

export const emptySend = (partyId = ''): SendDraft => ({ partyId, to: '', cc: '', subject: '', message: '', sending: false, problem: null, sent: null })

/** Why Keep this version as a PDF cannot run now (a Phrase), or null. */
export function keepHeld(model: Pick<KeptPdfModel, 'can' | 'read' | 'busy'>): Phrase | null {
  if (!model.can.price) return { key: 'pdf.held.noPrice' }
  if (!model.can.manage) return { key: 'pdf.held.noManage' }
  if (model.read.status === 'none') return { key: 'pdf.held.noVersion' }
  if (model.read.status !== 'ready') return { key: 'pdf.held.loading' }
  if (model.busy) return { key: 'pdf.held.busy' }
  return null
}

/** Why Send… cannot open (a Phrase), or null: as Keep; a list of every company has no company to send from; no customer has it. */
export function sendOpenHeld(model: Pick<KeptPdfModel, 'can' | 'read' | 'busy' | 'customers'>): Phrase | null {
  const held = keepHeld(model)
  if (held) return held
  if (model.read.status === 'ready' && model.read.value.needsCompany) return { key: 'pdf.held.everyCompany' }
  if (model.customers.length === 0) return { key: 'pdf.held.noCustomer' }
  return null
}

/** The addresses typed (to or copies): the valid ones (at most 10), the ones that are not addresses. */
export const addressesOf = (text: string): { valid: string[]; invalid: string[] } => parseCc(text)

/** Why Send cannot run in the dialog (a Phrase), or null. */
export function sendHeld(draft: SendDraft): Phrase | null {
  if (draft.sent) return { key: 'pdf.sendHeld.sent' }
  if (draft.sending) return { key: 'pdf.held.busy' }
  if (!draft.partyId) return { key: 'pdf.sendHeld.customer' }
  // Empty: the customer's own contact (the API's default).
  const to = addressesOf(draft.to)
  if (to.invalid.length > 0) return { key: 'pdf.sendHeld.bad', params: { list: to.invalid.join(', ') } }
  const cc = addressesOf(draft.cc)
  if (cc.invalid.length > 0) return { key: 'pdf.sendHeld.bad', params: { list: cc.invalid.join(', ') } }
  if (draft.subject.length > 200) return { key: 'pdf.sendHeld.subject' }
  return null
}

/** The body the send route takes. */
export function sendBody(draft: SendDraft, language: PdfLanguage): { partyId: string; to?: string[]; cc?: string[]; subject?: string | null; message?: string | null; language: PdfLanguage } {
  const to = addressesOf(draft.to).valid
  const cc = addressesOf(draft.cc).valid
  return {
    partyId: draft.partyId,
    ...(to.length > 0 ? { to } : {}),
    ...(cc.length > 0 ? { cc } : {}),
    ...(draft.subject.trim() ? { subject: draft.subject.trim() } : {}),
    ...(draft.message.trim() ? { message: draft.message.trim() } : {}),
    language,
  }
}
