import { partnerLocaleOf } from '../../threads/partner/rules'

/**
 * B-CP-072 (customer page plan C5, 12 §2 parts 2–4; D14): the files of a draft order in the portal — the customer's logos, its
 * references and its measurement sheets, on the draft or on one of its lines. Pure: apps/factory-api's
 * modules/sales/portal-ordering/draft-files.ts applies these rules; the files module holds the kinds and sizes, the outside-upload
 * gate (closed on staging and production until the virus scanner runs: the customer is told to send the file by e-mail) and the
 * measurement sheet's lock; the database the wall (a file shared outside reaches its record's own party only).
 *
 *   LOGO       filed as ARTWORK (what the factory prints or embroiders); vector prints best, a picture is never refused for it
 *   REFERENCE  a picture or a document of what they mean (no category)
 *   SHEET      a measurement sheet, filed as MEASUREMENTS: body data — in the office named and opened only with
 *              sales.measurements.view (else "Measurement sheet" behind a lock)
 *
 * At most DRAFT_FILES_MAX of the customer's files on one draft (its own and its lines' together). A brand PO is not a draft
 * part; the "This file shows prices" tick comes with B-CP-014's upload body.
 */

export const DRAFT_FILE_PARTS = ['LOGO', 'REFERENCE', 'SHEET'] as const
export type DraftFilePart = (typeof DRAFT_FILE_PARTS)[number]

/** The category a part is filed as (StoredFile.category; null: none). */
export const DRAFT_FILE_CATEGORY: Readonly<Record<DraftFilePart, 'ARTWORK' | 'MEASUREMENTS' | null>> = Object.freeze({ LOGO: 'ARTWORK', REFERENCE: null, SHEET: 'MEASUREMENTS' })

/** The part a stored file of a draft is, from its category (anything else is a reference). */
export function draftFilePartOf(category: string | null | undefined): DraftFilePart {
  if (category === 'ARTWORK') return 'LOGO'
  if (category === 'MEASUREMENTS') return 'SHEET'
  return 'REFERENCE'
}

/** The record types a draft's files sit on: the draft itself, or one of its lines. */
export const DRAFT_FILE_RECORDS = Object.freeze({ draft: 'PortalOrderRequest', line: 'PortalOrderRequestLine' } as const)

/** The most files the customer keeps on one draft (its own and its lines' together). */
export const DRAFT_FILES_MAX = 50

export const DRAFT_FILE_REFUSALS = ['TOO_MANY_FILES', /* od-ts t.6 */ 'SHEET_STAYS'] as const

/** od-ts t.6 (the "Logo" toggle on an attachment): the parts a draft's file moves between; a measurement sheet stays one (body data). */
export const MOVABLE_DRAFT_FILE_PARTS = ['LOGO', 'REFERENCE'] as const
export type MovableDraftFilePart = (typeof MOVABLE_DRAFT_FILE_PARTS)[number]
export type DraftFileRefusal = (typeof DRAFT_FILE_REFUSALS)[number]

/** The portal's words for a refused draft file ("voi"), Italian and English; never naming another customer. */
export const DRAFT_FILE_WORDS = Object.freeze({
  TOO_MANY_FILES: {
    it: 'Questa bozza ha già {max} file: toglietene uno o scriveteci nei messaggi per il resto.',
    en: 'This draft already holds {max} files: remove one, or write to us in the messages for the rest.',
  },
  // od-ts t.6: a measurement sheet is not moved to the logos or the references.
  SHEET_STAYS: {
    it: 'Una scheda misure resta una scheda misure: toglietela e aggiungete di nuovo il file come logo o riferimento.',
    en: 'A measurement sheet stays a measurement sheet: remove it and add the file again as a logo or a reference.',
  },
} satisfies Record<DraftFileRefusal, { readonly it: string; readonly en: string }>)

/** One of the words in the person's language. */
export function draftFileWords(word: DraftFileRefusal, locale: string | null | undefined): string {
  return DRAFT_FILE_WORDS[word][partnerLocaleOf(locale)].replaceAll('{max}', String(DRAFT_FILES_MAX))
}

export interface DraftFileFacts {
  readonly id: string
  readonly recordType: string
  readonly recordId: string
  readonly category: string | null
}

/** The draft's files by part (in the order given), each with the line it is on (null: the draft's own). */
export function draftFilesByPart<File extends DraftFileFacts>(files: readonly File[], requestId: string): Record<'logos' | 'references' | 'sheets', (File & { readonly lineId: string | null })[]> {
  const out = { logos: [] as (File & { lineId: string | null })[], references: [] as (File & { lineId: string | null })[], sheets: [] as (File & { lineId: string | null })[] }
  for (const file of files) {
    const lineId = file.recordType === DRAFT_FILE_RECORDS.line ? file.recordId : file.recordType === DRAFT_FILE_RECORDS.draft && file.recordId === requestId ? null : undefined
    if (lineId === undefined) continue
    const part = draftFilePartOf(file.category)
    out[part === 'LOGO' ? 'logos' : part === 'SHEET' ? 'sheets' : 'references'].push({ ...file, lineId })
  }
  return out
}
