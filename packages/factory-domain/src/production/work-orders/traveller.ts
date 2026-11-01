import type { BusinessDate } from '../../core/time'
import { formatDate, formatDateTime, formatDecimal } from '../../documents/format'
import type { DocumentLanguage } from '../../documents/model'
import type { WorkOrderKind, WorkOrderStatus } from './machine'

/**
 * The work order traveller (B-W2b-51; MES-014 "Printable traveller (paper fallback)"; design production.workorders tab
 * wo-tab-traveller "Traveller PDF with QR: the paper fallback that travels with the work", h.more "Print travellers",
 * Documents tab "traveller PDF with QR"; floor.hidecut, floor.bundles, floor.pick "Scan the work order traveller"),
 * composed here and painted by the API (modules/production/work-orders traveller.ts) on A4 with pdfkit: every word in
 * the paper's language, every number formatted. Pure and deterministic (the same work order and moment give the same
 * paper).
 *
 *   QR        the work order's number (`WO-00042`): the floor's scan reads it as typed text and finds the work order of
 *             the device's site (the cutting table, bundles, pick and labels all look a work order up by its number), so
 *             the paper opens the same screens as the tablet. Upper-case letters, digits and `-` fit QR's alphanumeric mode.
 *   header    the number, the batch number, the rush flag (a box in words: URGENTE / RUSH) and a banner when the floor
 *             must not start it (a draft, a held, cancelled or finished work order).
 *   facts     style and revision, site, due date, priority, pieces, colourways, the order numbers it makes (never a
 *             customer's name or a price: the paper goes round the floor), the work order it was split from.
 *   tables    the size run (colourway × size, totals); the operations with empty columns to write by hand when the
 *             tablet is down (done, scrap, date, station: per operation and station, never a person — Statuto dei
 *             Lavoratori art. 4); the planned materials (no cost).
 */

export interface TravellerColumn {
  readonly label: string
  /** Share of the table's width, per mille. */
  readonly width: number
  readonly align: 'left' | 'right' | 'center'
}

export interface TravellerTable {
  readonly title: string
  readonly columns: readonly TravellerColumn[]
  readonly rows: readonly (readonly string[])[]
  /** A last row in bold (the size run's totals), or null. */
  readonly total: readonly string[] | null
  /** What the table says when it has no row. */
  readonly empty: string
}

export interface TravellerFact {
  readonly label: string
  readonly value: string
}

/** What the API's painter prints for one work order (one or more pages; several travellers make one PDF). */
export interface TravellerPaper {
  readonly language: DocumentLanguage
  readonly title: string
  readonly number: string
  /** The text of the QR code. */
  readonly qr: string
  readonly batch: string | null
  /** The rush flag's words, or null. */
  readonly rush: string | null
  /** Why the floor must not start it (a draft, held, cancelled or finished work order), or null. */
  readonly banner: string | null
  readonly facts: readonly TravellerFact[]
  readonly tables: readonly TravellerTable[]
  readonly notes: readonly string[]
  readonly footer: { readonly printed: string; readonly page: string; readonly continued: string }
  readonly meta: { readonly title: string; readonly subject: string; readonly createdAt: string }
}

/** The work order as the traveller prints it (names already read by the API). */
export interface TravellerFacts {
  readonly number: string
  readonly batchNumber: string | null
  readonly status: WorkOrderStatus
  readonly kind: WorkOrderKind
  readonly rush: boolean
  readonly priority: number
  readonly dueDate: BusinessDate | null
  readonly site: { readonly code: string; readonly name: string }
  readonly style: { readonly code: string; readonly name: string }
  readonly revision: number | null
  /** The sales order numbers its cells make. */
  readonly orders: readonly string[]
  /** The number of the work order it was split from, or null. */
  readonly splitFrom: string | null
  readonly note: string | null
  /** While ON_HOLD: why. */
  readonly holdReason: string | null
  readonly releasedAt: Date | null
  /** The style's sizes in their order (the size run's columns). */
  readonly sizes: readonly string[]
  readonly cells: readonly { readonly colourway: string; readonly size: string; readonly quantity: number }[]
  /** From RELEASED on: the frozen spec; a draft: what the release would freeze now. */
  readonly frozen: boolean
  readonly operations: readonly { readonly seq: number; readonly code: string; readonly name: string; readonly workCentre: string | null; readonly standardMinutes: string; readonly scanRequired: boolean }[]
  readonly materials: readonly { readonly code: string; readonly name: string; readonly colour: string | null; readonly planned: string; readonly uom: string }[]
  /** When it is printed, in the site's time zone. */
  readonly printedAt: Date
  readonly timeZone: string
}

const STATUS_WORDS: Readonly<Record<DocumentLanguage, Readonly<Record<WorkOrderStatus, string>>>> = {
  it: { DRAFT: 'Bozza', RELEASED: 'Rilasciato', IN_PROGRESS: 'In lavorazione', COMPLETED: 'Completato', CLOSED: 'Chiuso', CANCELLED: 'Annullato', ON_HOLD: 'In sospeso' },
  en: { DRAFT: 'Draft', RELEASED: 'Released', IN_PROGRESS: 'In progress', COMPLETED: 'Completed', CLOSED: 'Closed', CANCELLED: 'Cancelled', ON_HOLD: 'On hold' },
}

const WORDS = {
  it: {
    title: 'Foglio di lavorazione',
    batch: 'Lotto',
    rush: 'URGENTE',
    facts: {
      status: 'Stato',
      style: 'Modello',
      revision: 'Revisione',
      site: 'Stabilimento',
      due: 'Consegna',
      noDue: 'non indicata',
      priority: 'Priorità',
      pieces: 'Capi',
      colourways: 'Varianti colore',
      orders: 'Ordini',
      splitFrom: 'Diviso da',
      released: 'Rilasciato il',
    },
    banner: {
      DRAFT: 'BOZZA - non ancora rilasciato: il lavoro inizia solo dopo il rilascio dell\'ufficio.',
      ON_HOLD: (reason: string | null) => `IN SOSPESO${reason ? `: ${reason}` : ''}. Non iniziare il lavoro.`,
      CANCELLED: 'ANNULLATO: non lavorare questo ordine.',
      COMPLETED: 'COMPLETATO: solo per consultazione.',
      CLOSED: 'CHIUSO: solo per consultazione.',
    },
    sizes: { title: 'Taglie e quantità', colourway: 'Colore', total: 'Totale', empty: 'Nessuna taglia.' },
    operations: {
      title: 'Fasi di lavorazione',
      seq: 'Fase',
      code: 'Codice',
      name: 'Lavorazione',
      centre: 'Centro',
      minutes: 'Min. std',
      scan: 'Scans.',
      done: 'Capi fatti',
      scrap: 'Scarti',
      date: 'Data',
      station: 'Postazione',
      yes: 'sì',
      no: 'no',
      empty: 'Nessuna fase: il ciclo del modello è vuoto.',
    },
    materials: { title: 'Materiali previsti', code: 'Materiale', name: 'Descrizione', colour: 'Colore', planned: 'Previsto', uom: 'U.M.', empty: 'Nessun materiale previsto.' },
    note: 'Nota',
    notFrozen: 'La specifica non è ancora congelata: fasi e materiali possono cambiare fino al rilascio.',
    fallback:
      'Copia cartacea di riserva: se il tablet non funziona, scrivete qui ciò che è stato fatto per ogni fase; viene registrato in Nexus appena il tablet torna. Il codice QR apre questo ordine sul tablet.',
    printed: (at: string) => `Stampato il ${at}`,
    page: 'Pagina {page} di {pages}',
    continued: 'segue',
    subject: (number: string) => `Foglio di lavorazione dell'ordine di produzione ${number}`,
  },
  en: {
    title: 'Work order traveller',
    batch: 'Batch',
    rush: 'RUSH',
    facts: {
      status: 'Status',
      style: 'Style',
      revision: 'Revision',
      site: 'Site',
      due: 'Due date',
      noDue: 'not set',
      priority: 'Priority',
      pieces: 'Pieces',
      colourways: 'Colourways',
      orders: 'Orders',
      splitFrom: 'Split from',
      released: 'Released',
    },
    banner: {
      DRAFT: 'DRAFT - not released yet: work starts only after the office releases it.',
      ON_HOLD: (reason: string | null) => `ON HOLD${reason ? `: ${reason}` : ''}. Do not start work.`,
      CANCELLED: 'CANCELLED: do not work on this order.',
      COMPLETED: 'COMPLETED: for reference only.',
      CLOSED: 'CLOSED: for reference only.',
    },
    sizes: { title: 'Size run', colourway: 'Colour', total: 'Total', empty: 'No sizes.' },
    operations: {
      title: 'Operations',
      seq: 'Op',
      code: 'Code',
      name: 'Operation',
      centre: 'Centre',
      minutes: 'Std min',
      scan: 'Scan',
      done: 'Done',
      scrap: 'Scrap',
      date: 'Date',
      station: 'Station',
      yes: 'yes',
      no: 'no',
      empty: "No operations: the style's routing is empty.",
    },
    materials: { title: 'Planned materials', code: 'Material', name: 'Description', colour: 'Colour', planned: 'Planned', uom: 'UoM', empty: 'No planned materials.' },
    note: 'Note',
    notFrozen: 'The specification is not frozen yet: operations and materials may change until the release.',
    fallback:
      'Paper fallback: when the tablet is down, write here what was done at each operation; it is recorded in Nexus as soon as the tablet is back. The QR code opens this work order on the tablet.',
    printed: (at: string) => `Printed ${at}`,
    page: 'Page {page} of {pages}',
    continued: 'continued',
    subject: (number: string) => `Traveller of work order ${number}`,
  },
} as const

export const TRAVELLER_WORDS = WORDS

/** The QR code's text: the work order's number, as the floor's scan looks it up. */
export const travellerQrText = (number: string): string => number.trim()

/** The banner of a work order the floor must not start (or that is over), or null for a released or started one. */
function bannerOf(facts: Pick<TravellerFacts, 'status' | 'holdReason'>, language: DocumentLanguage): string | null {
  const words = WORDS[language].banner
  switch (facts.status) {
    case 'DRAFT':
      return words.DRAFT
    case 'ON_HOLD':
      return words.ON_HOLD(facts.holdReason)
    case 'CANCELLED':
      return words.CANCELLED
    case 'COMPLETED':
      return words.COMPLETED
    case 'CLOSED':
      return words.CLOSED
    default:
      return null
  }
}

const pieces = (value: number, language: DocumentLanguage): string => formatDecimal(String(value), language)

/** The size run: one row per colourway, a column per size of the style (then any other size), totals. */
function sizeTable(facts: TravellerFacts, language: DocumentLanguage): TravellerTable {
  const words = WORDS[language].sizes
  const known = new Set(facts.sizes)
  const extra = [...new Set(facts.cells.map((cell) => cell.size).filter((size) => !known.has(size)))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const used = new Set(facts.cells.map((cell) => cell.size))
  const sizes = [...facts.sizes.filter((size) => used.has(size)), ...extra]
  const colourways = [...new Set(facts.cells.map((cell) => cell.colourway))].sort((a, b) => a.localeCompare(b))
  const quantity = (colourway: string, size: string) => facts.cells.filter((cell) => cell.colourway === colourway && cell.size === size).reduce((sum, cell) => sum + cell.quantity, 0)
  const width = sizes.length === 0 ? 0 : Math.floor(700 / (sizes.length + 1))
  const columns: TravellerColumn[] = [{ label: words.colourway, width: 1000 - width * (sizes.length + 1), align: 'left' }, ...sizes.map((size) => ({ label: size, width, align: 'right' as const })), { label: words.total, width, align: 'right' }]
  const rows = colourways.map((colourway) => {
    const counts = sizes.map((size) => quantity(colourway, size))
    return [colourway, ...counts.map((count) => (count === 0 ? '' : pieces(count, language))), pieces(counts.reduce((sum, count) => sum + count, 0), language)]
  })
  const totals = sizes.map((size) => facts.cells.filter((cell) => cell.size === size).reduce((sum, cell) => sum + cell.quantity, 0))
  const total = rows.length === 0 ? null : [words.total, ...totals.map((count) => pieces(count, language)), pieces(totals.reduce((sum, count) => sum + count, 0), language)]
  return { title: words.title, columns, rows, total, empty: words.empty }
}

function operationsTable(facts: TravellerFacts, language: DocumentLanguage): TravellerTable {
  const words = WORDS[language].operations
  return {
    title: words.title,
    columns: [
      { label: words.seq, width: 45, align: 'right' },
      { label: words.code, width: 110, align: 'left' },
      { label: words.name, width: 195, align: 'left' },
      { label: words.centre, width: 65, align: 'left' },
      { label: words.minutes, width: 70, align: 'right' },
      { label: words.scan, width: 65, align: 'center' },
      { label: words.done, width: 95, align: 'left' },
      { label: words.scrap, width: 85, align: 'left' },
      { label: words.date, width: 115, align: 'left' },
      { label: words.station, width: 155, align: 'left' },
    ],
    rows: facts.operations.map((op) => [String(op.seq), op.code, op.name, op.workCentre ?? '', formatDecimal(op.standardMinutes, language, 0, 2), op.scanRequired ? words.yes : words.no, '', '', '', '']),
    total: null,
    empty: words.empty,
  }
}

function materialsTable(facts: TravellerFacts, language: DocumentLanguage): TravellerTable {
  const words = WORDS[language].materials
  return {
    title: words.title,
    columns: [
      { label: words.code, width: 200, align: 'left' },
      { label: words.name, width: 380, align: 'left' },
      { label: words.colour, width: 140, align: 'left' },
      { label: words.planned, width: 170, align: 'right' },
      { label: words.uom, width: 110, align: 'left' },
    ],
    rows: facts.materials.map((material) => [material.code, material.name, material.colour ?? '', formatDecimal(material.planned, language, 0, 4), material.uom]),
    total: null,
    empty: words.empty,
  }
}

/** The traveller of one work order, in a language. */
export function travellerPaper(facts: TravellerFacts, language: DocumentLanguage): TravellerPaper {
  const words = WORDS[language]
  const total = facts.cells.reduce((sum, cell) => sum + cell.quantity, 0)
  const list: TravellerFact[] = [
    { label: words.facts.status, value: STATUS_WORDS[language][facts.status] },
    { label: words.facts.style, value: `${facts.style.code} · ${facts.style.name}` },
    { label: words.facts.revision, value: facts.revision === null ? '' : String(facts.revision) },
    { label: words.facts.site, value: `${facts.site.code} · ${facts.site.name}` },
    { label: words.facts.due, value: facts.dueDate ? formatDate(facts.dueDate, language) : words.facts.noDue },
    { label: words.facts.priority, value: String(facts.priority) },
    { label: words.facts.pieces, value: pieces(total, language) },
    { label: words.facts.colourways, value: [...new Set(facts.cells.map((cell) => cell.colourway))].sort((a, b) => a.localeCompare(b)).join(', ') },
    { label: words.facts.orders, value: facts.orders.join(', ') },
  ]
  if (facts.splitFrom) list.push({ label: words.facts.splitFrom, value: facts.splitFrom })
  if (facts.releasedAt) list.push({ label: words.facts.released, value: formatDateTime(facts.releasedAt, facts.timeZone, language) })
  const notes = [...(facts.note ? [`${words.note}: ${facts.note}`] : []), ...(facts.frozen ? [] : [words.notFrozen]), words.fallback]
  return {
    language,
    title: words.title,
    number: facts.number,
    qr: travellerQrText(facts.number),
    batch: facts.batchNumber ? `${words.batch} ${facts.batchNumber}` : null,
    rush: facts.rush ? words.rush : null,
    banner: bannerOf(facts, language),
    facts: list,
    tables: [sizeTable(facts, language), operationsTable(facts, language), materialsTable(facts, language)],
    notes,
    footer: { printed: words.printed(formatDateTime(facts.printedAt, facts.timeZone, language)), page: words.page, continued: words.continued },
    meta: { title: `${words.title} ${facts.number}`, subject: words.subject(facts.number), createdAt: facts.printedAt.toISOString() },
  }
}
