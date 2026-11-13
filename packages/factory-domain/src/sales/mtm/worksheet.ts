import { createHash } from 'node:crypto'
import { canonicalJson } from '../../accounting/manifest'
import type { BusinessDate } from '../../core/time'
import { formatDate } from '../../documents/format'
import type { DocumentLanguage } from '../../documents/model'
import type { EightDCompany, EightDReport, EightDSection, EightDTable } from '../../quality/capa/report'
import type { ReviewStatus } from './rules'

/**
 * The made-to-measure worksheet and order form (B-W2b-358; SAL-303; design sales.mtm new tab "MTM worksheet and order form (PDF)":
 * "Printed and signed at the fitting"), pure: one rider profile revision on A4, painted by the CAPA module's report renderer
 * (letterhead, facts, sections, legal footer). Facts: customer, rider, garment type, revision, when, who and where measured, base
 * size, the factory review. Sections: the measures in the template's order with an empty column to write a correction at the
 * fitting, the fit notes, the made-to-measure units made to this revision (the order form: quote or order, style, colourway, base
 * size; never a price), and the signatures. Never the office's internal note. A version per revision (GeneratedDocument
 * MTM_WORKSHEET 1, 2, …, an office file of the profile); its fingerprint is everything it prints but the day and the version.
 */

export const WORKSHEET_KIND = 'MTM_WORKSHEET' as const

export interface WorksheetPoint {
  readonly code: string
  readonly name: string
  /** As stored ("102.5"); null: not measured. */
  readonly value: string | null
  readonly unit: string
  /** The plausible range ("70–150 cm"); null: none. */
  readonly range: string | null
}

export interface WorksheetUnit {
  /** The quote's or the order's number. */
  readonly document: string
  readonly style: string
  readonly colourway: string
  readonly baseSize: string | null
  readonly status: string
}

export interface WorksheetInput {
  readonly language: DocumentLanguage
  /** The day it is made (not in the fingerprint). */
  readonly date: BusinessDate
  /** Its version (not in the fingerprint). */
  readonly version: number
  readonly company: EightDCompany
  readonly customer: string
  readonly rider: string
  readonly garment: { readonly code: string; readonly name: string }
  readonly revision: number
  readonly takenOn: BusinessDate
  readonly takenBy: string
  /** The office person of ours who measured (SAL-291); null: none recorded. */
  readonly measuredBy: string | null
  readonly measuredPlace: string | null
  readonly baseSize: string | null
  readonly review: { readonly status: ReviewStatus; readonly by: string | null; readonly on: BusinessDate | null; readonly note: string | null }
  readonly points: readonly WorksheetPoint[]
  readonly fitNotes: string | null
  readonly units: readonly WorksheetUnit[]
}

const WORDS = {
  it: {
    title: 'Scheda su misura e modulo d’ordine',
    file: 'scheda-su-misura',
    customer: 'Cliente',
    rider: 'Pilota',
    garment: 'Capo',
    revision: 'Revisione',
    taken: 'Misurato il',
    takenBy: 'Misurato da',
    measuredBy: 'Nostro addetto',
    place: 'Luogo',
    baseSize: 'Taglia base',
    review: 'Revisione di fabbrica',
    reviewed: (status: string, by: string | null, on: string | null) => [status, by, on].filter(Boolean).join(' · '),
    status: { WAITING: 'In attesa', CONFIRMED: 'Confermata', NEED_MORE: 'Servono altre misure' } as Record<ReviewStatus, string>,
    version: 'Versione',
    printed: 'Stampata il',
    measures: 'Misure',
    point: 'Punto',
    value: 'Misura',
    range: 'Intervallo plausibile',
    fitting: 'Correzione alla prova',
    notMeasured: 'non misurato',
    fit: 'Note di vestibilità',
    noFit: 'Nessuna nota.',
    units: 'Modulo d’ordine: capi su misura con questa revisione',
    noUnits: 'Nessun preventivo o ordine usa ancora questa revisione.',
    document: 'Preventivo / ordine',
    style: 'Modello',
    colourway: 'Colore',
    state: 'Stato',
    signatures: 'Firme',
    signRider: 'Firma del pilota o del rivenditore: ______________________________',
    signFitter: 'Firma dell’addetto: ______________________________',
    signDate: 'Data: ____________',
    reviewNote: (note: string) => `Note della revisione: ${note}`,
    page: (page: number, pages: number) => `Pagina ${page} di ${pages}`,
  },
  en: {
    title: 'Made-to-measure worksheet and order form',
    file: 'mtm-worksheet',
    customer: 'Customer',
    rider: 'Rider',
    garment: 'Garment',
    revision: 'Revision',
    taken: 'Measured on',
    takenBy: 'Measured by',
    measuredBy: 'Our fitter',
    place: 'Where',
    baseSize: 'Base size',
    review: 'Factory review',
    reviewed: (status: string, by: string | null, on: string | null) => [status, by, on].filter(Boolean).join(' · '),
    status: { WAITING: 'Waiting', CONFIRMED: 'Confirmed', NEED_MORE: 'More measures asked' } as Record<ReviewStatus, string>,
    version: 'Version',
    printed: 'Printed on',
    measures: 'Measures',
    point: 'Point',
    value: 'Measure',
    range: 'Plausible range',
    fitting: 'Correction at the fitting',
    notMeasured: 'not measured',
    fit: 'Fit notes',
    noFit: 'No notes.',
    units: 'Order form: made-to-measure units on this revision',
    noUnits: 'No quote or order uses this revision yet.',
    document: 'Quote / order',
    style: 'Style',
    colourway: 'Colourway',
    state: 'State',
    signatures: 'Signatures',
    signRider: "Rider's or dealer's signature: ______________________________",
    signFitter: "Fitter's signature: ______________________________",
    signDate: 'Date: ____________',
    reviewNote: (note: string) => `Review notes: ${note}`,
    page: (page: number, pages: number) => `Page ${page} of ${pages}`,
  },
} as const

const paragraphs = (text: string | null): string[] => (text ?? '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')

/** The worksheet as the report renderer paints it. */
export function worksheetReport(input: WorksheetInput): EightDReport {
  const w = WORDS[input.language]
  const day = (date: BusinessDate) => formatDate(date, input.language)
  const facts = [
    { label: w.customer, value: input.customer },
    { label: w.rider, value: input.rider },
    { label: w.garment, value: `${input.garment.name} (${input.garment.code})` },
    { label: w.revision, value: String(input.revision) },
    { label: w.taken, value: day(input.takenOn) },
    { label: w.takenBy, value: input.takenBy },
    ...(input.measuredBy ? [{ label: w.measuredBy, value: input.measuredBy }] : []),
    ...(input.measuredPlace ? [{ label: w.place, value: input.measuredPlace }] : []),
    { label: w.baseSize, value: input.baseSize ?? '-' },
    { label: w.review, value: w.reviewed(w.status[input.review.status], input.review.by, input.review.on ? day(input.review.on) : null) },
    { label: w.version, value: String(input.version) },
    { label: w.printed, value: day(input.date) },
  ]
  const measures: EightDTable = {
    columns: [
      { label: w.point, width: 0.34, align: 'left' },
      { label: w.value, width: 0.18, align: 'right' },
      { label: w.range, width: 0.2, align: 'left' },
      { label: w.fitting, width: 0.28, align: 'left' },
    ],
    rows: input.points.map((point) => [`${point.name} (${point.code})`, point.value === null ? w.notMeasured : `${point.value} ${point.unit}`, point.range ?? '-', '']),
  }
  const units: EightDTable | null =
    input.units.length === 0
      ? null
      : {
          columns: [
            { label: w.document, width: 0.26, align: 'left' },
            { label: w.style, width: 0.26, align: 'left' },
            { label: w.colourway, width: 0.16, align: 'left' },
            { label: w.baseSize, width: 0.12, align: 'left' },
            { label: w.state, width: 0.2, align: 'left' },
          ],
          rows: input.units.map((unit) => [unit.document, unit.style, unit.colourway, unit.baseSize ?? '-', unit.status]),
        }
  const fit = paragraphs(input.fitNotes)
  const review = input.review.note ? [w.reviewNote(input.review.note.replace(/\s+/g, ' ').trim())] : []
  const sections: EightDSection[] = [
    { heading: w.measures, lines: review, table: measures },
    { heading: w.fit, lines: fit.length === 0 ? [w.noFit] : fit, table: null },
    { heading: w.units, lines: units ? [] : [w.noUnits], table: units },
    { heading: w.signatures, lines: [w.signRider, w.signFitter, w.signDate], table: null },
  ]
  const number = worksheetNumber(input.garment.code, input.revision, input.version)
  return {
    language: input.language,
    meta: { title: `${w.title} ${number}`, subject: `${input.garment.code} r${input.revision}`, createdAt: `${input.date}T00:00:00.000Z` },
    title: w.title,
    sample: null,
    company: input.company,
    facts,
    sections,
    page: w.page,
    fileName: `${w.file}-${input.garment.code.toLowerCase()}-r${input.revision}-v${input.version}-${input.language}.pdf`,
  }
}

/** The number printed on a version ("JACKET r2 v1"): no rider's name in a document number. */
export const worksheetNumber = (garmentType: string, revision: number, version: number): string => `${garmentType} r${revision} v${version}`

/** The contents' fingerprint (SHA-256 hex): everything the worksheet prints but the day and the version. */
export function worksheetFingerprint(input: WorksheetInput): string {
  const { date: _date, version: _version, ...contents } = input
  return createHash('sha256').update(`mtm-worksheet/1 ${canonicalJson(contents)}`).digest('hex')
}
