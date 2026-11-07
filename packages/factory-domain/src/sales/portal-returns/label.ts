import type { BusinessDate } from '../../core/time'
import { formatDate } from '../../documents/format'
import type { DocumentLanguage } from '../../documents/model'
import type { EightDCompany, EightDReport, EightDSection } from '../../quality/capa/report'

/**
 * The return instructions (B-W2b-192; design portal.customer.returns new tab "Return label PDF", rec Return › Status "Return
 * label and instructions (PDF)"), pure: one A4 page the customer prints and puts in or on the parcel once the office
 * authorised the return — where it goes, by when, the RMA number to write on the parcel, what goes in it, who pays the
 * transport. It is laid out as the factory's letters are (quality/capa/report's EightDReport: letterhead, facts, sections),
 * painted by the API's documents. It is not a carrier's label: a prepaid carrier label needs the carrier's returns service
 * (a later step); these are the instructions and the address label to stick on the parcel.
 *
 * No price, no internal note, no cause: what the customer already knows of its own request.
 */

export interface InstructionsInput {
  readonly language: DocumentLanguage
  readonly date: BusinessDate
  readonly company: EightDCompany
  readonly number: string
  readonly customer: { readonly name: string; readonly reference: string | null }
  /** Where the goods go back: the site's name and its address in one line (null: ask us). */
  readonly sendTo: { readonly name: string; readonly address: string | null }
  readonly goodsDueBy: BusinessDate | null
  /** Who pays the transport back, as the policy says (null: not said). */
  readonly freightPaidBy: 'CUSTOMER' | 'COMPANY' | 'BY_CAUSE' | null
  readonly lines: readonly { readonly seq: number; readonly description: string; readonly size: string | null; readonly quantity: number; readonly serial: string | null }[]
  /** The return conditions the policy prints (the company's words). */
  readonly conditions: string | null
}

const WORDS = {
  it: {
    title: 'Istruzioni di reso',
    number: 'Reso',
    customer: 'Cliente',
    yourRef: 'Vs. riferimento',
    date: 'Data',
    due: 'Da spedire entro',
    label: 'Etichetta da applicare sul pacco',
    sendTo: 'Spedire a',
    askUs: 'Indirizzo da concordare: scriveteci prima di spedire.',
    write: (number: string) => `Scrivete ${number} in modo ben visibile sul pacco e mettete una copia di questa pagina all'interno.`,
    content: 'Cosa mettere nel pacco',
    item: 'Articolo',
    size: 'Taglia',
    pieces: 'Pezzi',
    serial: 'Matricola',
    freight: 'Trasporto',
    freightBy: { CUSTOMER: 'Il trasporto è a carico vostro.', COMPANY: 'Il trasporto è a carico nostro: chiedeteci il ritiro o il vettore da usare.', BY_CAUSE: 'Il trasporto è a carico di chi ha causato il reso: se il difetto è nostro, lo rimborsiamo.' },
    noFreight: 'Per il trasporto seguite le condizioni concordate.',
    conditions: 'Condizioni di reso',
    page: (page: number, pages: number) => `Pagina ${page} di ${pages}`,
    file: 'istruzioni-reso',
  },
  en: {
    title: 'Return instructions',
    number: 'Return',
    customer: 'Customer',
    yourRef: 'Your reference',
    date: 'Date',
    due: 'Send it by',
    label: 'Label to put on the parcel',
    sendTo: 'Send to',
    askUs: 'Address to agree: write to us before you send it.',
    write: (number: string) => `Write ${number} clearly on the parcel and put a copy of this page inside.`,
    content: 'What goes in the parcel',
    item: 'Item',
    size: 'Size',
    pieces: 'Pieces',
    serial: 'Serial',
    freight: 'Transport',
    freightBy: { CUSTOMER: 'You pay the transport back.', COMPANY: 'We pay the transport back: ask us for the pick-up or the carrier to use.', BY_CAUSE: 'Whoever caused the return pays the transport: if the fault is ours, we refund it.' },
    noFreight: 'For the transport, follow the terms agreed.',
    conditions: 'Return conditions',
    page: (page: number, pages: number) => `Page ${page} of ${pages}`,
    file: 'return-instructions',
  },
} as const

export function returnInstructions(input: InstructionsInput): EightDReport {
  const w = WORDS[input.language]
  const day = (date: BusinessDate) => formatDate(date, input.language)
  const facts = [
    { label: w.number, value: input.number },
    { label: w.customer, value: input.customer.name },
    ...(input.customer.reference ? [{ label: w.yourRef, value: input.customer.reference }] : []),
    ...(input.goodsDueBy ? [{ label: w.due, value: day(input.goodsDueBy) }] : []),
    { label: w.date, value: day(input.date) },
  ]
  const sections: EightDSection[] = [
    {
      heading: w.label,
      lines: [`${w.sendTo}: ${input.sendTo.name}`, input.sendTo.address ?? w.askUs, `${w.number} ${input.number}`, w.write(input.number)],
      table: null,
    },
    {
      heading: w.content,
      lines: [],
      table: {
        columns: [
          { label: '#', width: 0.07, align: 'right' },
          { label: w.item, width: 0.5, align: 'left' },
          { label: w.size, width: 0.12, align: 'left' },
          { label: w.pieces, width: 0.1, align: 'right' },
          { label: w.serial, width: 0.21, align: 'left' },
        ],
        rows: input.lines.map((line) => [String(line.seq), line.description, line.size ?? '-', String(line.quantity), line.serial ?? '-']),
      },
    },
    { heading: w.freight, lines: [input.freightPaidBy ? w.freightBy[input.freightPaidBy] : w.noFreight], table: null },
    ...(input.conditions && input.conditions.trim() !== '' ? [{ heading: w.conditions, lines: input.conditions.trim().split(/\n{2,}/), table: null }] : []),
  ]
  return {
    language: input.language,
    meta: { title: `${w.title} ${input.number}`, subject: `${w.title} ${input.number}`, createdAt: `${input.date}T00:00:00.000Z` },
    title: w.title,
    sample: null,
    company: input.company,
    facts,
    sections,
    page: w.page,
    fileName: `${w.file}-${input.number}.pdf`,
  }
}
