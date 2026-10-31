import type { BusinessDate } from '../../core/time'
import { formatDate } from '../../documents/format'
import type { DocumentLanguage } from '../../documents/model'

/**
 * Asking the supplier for a receipt's missing documents (B-W2a-F4; Owner answer 1A, 2026-10-30; design warehouse.receipts
 * rec "Documents check" → "Request from supplier"), pure: which documents a delivery still waits for, from what the
 * receipt and its lots know, and the standard mail that asks for them, in the supplier's language (Italian or English).
 * apps/factory-api's modules/inventory/receipts/document-request.ts sends it (one narrow action: the supplier's own
 * contacts, this text plus a short note, no attachment); the screens draw the same text as the preview. No price, no
 * internal note, no other person's name (Owner answer C2).
 */

export const DOCUMENT_ASKS = ['CR_VI_REPORT', 'PPE_CERTIFICATE', 'DELIVERY_NOTE'] as const
export type DocumentAsk = (typeof DOCUMENT_ASKS)[number]

/** A note in the person's own words beside the standard text; recipients among the supplier's contacts. */
export const DOCUMENT_REQUEST_LIMITS = Object.freeze({ note: 500, recipients: 5 })

/** What a lot tells about its documents (the receipt's lots read: its quality state, its Cr VI result, its holds). */
export interface RequestLot {
  readonly id: string
  readonly code: string
  readonly supplierLotRef: string | null
  readonly dyeBatch: string | null
  readonly qualityStatus: string
  /** planning/usable CR_VI_STATUSES. */
  readonly crViStatus: string | null
  /** inventory/receipts/rules HOLD_REASONS. */
  readonly holds: readonly string[]
}

export interface WantedDocument {
  /** `${lotId}:${ask}`, or `receipt:DELIVERY_NOTE`. */
  readonly key: string
  readonly ask: DocumentAsk
  readonly lot: { readonly id: string; readonly code: string; readonly supplierLotRef: string | null; readonly dyeBatch: string | null } | null
}

/**
 * The documents this delivery still waits for: a lot in quarantine for its chromium VI result wants the supplier's test
 * report; a lot of a certified PPE component in quarantine, its certificate; a receipt with no DDT number and no photo
 * of it, the supplier's delivery note. (The full per-lot documents list is Compliance › Tests & substances'.)
 */
export function wantedDocuments(receipt: { readonly supplierDdtNumber: string | null; readonly ddtPhotoCount: number }, lots: readonly RequestLot[]): WantedDocument[] {
  const wanted: WantedDocument[] = []
  for (const lot of lots) {
    if (lot.qualityStatus !== 'QUARANTINE') continue
    const ref = { id: lot.id, code: lot.code, supplierLotRef: lot.supplierLotRef, dyeBatch: lot.dyeBatch }
    if (lot.holds.includes('CR_VI_TEST') && lot.crViStatus === 'PENDING') wanted.push({ key: `${lot.id}:CR_VI_REPORT`, ask: 'CR_VI_REPORT', lot: ref })
    if (lot.holds.includes('PPE_CERTIFICATE')) wanted.push({ key: `${lot.id}:PPE_CERTIFICATE`, ask: 'PPE_CERTIFICATE', lot: ref })
  }
  if (!receipt.supplierDdtNumber && receipt.ddtPhotoCount === 0) wanted.push({ key: 'receipt:DELIVERY_NOTE', ask: 'DELIVERY_NOTE', lot: null })
  return wanted
}

const WORDS = {
  it: {
    subject: (receipt: string, ddt: string | null) => `Documenti mancanti — ${ddt ? `vostro DDT ${ddt}, ` : ''}nostro ricevimento ${receipt}`,
    hello: 'Buongiorno,',
    intro: (receipt: string, ddt: string | null, date: string | null) => `per la merce ricevuta${ddt ? ` con il vostro DDT ${ddt}${date ? ` del ${date}` : ''}` : ''} (nostro ricevimento ${receipt}) ci mancano i seguenti documenti:`,
    CR_VI_REPORT: 'il rapporto di prova del cromo esavalente (Cr VI)',
    PPE_CERTIFICATE: 'il certificato del componente DPI',
    DELIVERY_NOTE: 'una copia del documento di trasporto (DDT)',
    lot: (code: string, ref: string | null, dye: string | null) => ` — lotto ${ref ? `vostro ${ref}, ` : ''}${dye ? `bagno ${dye}, ` : ''}nostro ${code}`,
    quarantine: 'I lotti restano in quarantena finché non li riceviamo.',
    reply: 'Potete rispondere a questa e-mail allegandoli.',
    thanks: 'Grazie e cordiali saluti',
  },
  en: {
    subject: (receipt: string, ddt: string | null) => `Missing documents — ${ddt ? `your delivery note ${ddt}, ` : ''}our receipt ${receipt}`,
    hello: 'Hello,',
    intro: (receipt: string, ddt: string | null, date: string | null) => `for the goods we received${ddt ? ` with your delivery note ${ddt}${date ? ` of ${date}` : ''}` : ''} (our receipt ${receipt}) we are missing these documents:`,
    CR_VI_REPORT: 'the hexavalent chromium (Cr VI) test report',
    PPE_CERTIFICATE: 'the certificate of the PPE component',
    DELIVERY_NOTE: 'a copy of the delivery note (DDT)',
    lot: (code: string, ref: string | null, dye: string | null) => ` — lot ${ref ? `your ${ref}, ` : ''}${dye ? `dye batch ${dye}, ` : ''}our ${code}`,
    quarantine: 'The lots stay in quarantine until we have them.',
    reply: 'You can answer this e-mail with the documents attached.',
    thanks: 'Thank you and kind regards',
  },
} as const

export interface DocumentRequestMailInput {
  readonly language: DocumentLanguage
  readonly receiptNumber: string
  readonly supplierDdtNumber: string | null
  readonly supplierDdtDate: BusinessDate | null
  /** The documents asked for (a non-empty part of wantedDocuments), in that order. */
  readonly asked: readonly WantedDocument[]
  /** The person's own short note, set under the list (trimmed; empty = none). */
  readonly note?: string | null | undefined
}

/** The request's subject and text: the standard words in the supplier's language, the documents asked, the note. */
export function documentRequestMail(input: DocumentRequestMailInput): { readonly subject: string; readonly body: string } {
  const words = WORDS[input.language]
  const date = input.supplierDdtDate ? formatDate(input.supplierDdtDate, input.language) : null
  const lines = input.asked.map((entry) => `- ${words[entry.ask]}${entry.lot ? words.lot(entry.lot.code, entry.lot.supplierLotRef, entry.lot.dyeBatch) : ''}`)
  const note = input.note?.trim() ? input.note.trim() : null
  const closing = input.asked.some((entry) => entry.lot !== null) ? `${words.quarantine} ${words.reply}` : words.reply
  return {
    subject: words.subject(input.receiptNumber, input.supplierDdtNumber),
    body: [words.hello, '', words.intro(input.receiptNumber, input.supplierDdtNumber, date), ...lines, ...(note ? ['', note] : []), '', closing, '', words.thanks].join('\n'),
  }
}
