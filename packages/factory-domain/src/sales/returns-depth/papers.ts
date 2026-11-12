import type { BusinessDate } from '../../core/time'
import { formatDate } from '../../documents/format'
import type { DocumentLanguage } from '../../documents/model'
import type { FreightPayer } from '../returns/rules'

/**
 * The RMA papers (B-W2b-341; SAL-346 "Scannable code on RMA papers"; design floor.returnsin "The RMA sheet or box label opens
 * the right return"), pure: one A4 sheet the office prints or sends once a return is authorised, with the RMA's scan code
 * as a Code 128 barcode (and as text a person can type) at the top, what comes back with its serial and lot, by when, who
 * pays the transport, the policy's conditions and, for a consumer's withdrawal, its words; and at the foot the box label to
 * cut out and stick on the parcel, with the same barcode, the RMA number and where it goes. The dock's "Scan the return"
 * reads the code (GET /sales/returns/dock?code=). Painted by the API (modules/sales/returns-depth/sheet-pdf.ts).
 *
 * No price, no internal note, no cause: what the customer already knows of its return.
 */

export interface PapersInput {
  readonly language: DocumentLanguage
  readonly date: BusinessDate
  readonly company: { readonly name: string; readonly lines: readonly string[]; readonly legal: string }
  readonly number: string
  readonly scanCode: string
  readonly customer: { readonly name: string; readonly reference: string | null }
  /** Where the goods go back: the site's name and its address in one line (null: ask us). */
  readonly sendTo: { readonly name: string; readonly address: string | null }
  readonly authorisedOn: BusinessDate | null
  readonly goodsDueBy: BusinessDate | null
  readonly freightPaidBy: FreightPayer | null
  readonly lines: readonly { readonly seq: number; readonly description: string; readonly size: string | null; readonly quantity: number; readonly serial: string | null; readonly lot: string | null }[]
  /** The policy it was checked against (its name), when one is named. */
  readonly policyName: string | null
  readonly conditions: string | null
  /** A consumer's withdrawal (Codice del Consumo art. 52): the policy's words, as typed (the lawyer's to confirm). */
  readonly withdrawal: { readonly words: string | null } | null
}

export interface PapersTable {
  readonly columns: readonly { readonly label: string; readonly width: number; readonly align: 'left' | 'right' }[]
  readonly rows: readonly (readonly string[])[]
}

export interface RmaPapers {
  readonly language: DocumentLanguage
  readonly meta: { readonly title: string; readonly subject: string; readonly createdAt: string }
  readonly title: string
  readonly company: PapersInput['company']
  readonly number: string
  readonly scanCode: string
  /** Under the barcode: what it is. */
  readonly scanHint: string
  readonly facts: readonly { readonly label: string; readonly value: string }[]
  readonly sections: readonly { readonly heading: string; readonly lines: readonly string[]; readonly table: PapersTable | null }[]
  /** The box label at the foot (cut out, stick on the parcel). */
  readonly label: { readonly heading: string; readonly cut: string; readonly lines: readonly string[] }
  readonly page: (page: number, pages: number) => string
  readonly fileName: string
}

const WORDS = {
  it: {
    title: 'Autorizzazione al reso',
    number: 'Reso',
    customer: 'Cliente',
    yourRef: 'Vs. riferimento',
    authorised: 'Autorizzato il',
    due: 'Da spedire entro',
    noDue: 'Nessuna scadenza',
    date: 'Data',
    policy: 'Condizioni applicate',
    scanHint: 'Codice da scansionare al ricevimento',
    content: 'Cosa torna',
    item: 'Articolo',
    size: 'Taglia',
    pieces: 'Pezzi',
    serial: 'Matricola',
    lot: 'Lotto',
    sendTo: 'Spedire a',
    askUs: 'Indirizzo da concordare: scriveteci prima di spedire.',
    write: (number: string) => `Mettete questo foglio nel pacco e applicate l'etichetta qui sotto all'esterno. Senza ${number} il pacco non può essere riconosciuto.`,
    freight: 'Trasporto',
    freightBy: { CUSTOMER: 'Il trasporto è a carico vostro.', COMPANY: 'Il trasporto è a carico nostro: chiedeteci il ritiro o il vettore da usare.', BY_CAUSE: 'Il trasporto è a carico di chi ha causato il reso: se il difetto è nostro, lo rimborsiamo.' },
    noFreight: 'Per il trasporto seguite le condizioni concordate.',
    conditions: 'Condizioni di reso',
    withdrawal: 'Recesso del consumatore (Codice del Consumo, art. 52)',
    noWithdrawalWords: 'Il reso è un recesso del consumatore: le condizioni del recesso vi sono state comunicate con l’ordine.',
    labelHeading: 'Etichetta del pacco',
    cut: 'Ritagliate e applicate sul pacco',
    page: (page: number, pages: number) => `Pagina ${page} di ${pages}`,
    file: 'reso',
  },
  en: {
    title: 'Return authorisation',
    number: 'Return',
    customer: 'Customer',
    yourRef: 'Your reference',
    authorised: 'Authorised on',
    due: 'Send it by',
    noDue: 'No deadline',
    date: 'Date',
    policy: 'Terms applied',
    scanHint: 'Code scanned when it arrives',
    content: 'What comes back',
    item: 'Item',
    size: 'Size',
    pieces: 'Pieces',
    serial: 'Serial',
    lot: 'Lot',
    sendTo: 'Send to',
    askUs: 'Address to agree: write to us before you send it.',
    write: (number: string) => `Put this sheet in the parcel and stick the label below on the outside. Without ${number} the parcel cannot be recognised.`,
    freight: 'Transport',
    freightBy: { CUSTOMER: 'You pay the transport back.', COMPANY: 'We pay the transport back: ask us for the pick-up or the carrier to use.', BY_CAUSE: 'Whoever caused the return pays the transport: if the fault is ours, we refund it.' },
    noFreight: 'For the transport, follow the terms agreed.',
    conditions: 'Return conditions',
    withdrawal: "The consumer's withdrawal (Codice del Consumo, art. 52)",
    noWithdrawalWords: "This return is a consumer's withdrawal: its terms were given to you with the order.",
    labelHeading: 'Parcel label',
    cut: 'Cut out and stick on the parcel',
    page: (page: number, pages: number) => `Page ${page} of ${pages}`,
    file: 'return',
  },
} as const

export function rmaPapers(input: PapersInput): RmaPapers {
  const w = WORDS[input.language]
  const day = (date: BusinessDate) => formatDate(date, input.language)
  const facts = [
    { label: w.number, value: input.number },
    { label: w.customer, value: input.customer.name },
    ...(input.customer.reference ? [{ label: w.yourRef, value: input.customer.reference }] : []),
    ...(input.authorisedOn ? [{ label: w.authorised, value: day(input.authorisedOn) }] : []),
    { label: w.due, value: input.goodsDueBy ? day(input.goodsDueBy) : w.noDue },
    ...(input.policyName ? [{ label: w.policy, value: input.policyName }] : []),
    { label: w.date, value: day(input.date) },
  ]
  const sections: RmaPapers['sections'] = [
    {
      heading: w.content,
      lines: [],
      table: {
        columns: [
          { label: '#', width: 0.07, align: 'right' },
          { label: w.item, width: 0.39, align: 'left' },
          { label: w.size, width: 0.1, align: 'left' },
          { label: w.pieces, width: 0.09, align: 'right' },
          { label: w.serial, width: 0.18, align: 'left' },
          { label: w.lot, width: 0.17, align: 'left' },
        ],
        rows: input.lines.map((line) => [String(line.seq), line.description, line.size ?? '-', String(line.quantity), line.serial ?? '-', line.lot ?? '-']),
      },
    },
    { heading: w.sendTo, lines: [input.sendTo.name, input.sendTo.address ?? w.askUs, w.write(input.number)], table: null },
    { heading: w.freight, lines: [input.freightPaidBy ? w.freightBy[input.freightPaidBy] : w.noFreight], table: null },
    ...(input.conditions && input.conditions.trim() !== '' ? [{ heading: w.conditions, lines: input.conditions.trim().split(/\n{2,}/), table: null }] : []),
    ...(input.withdrawal ? [{ heading: w.withdrawal, lines: input.withdrawal.words && input.withdrawal.words.trim() !== '' ? input.withdrawal.words.trim().split(/\n{2,}/) : [w.noWithdrawalWords], table: null }] : []),
  ]
  return {
    language: input.language,
    meta: { title: `${w.title} ${input.number}`, subject: `${w.title} ${input.number}`, createdAt: `${input.date}T00:00:00.000Z` },
    title: w.title,
    company: input.company,
    number: input.number,
    scanCode: input.scanCode,
    scanHint: w.scanHint,
    facts,
    sections,
    label: {
      heading: w.labelHeading,
      cut: w.cut,
      lines: [`${w.number} ${input.number}`, `${w.sendTo}: ${input.sendTo.name}`, input.sendTo.address ?? w.askUs, ...(input.goodsDueBy ? [`${w.due}: ${day(input.goodsDueBy)}`] : [])],
    },
    page: w.page,
    fileName: `${w.file}-${input.number}.pdf`,
  }
}
