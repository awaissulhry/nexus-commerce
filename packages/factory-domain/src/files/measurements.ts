/**
 * B-TH-083 (threads plan TH-7, gap N11; schema wave 6/9, B-TH-082): measurement sheets are body data, pure. A customer's
 * measurement sheet (a PDF, or a photo of one) is filed by a tick at upload — "This is a measurement sheet" — as
 * StoredFile.category MEASUREMENTS. From then on, in the office, only people holding sales.measurements.view open it (the
 * production manager holds it on purpose: the pattern department works from the sheets); everyone else sees a named lock,
 * "Measurement sheet — you cannot open it", never its name or its content, and gets 404 on the file itself. Every opening
 * (download, preview) is recorded. A portal or a link reads only its own party's sheets (row-level security and the
 * …_files_record_party_th_guards trigger: a sheet is shared only with its record's own party); a floor never (the database
 * refuses FLOOR on a sheet). Used by apps/factory-api's platform/files and the factory web.
 */

/** The category a ticked file gets. */
export const MEASUREMENT_SHEET_CATEGORY = 'MEASUREMENTS' as const

/** The permission that opens a sheet (sales/measure-link/permissions.ts SALES_MEASUREMENTS_VIEW). */
export const MEASUREMENT_SHEET_PERMISSION = 'sales.measurements.view' as const

/** The kinds a sheet may be filed as (the database's rule): a document, an attachment, or a photo of one. */
export const MEASUREMENT_SHEET_KINDS: readonly string[] = Object.freeze(['ATTACHMENT', 'DOCUMENT', 'PHOTO'])

/** Why a sheet cannot be filed this way, in the office's words (null: it can). */
export function measurementSheetProblem(input: { readonly kind: string; readonly visibility: readonly string[] }): string | null {
  if (!MEASUREMENT_SHEET_KINDS.includes(input.kind)) return 'A measurement sheet is a document, an attachment or a photo of one.'
  if (input.visibility.includes('FLOOR')) return 'A measurement sheet is body data: it is never shared with a floor.'
  return null
}

/** A file kept behind the measurement permission. */
export const isMeasurementSheet = (file: { readonly category?: string | null }): boolean => file.category === MEASUREMENT_SHEET_CATEGORY
